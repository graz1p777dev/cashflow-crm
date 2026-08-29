'use server'

import { createHash, randomBytes } from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { query, queryOne, transaction } from '@/lib/db'
import { validatePassword } from '@/lib/auth-validation'
import { hashPassword, verifyPassword, burnTime } from '@/lib/auth/password'
import {
  createSession,
  destroySession,
  getSession,
  IMPERSONATION_COOKIE_NAME,
} from '@/lib/auth/session'
import { getActor, isOwner, UUID_RE, type ImpersonationInfo } from '@/lib/auth/actor'
import { notify } from '@/lib/notifications/notify'

export type ActionResult =
  | { success: true; mustChangePassword?: boolean }
  | { success: false; error: string }

// ─── Брутфорс-защита: in-memory счётчик попыток входа ────────────────────────
// Сбрасывается при рестарте сервера. Для multi-instance — заменить на Upstash Redis.

const loginAttempts = new Map<string, { failures: number; blockedUntil: number }>()
const MAX_FAILURES   = 5
const BLOCK_MS       = 15 * 60 * 1000 // 15 минут

// ─── signIn ───────────────────────────────────────────────────────────────────
// Проверяет пароль по users.password_hash и ставит подписанную cookie-сессию.
// Трекает неудачные попытки и блокирует аккаунт после MAX_FAILURES подряд.

interface SignInRow {
  user_id: string
  password_hash: string | null
  employee_id: string | null
  role: string | null
  must_change_password: boolean | null
}

export async function signIn(email: string, password: string): Promise<ActionResult> {
  const key = email.toLowerCase().trim()
  const now = Date.now()
  const record = loginAttempts.get(key)

  if (record && record.blockedUntil > now) {
    const minutes = Math.ceil((record.blockedUntil - now) / 60_000)
    return { success: false, error: `Слишком много попыток. Подождите ${minutes} мин.` }
  }

  const row = await queryOne<SignInRow>(
    `SELECT u.id            AS user_id,
            u.password_hash AS password_hash,
            e.id            AS employee_id,
            e.role          AS role,
            e.must_change_password
       FROM public.users u
       LEFT JOIN public.employees e
         ON e.user_id = u.id AND e.deleted_at IS NULL
      WHERE lower(u.email) = $1
      LIMIT 1`,
    [key],
  )

  // Пароль сверяем всегда — даже когда email неизвестен, иначе по времени
  // ответа можно отличить существующий адрес от несуществующего.
  const passwordOk = row
    ? await verifyPassword(password, row.password_hash)
    : await burnTime(password).then(() => false)

  if (!row || !passwordOk) {
    const failures = (record?.failures ?? 0) + 1
    if (failures >= MAX_FAILURES) {
      loginAttempts.set(key, { failures, blockedUntil: now + BLOCK_MS })
      console.warn(`[auth/signIn] locked: ${key} after ${failures} failures`)
      return {
        success: false,
        error: `Аккаунт заблокирован на 15 мин. из-за множества неудачных попыток.`,
      }
    }
    loginAttempts.set(key, { failures, blockedUntil: 0 })
    return { success: false, error: 'Неверный email или пароль' }
  }

  loginAttempts.delete(key)

  await createSession({
    uid:  row.user_id,
    eid:  row.employee_id,
    role: row.role ?? 'mp',
  })

  return { success: true, mustChangePassword: row.must_change_password === true }
}

// ─── signOut ──────────────────────────────────────────────────────────────────

export async function signOut(): Promise<ActionResult> {
  await destroySession()
  return { success: true }
}

// ─── Вспомогательная: получить origin из запроса ─────────────────────────────

async function getSiteOrigin(): Promise<string> {
  const hdrs = await headers()
  const host   = hdrs.get('host') ?? 'localhost:3000'
  const proto  = hdrs.get('x-forwarded-proto') ?? 'http'
  return `${proto}://${host}`
}

// Проверка «только owner» живёт в @/lib/auth/actor как isOwner(): смотрит на
// настоящую роль из БД, поэтому owner в режиме impersonation прав не теряет,
// а подделанная cookie impersonate_as прав не даёт.

