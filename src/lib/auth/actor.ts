import { cookies } from 'next/headers'
import { queryOne } from '@/lib/db'
import { getSession, IMPERSONATION_COOKIE_NAME } from './session'

// «Кто сейчас действует» — единая точка ответа на этот вопрос.
//
// Заменяет разбросанный по src/actions/* паттерн
//   getSession() → select role from employees where user_id = ...
// и приватный requireOwner() из src/actions/auth.ts.
//
// Два уровня, осознанно разной цены:
//
//   getSession() из ./session — ноль запросов, только подписанная cookie.
//     Так работает middleware. role там — снимок на момент входа.
//
//   getActor() ниже — один запрос, роль и права из БД. Для всего, что
//     действительно открывает доступ к данным. Владелец меняет роли в
//     рантайме, поэтому решение «пускать или нет» на снимке из cookie
//     принимать нельзя (db/AUTH_DESIGN.md §1).

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Уровни прав системных ролей — фолбэк, если роли нет в таблице roles. */
const SYSTEM_PERMISSION_LEVELS: Record<string, string> = {
  owner: 'owner',
  rop: 'department_head',
  mp: 'employee',
  lmai: 'employee',
  accountant: 'accountant',
}

export interface ImpersonationInfo {
  id: string
  name: string
  role: string
}

export interface Actor {
  /** users.id — всегда реальный вошедший пользователь, даже в impersonation */
  userId: string

  // ─── Действующее лицо: при impersonation это цель, иначе — сам пользователь.
  //     Именно эти поля определяют, какие данные показывать.
  employeeId: string | null
  role: string
  departmentId: string | null
  permissionLevel: string
  name: string | null
  email: string | null

  // ─── Настоящий пользователь. При impersonation отличается от полей выше.
  //     Права на привилегированные действия проверяются ТОЛЬКО по ним.
  realEmployeeId: string | null
  realRole: string

  /** Не null, когда owner работает от имени сотрудника. */
  impersonating: ImpersonationInfo | null
}

interface EmployeeRow {
  id: string
  department_id: string | null
  name: string
  email: string
  role: string
  permission_level: string | null
}

const EMPLOYEE_SELECT = `
  SELECT e.id,
         e.department_id,
         e.name,
         e.email,
         e.role,
         r.permission_level
    FROM public.employees e
    LEFT JOIN public.roles r
      ON r.name = e.role
     AND r.deleted_at IS NULL
   WHERE e.deleted_at IS NULL
`

function levelOf(row: EmployeeRow): string {
  return row.permission_level ?? SYSTEM_PERMISSION_LEVELS[row.role] ?? 'employee'
}

/**
 * Полный актор: роль, отдел и уровень прав читаются из БД, impersonation
 * разрешается. Возвращает null, если сессии нет или сотрудник удалён.
 */
export async function getActor(): Promise<Actor | null> {
  const session = await getSession()
  if (!session) return null

  const self = await queryOne<EmployeeRow>(
    `${EMPLOYEE_SELECT} AND e.user_id = $1 LIMIT 1`,
    [session.uid],
  )

  // Сессия валидна, но сотрудника нет (архивирован/отвязан) — доступа нет.
  if (!self) return null

  const base: Actor = {
    userId: session.uid,
    employeeId: self.id,
    role: self.role,
    departmentId: self.department_id,
    permissionLevel: levelOf(self),
    name: self.name,
    email: self.email,
    realEmployeeId: self.id,
    realRole: self.role,
    impersonating: null,
  }

  // Подменять личность может только owner — и роль для этой проверки берётся
  // из БД, а не из cookie.
  if (self.role !== 'owner') return base

  const target = await resolveImpersonationTarget()
  if (!target) return base

  return {
    ...base,
    employeeId: target.id,
    role: target.role,
    departmentId: target.department_id,
    permissionLevel: levelOf(target),
    name: target.name,
    email: target.email,
    impersonating: { id: target.id, name: target.name, role: target.role },
  }
}

/**
 * Читает cookie impersonate_as и подгружает сотрудника из БД.
 * Содержимому cookie не доверяем — там только UUID, всё остальное из базы.
 */
async function resolveImpersonationTarget(): Promise<EmployeeRow | null> {
  const jar = await cookies()
  const employeeId = jar.get(IMPERSONATION_COOKIE_NAME)?.value
  if (!employeeId || !UUID_RE.test(employeeId)) return null

  const target = await queryOne<EmployeeRow>(
    `${EMPLOYEE_SELECT} AND e.id = $1 LIMIT 1`,
    [employeeId],
  )

  // Несуществующий или удалённый сотрудник — просто игнорируем.
  // Чистит cookie stopImpersonation(); здесь этого делать нельзя, потому что
  // getActor() вызывается в том числе из Server Component, где запись cookie
  // запрещена.
  return target
}

/** Актор или исключение. Точка входа для Server Action. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor()
  if (!actor) throw new Error('Не авторизован')
  return actor
}

/**
 * true, если настоящий пользователь — владелец.
 *
 * Смотрит на realRole: owner, вошедший от имени менеджера, остаётся владельцем
 * и не должен терять права, а сотрудник не может получить их через подделанную
 * cookie impersonate_as.
 */
export async function isOwner(): Promise<boolean> {
  const actor = await getActor()
  return actor?.realRole === 'owner'
}
