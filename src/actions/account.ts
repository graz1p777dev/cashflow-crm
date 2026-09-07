'use server'

import { queryOne, transaction } from '@/lib/db'
import { getSession, destroySession } from '@/lib/auth/session'
import { verifyPassword } from '@/lib/auth/password'

export type DeleteAccountResult = { success: true } | { success: false; error: string }

const DELETE_CONFIRMATION = 'my time has come'

interface EmployeeRow {
  id: string
  role: string
  deleted_at: string | null
  status: string
}

export async function deleteOwnAccount(password: string, confirmation: string): Promise<DeleteAccountResult> {
  if (confirmation !== DELETE_CONFIRMATION) return { success: false, error: 'Введите фразу подтверждения полностью и вручную.' }
  if (!password) return { success: false, error: 'Введите текущий пароль.' }

  const session = await getSession()
  if (!session) return { success: false, error: 'Сессия недействительна. Войдите заново.' }

  // Повторная авторизация не позволяет удалить аккаунт, зная только открытую сессию.
  const user = await queryOne<{ password_hash: string | null }>(
    'SELECT password_hash FROM public.users WHERE id = $1 LIMIT 1',
    [session.uid],
  )
  const passwordOk = await verifyPassword(password, user?.password_hash)
  if (!user || !passwordOk) return { success: false, error: 'Текущий пароль неверный.' }

  const employee = await queryOne<EmployeeRow>(
    'SELECT id, role, deleted_at, status FROM public.employees WHERE user_id = $1 LIMIT 1',
    [session.uid],
  )
  if (!employee || employee.deleted_at) return { success: false, error: 'Профиль сотрудника не найден.' }

  if (employee.role === 'owner') {
    const owners = await queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM public.employees WHERE role = 'owner' AND deleted_at IS NULL`,
    )
    const count = owners ? Number(owners.count) : 0
    if (count < 2) return { success: false, error: 'Нельзя удалить последнего владельца. Сначала назначьте другого владельца.' }
  }

  // Операционная история остаётся в базе: профиль архивируется, auth-аккаунт удаляется.
  // Обе операции — одной транзакцией: сбой удаления откатывает архивацию,
  // так что отдельного ручного восстановления, как раньше, не требуется.
  try {
    await transaction(async (client) => {
      await client.query(
        `UPDATE public.employees SET deleted_at = NOW(), status = 'archived' WHERE id = $1`,
        [employee.id],
      )
      await client.query('DELETE FROM public.users WHERE id = $1', [session.uid])
    })
  } catch (e) {
    console.error('[deleteOwnAccount]', e instanceof Error ? e.message : e)
    return { success: false, error: 'Не удалось удалить аккаунт. Профиль восстановлен.' }
  }

  await destroySession()
  return { success: true }
}