// ─── Токены сброса пароля ─────────────────────────────────────────────────────
// В БД лежит только SHA-256 от токена: утечка таблицы не даёт рабочих ссылок.
// Токен высокоэнтропийный (32 случайных байта), поэтому растягивать его bcrypt
// незачем — а простой дайджест позволяет искать по индексу.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000 // 1 час

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ─── requestPasswordReset ─────────────────────────────────────────────────────
// Создаёт одноразовый токен со сроком жизни и возвращает ссылку для сброса.
// Доступно без авторизации (пользователь вышел или забыл пароль).

export type ResetRequestResult =
  | { success: true; resetUrl?: string }
  | { success: false; error: string }

export async function requestPasswordReset(email: string): Promise<ResetRequestResult> {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: 'Укажите корректный email' }
  }

  const user = await queryOne<{ id: string }>(
    'SELECT id FROM public.users WHERE lower(email) = $1 LIMIT 1',
    [email.toLowerCase().trim()],
  )

  // Не раскрываем, существует ли email — success в любом случае,
  // чтобы форму нельзя было использовать для перебора адресов.
  if (!user) return { success: true }

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS)

  // Прежние невыданные токены гасим: одна живая ссылка на пользователя.
  await transaction(async (client) => {
    await client.query(
      `UPDATE public.password_reset_tokens
          SET used_at = NOW()
        WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    )
    await client.query(
      `INSERT INTO public.password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, hashToken(token), expiresAt],
    )
  })

  const resetUrl = `${await getSiteOrigin()}/auth/reset-password?token=${token}`

  // TODO(email): транзакционного провайдера ещё нет — Supabase присылал письма
  // сам, замену (Resend / Postmark / SMTP) нужно выбрать и подключить
  // (db/AUTH_DESIGN.md §1, открытый вопрос 7). До тех пор ссылка возвращается
  // вызывающему коду, чтобы её можно было передать сотруднику вручную.
  //
  // Когда провайдер появится — отправлять письмо здесь и ПЕРЕСТАТЬ возвращать
  // resetUrl наружу: сейчас его получает тот, кто отправил форму, а значит
  // любой, кто знает чужой email, может запросить ссылку на него.
  console.warn(`[requestPasswordReset] нет отправки почты; ссылка: ${resetUrl}`)

  return { success: true, resetUrl }
}

// ─── confirmPasswordReset ─────────────────────────────────────────────────────
// Проверяет токен, меняет пароль и гасит токен. Авторизации не требует —
// доказательством личности служит сам токен.

export async function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<ActionResult> {
  if (!token) return { success: false, error: 'Ссылка недействительна. Запросите новую.' }

  const err = validatePassword(newPassword)
  if (err) return { success: false, error: err }

  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id
       FROM public.password_reset_tokens
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [hashToken(token)],
  )

  if (!row) {
    return { success: false, error: 'Ссылка недействительна или устарела. Запросите новую.' }
  }

  const hash = await hashPassword(newPassword)

  // Пароль и гашение токена — одной транзакцией: иначе при сбое между ними
  // ссылка осталась бы рабочей при уже сменённом пароле.
  await transaction(async (client) => {
    await client.query(
      'UPDATE public.users SET password_hash = $1 WHERE id = $2',
      [hash, row.user_id],
    )
    await client.query(
      'UPDATE public.password_reset_tokens SET used_at = NOW() WHERE id = $1',
      [row.id],
    )
    // Сброс пароля закрывает и принудительную смену: пароль уже новый.
    await client.query(
      'UPDATE public.employees SET must_change_password = false WHERE user_id = $1',
      [row.user_id],
    )
  })

  return { success: true }
}

// ─── createAuthUser ───────────────────────────────────────────────────────────
// Создаёт запись в public.users и привязывает её к сотруднику.
// Только owner. Используется из createEmployee.

