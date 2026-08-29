import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'

// Подписанная cookie-сессия. Заменяет GoTrue-сессию Supabase.
//
// Формат:  base64url(JSON payload) "." hex(HMAC-SHA256(payload, SESSION_SECRET))
//
// ENV:
//   SESSION_SECRET — ключ HMAC, минимум 32 байта.
//     Сгенерировать: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//     Значения в репозитории нет намеренно: секрет задаётся в окружении
//     (переменные сервиса Railway / .env.local), иначе подписи предсказуемы.
//     Небезопасного dev-фолбэка тоже нет — падаем сразу, а не тихо работаем
//     на общеизвестном ключе.

export const SESSION_COOKIE_NAME = 'cf_session'
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 дней

/** Отдельная httpOnly cookie для impersonation — хранит только UUID сотрудника. */
export const IMPERSONATION_COOKIE_NAME = 'impersonate_as'

/**
 * Полезная нагрузка сессии.
 *
 * eid и role лежат в токене намеренно: почти каждый Server Action начинался с
 * getSession() + запроса employees.role, и здесь эта пара уже под рукой —
 * в частности middleware может увести кассира без обращения к БД.
 *
 * Цена решения — роль в токене живёт до истечения срока, а владелец может
 * поменять её в рантайме (db/AUTH_DESIGN.md §1 предостерегает именно об этом).
 * Поэтому role здесь — снимок для дешёвых проверок и редиректов, а всё, что
 * реально открывает доступ к данным, обязано брать роль из БД:
 * getActor({ fresh: true }) в src/lib/auth/actor.ts.
 */
export interface SessionPayload {
  /** users.id */
  uid: string
  /** employees.id; null, если сотрудник ещё не привязан к аккаунту */
  eid: string | null
  /** employees.role на момент входа — снимок, не источник истины */
  role: string
  /** issued at, секунды unix */
  iat: number
  /** expires at, секунды unix */
  exp: number
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET не задан или короче 32 символов. Сгенерируйте: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  }
  return secret
}

function sign(value: string): string {
  return createHmac('sha256', getSecret()).update(value).digest('hex')
}

/** Собирает и подписывает значение cookie. */
export function encodeSession(payload: SessionPayload): string {
  const json = JSON.stringify(payload)
  const encoded = Buffer.from(json, 'utf-8').toString('base64url')
  return `${encoded}.${sign(encoded)}`
}

/**
 * Проверяет подпись и срок. Возвращает payload или null.
 *
 * Чистая функция без cookies() — поэтому её же вызывает middleware,
 * где доступа к серверному cookie-jar нет.
 */
export function decodeSession(cookieValue: string | undefined): SessionPayload | null {
  if (!cookieValue) return null

  const separator = cookieValue.lastIndexOf('.')
  if (separator <= 0) return null

  const encoded = cookieValue.slice(0, separator)
  const signature = cookieValue.slice(separator + 1)
  if (!encoded || !signature) return null

  // Сравнение подписи — timingSafeEqual, чтобы не сливать байты ключа по времени.
  const expected = sign(encoded)
  const given = Buffer.from(signature, 'utf-8')
  const want = Buffer.from(expected, 'utf-8')
  if (given.length !== want.length) return null
  if (!timingSafeEqual(given, want)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>

  if (typeof p.uid !== 'string' || typeof p.role !== 'string') return null
  if (typeof p.iat !== 'number' || typeof p.exp !== 'number') return null
  if (p.eid !== null && typeof p.eid !== 'string') return null

  // Срок проверяем всегда. bot-admin-panel этого не делает — единственное,
  // что из него сюда переносить не следовало.
  if (p.exp <= Math.floor(Date.now() / 1000)) return null

  return { uid: p.uid, eid: p.eid, role: p.role, iat: p.iat, exp: p.exp }
}

/**
 * Ставит cookie сессии.
 * Только из Server Action или Route Handler — Server Component писать cookie не может.
 */
export async function createSession(
  input: Pick<SessionPayload, 'uid' | 'eid' | 'role'>,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const payload: SessionPayload = {
    ...input,
    iat: now,
    exp: now + SESSION_MAX_AGE_SECONDS,
  }

  const jar = await cookies()
  jar.set(SESSION_COOKIE_NAME, encodeSession(payload), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}

/** Читает и проверяет сессию на сервере. Безопасно вызывать из Server Component. */
export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies()
  return decodeSession(jar.get(SESSION_COOKIE_NAME)?.value)
}

/**
 * Удаляет cookie сессии и impersonation.
 * Только из Server Action или Route Handler.
 */
export async function destroySession(): Promise<void> {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE_NAME)
  // Выход owner'а не должен оставлять «хвост» impersonation следующей сессии.
  jar.delete(IMPERSONATION_COOKIE_NAME)
}
