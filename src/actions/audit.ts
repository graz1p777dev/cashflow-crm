'use server'

import { query } from '@/lib/db'
import { getActor } from '@/lib/auth/actor'
import type { AuditAction, AuditRow } from '@/lib/audit-format'

// audit_logs (миграция 015) — append-only лог изменений. Триггер
// notify_from_audit_log (миграция 031) сам создаёт уведомление на каждую запись
// create/update/delete, поэтому здесь достаточно просто записать факт.

/**
 * Записывает изменение в audit_logs. Никогда не бросает: сбой аудита не должен
 * ломать саму мутацию, ради которой он вызван. Человекочитаемый текст кладём в
 * new_data.summary — в таблице нет отдельной колонки под заголовок.
 */
export async function recordAudit(input: {
  action: AuditAction
  resourceType: string
  resourceId?: string | null
  summary: string
}): Promise<void> {
  try {
    const actor = await getActor()
    if (!actor) return

    // Автором записи считается НАСТОЯЩИЙ пользователь, а не тот, от чьего
    // имени работает владелец: смысл журнала в том, кто на самом деле нажал.
    // Прежний код брал сотрудника по auth.getUser() и приходил к тому же —
    // impersonation он попросту не видел.
    await query(
      `INSERT INTO public.audit_logs
         (employee_id, action, resource_type, resource_id, new_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        actor.realEmployeeId,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        JSON.stringify({ summary: input.summary }),
      ],
    )
  } catch (e) {
    console.error('[recordAudit]', e)
  }
}

/**
 * Последние изменения для панели «Последние действия».
 *
 * Раньше строки отбирала RLS-политика audit_logs_select_owner: журнал видел
 * только владелец, у остальных ролей список приходил пустым. RLS вместе с
 * Supabase ушла (db/schema.sql, DECISION 1), поэтому та же проверка сделана
 * здесь явно — иначе журнал изменений открылся бы всем сотрудникам.
 *
 * Проверяется realRole: владелец в режиме impersonation журнал не теряет,
 * а сотрудник не получает его через подделанную cookie.
 */
export async function getAuditLog(limit = 15): Promise<AuditRow[]> {
  const actor = await getActor()
  if (actor?.realRole !== 'owner') return []

  try {
    const rows = await query<{
      id: string
      action: AuditAction
      resource_type: string
      new_data: { summary?: string } | null
      created_at: string
      employee_name: string | null
    }>(
      `SELECT a.id,
              a.action,
              a.resource_type,
              a.new_data,
              a.created_at,
              e.name AS employee_name
         FROM public.audit_logs a
         LEFT JOIN public.employees e ON e.id = a.employee_id
        WHERE a.action IN ('create', 'update', 'delete')
        ORDER BY a.created_at DESC
        LIMIT $1`,
      [limit],
    )

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      resourceType: row.resource_type,
      summary: row.new_data?.summary ?? '',
      employeeName: row.employee_name,
      createdAt: row.created_at,
    }))
  } catch (e) {
    // Прежняя версия на ошибке молча отдавала пустой список — сохраняем.
    console.error('[getAuditLog]', e)
    return []
  }
}