export async function createAuthUser(
  email: string,
  password: string,
  employeeId: string,
): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }
  if (!UUID_RE.test(employeeId)) return { success: false, error: 'Некорректный идентификатор' }

  const pwErr = validatePassword(password)
  if (pwErr) return { success: false, error: pwErr }

  const normalized = email.toLowerCase().trim()

  try {
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM public.users WHERE lower(email) = $1 LIMIT 1',
      [normalized],
    )

    // Аккаунт уже есть — просто привязываем к сотруднику, пароль не трогаем.
    if (existing) {
      await query(
        'UPDATE public.employees SET user_id = $1 WHERE id = $2',
        [existing.id, employeeId],
      )
      return { success: true }
    }

    const hash = await hashPassword(password)

    // Вставка пользователя и привязка — одной транзакцией: осиротевший
    // users-ряд без сотрудника занял бы email и сломал повторную попытку.
    await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO public.users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [normalized, hash],
      )
      await client.query(
        'UPDATE public.employees SET user_id = $1 WHERE id = $2',
        [inserted.rows[0].id, employeeId],
      )
    })

    return { success: true }
  } catch (e) {
    console.error('[createAuthUser]', e instanceof Error ? e.message : e)
    return { success: false, error: 'Ошибка создания аккаунта' }
  }
}

// ─── deleteAuthUser ───────────────────────────────────────────────────────────
// Удаляет аккаунт при архивации сотрудника.
// employees.user_id — ON DELETE SET NULL, поэтому сама карточка сотрудника
// остаётся: история, зарплаты и логи на неё ссылаются.
// Только owner.

export async function deleteAuthUser(userId: string): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }
  if (!UUID_RE.test(userId)) return { success: false, error: 'Некорректный идентификатор' }

  try {
    await query('DELETE FROM public.users WHERE id = $1', [userId])
    return { success: true }
  } catch (e) {
    console.error('[deleteAuthUser]', e instanceof Error ? e.message : e)
    return { success: false, error: 'Ошибка удаления аккаунта' }
  }
}

// ─── changePasswordForce ──────────────────────────────────────────────────────
// Принудительная смена пароля при первом входе.
// Обновляет пароль и снимает флаг must_change_password.

export async function changePasswordForce(newPassword: string): Promise<ActionResult> {
  const err = validatePassword(newPassword)
  if (err) return { success: false, error: err }

  const session = await getSession()
  if (!session) return { success: false, error: 'Сессия недействительна. Войдите заново.' }

  const hash = await hashPassword(newPassword)

  let employeeName: string | null
  try {
    employeeName = await transaction(async (client) => {
      await client.query(
        'UPDATE public.users SET password_hash = $1 WHERE id = $2',
        [hash, session.uid],
      )
      const emp = await client.query<{ name: string }>(
        `UPDATE public.employees
            SET must_change_password = false
          WHERE user_id = $1
          RETURNING name`,
        [session.uid],
      )
      return emp.rows[0]?.name ?? null
    })
  } catch (e) {
    console.error('[changePasswordForce]', e instanceof Error ? e.message : e)
    return { success: false, error: 'Не удалось обновить пароль. Попробуйте ещё раз.' }
  }

  void notify({
    type: 'security',
    title: 'Пароль аккаунта изменён',
    body: employeeName ? `Сотрудник «${employeeName}» сменил пароль` : 'Пароль сотрудника изменён',
    isImportant: true,
  })

  return { success: true }
}

// ─── updateOwnProfile ──────────────────────────────────────────────────────────
// Пользователь редактирует свои контактные данные (имя, телефон, email).
// Не трогает users.email (вход в систему) — это отдельная сущность,
// требующая подтверждения по почте, а почтовый провайдер пока не подключён.

export type UpdateProfileResult =
  | { success: true; employee: { name: string; phone: string | null; email: string } }
  | { success: false; error: string }

export async function updateOwnProfile(fields: {
  name: string
  phone: string
  email: string
}): Promise<UpdateProfileResult> {
  const name = fields.name.trim()
  const phone = fields.phone.trim()
  const email = fields.email.trim()

  if (!name) return { success: false, error: 'Укажите имя' }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: 'Укажите корректный email' }
  }

  const session = await getSession()
  if (!session) return { success: false, error: 'Сессия недействительна. Войдите заново.' }

  try {
    await query(
      `UPDATE public.employees
          SET name = $1, phone = $2, email = $3
        WHERE user_id = $4`,
      [name, phone || null, email, session.uid],
    )
  } catch (e) {
    console.error('[updateOwnProfile]', e instanceof Error ? e.message : e)
    return { success: false, error: 'Не удалось сохранить изменения' }
  }

  return { success: true, employee: { name, phone: phone || null, email } }
}

// ─── changeOwnPassword ─────────────────────────────────────────────────────────
// Пользователь меняет свой пароль из профиля (не форс-флоу первого входа).

export async function changeOwnPassword(newPassword: string): Promise<ActionResult> {
  const err = validatePassword(newPassword)
  if (err) return { success: false, error: err }

  const session = await getSession()
  if (!session) return { success: false, error: 'Сессия недействительна. Войдите заново.' }

  const hash = await hashPassword(newPassword)

  try {
    await query(
      'UPDATE public.users SET password_hash = $1 WHERE id = $2',
      [hash, session.uid],
    )
  } catch (e) {
    console.error('[changeOwnPassword]', e instanceof Error ? e.message : e)
    return { success: false, error: 'Не удалось обновить пароль. Попробуйте ещё раз.' }
  }

  return { success: true }
}

// ─── getImpersonationState ────────────────────────────────────────────────────
// Читает cookie impersonate_as (httpOnly) на сервере.
// Возвращает данные сотрудника из БД — никогда не доверяет содержимому cookie.

export async function getImpersonationState(): Promise<ImpersonationInfo | null> {
  const actor = await getActor()
  return actor?.impersonating ?? null
}

// ─── startImpersonation ───────────────────────────────────────────────────────
// Владелец входит «от имени» сотрудника.
// Cookie хранит ТОЛЬКО UUID сотрудника. httpOnly: true — JS не может прочитать.

interface ImpersonationTargetRow {
  id: string
  name: string
  email: string
  role: string
}

export async function startImpersonation(employeeId: string): Promise<ActionResult> {
  if (!UUID_RE.test(employeeId)) return { success: false, error: 'Некорректный идентификатор' }

  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (actor.realRole !== 'owner') return { success: false, error: 'Недостаточно прав' }

  const target = await queryOne<ImpersonationTargetRow>(
    `SELECT id, name, email, role
       FROM public.employees
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [employeeId],
  )

  if (!target) return { success: false, error: 'Сотрудник не найден' }
  if (target.role === 'owner') return { success: false, error: 'Нельзя войти от имени владельца' }

  // Лог пишем ДО установки cookie и с await: раньше результат insert'а не
  // проверялся, а CHECK на audit_logs.action отвергал 'impersonation_start',
  // из-за чего записи молча терялись. Constraint расширен в
  // db/002_auth_phase2.sql, теперь запись действительно сохраняется.
  await query(
    `INSERT INTO public.audit_logs
       (employee_id, action, resource_type, resource_id, new_data)
     VALUES ($1, 'impersonation_start', 'employee', $2, $3)`,
    [
      actor.realEmployeeId,
      employeeId,
      JSON.stringify({
        target_name:  target.name,
        target_email: target.email,
        target_role:  target.role,
      }),
    ],
  )

  const jar = await cookies()
  jar.set(IMPERSONATION_COOKIE_NAME, employeeId, {
    path:     '/',
    sameSite: 'strict',
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   60 * 60 * 4,
  })

  return { success: true }
}

// ─── stopImpersonation ────────────────────────────────────────────────────────

export async function stopImpersonation(): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  if (actor.realRole !== 'owner') return { success: false, error: 'Недостаточно прав' }

  const jar = await cookies()
  const employeeId = jar.get(IMPERSONATION_COOKIE_NAME)?.value

  if (employeeId && UUID_RE.test(employeeId)) {
    const target = await queryOne<{ name: string; role: string }>(
      'SELECT name, role FROM public.employees WHERE id = $1 LIMIT 1',
      [employeeId],
    )

    await query(
      `INSERT INTO public.audit_logs
         (employee_id, action, resource_type, resource_id, new_data)
       VALUES ($1, 'impersonation_end', 'employee', $2, $3)`,
      [
        actor.realEmployeeId,
        employeeId,
        JSON.stringify(target ? { target_name: target.name, target_role: target.role } : {}),
      ],
    )
  }

  jar.delete(IMPERSONATION_COOKIE_NAME)
  return { success: true }
}
