'use server'

// Уведомления (012_notifications.sql, расширены в 031).
//
// ─── Про видимость ───────────────────────────────────────────────────────────
// Раньше запросы шли без единого фильтра по сотруднику: строки отбирала RLS.
// Действующее правило — объединение permissive-политик 012:
//   notifications_select_self  — свои (employee_id = мой)
//   notifications_select_owner — владелец видит все
// то есть «свои ИЛИ я владелец». То же самое на UPDATE (…_update_read_self /
// …_update_owner). Политики из 025 (…_employee_perm) добавляют ровно то же
// «свои» через permission_level и на итог не влияют.
//
// RLS вместе с Supabase ушла (db/schema.sql, DECISION 1), поэтому фильтр
// перенесён в сами запросы. Без него любой сотрудник читал бы чужие
// уведомления и отмечал их прочитанными.

import { revalidatePath } from 'next/cache'
import { query, queryOne } from '@/lib/db'
import { getActor } from '@/lib/auth/actor'
import type { Notification } from '@/types'

export type ActionResult = { success: true } | { success: false; error: string }

/**
 * Условие «эта строка моя, либо я владелец» для WHERE.
 * $1 — employees.id действующего лица, $2 — его роль.
 */
const VISIBLE = `(n.employee_id = $1 OR $2 = 'owner')`

export async function getNotifications(filter: 'all' | 'important' = 'all'): Promise<Notification[]> {
  const actor = await getActor()
  if (!actor) return []

  return query<Notification>(
    `SELECT n.*
       FROM public.notifications n
      WHERE ${VISIBLE}
        AND ($3::boolean IS FALSE OR n.is_important = TRUE)
      ORDER BY n.created_at DESC
      LIMIT 100`,
    [actor.employeeId, actor.role, filter === 'important'],
  )
}

/** Счётчик для колокольчика в Topbar — Topbar поллит эту функцию вместо
 * Supabase Realtime-подписки на INSERT в notifications. */
export async function getUnreadNotificationsCount(): Promise<number> {
  const actor = await getActor()
  if (!actor) return 0

  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM public.notifications n
      WHERE n.is_read = FALSE AND ${VISIBLE}`,
    [actor.employeeId, actor.role],
  )
  return row ? Number(row.count) : 0
}

export async function markNotificationRead(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Нет доступа' }

  try {
    await query(
      `UPDATE public.notifications AS n
          SET is_read = TRUE
        WHERE n.id = $3 AND ${VISIBLE}`,
      [actor.employeeId, actor.role, id],
    )
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось обновить' }
  }

  revalidatePath('/dashboard/notifications')
  return { success: true }
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Нет доступа' }

  try {
    await query(
      `UPDATE public.notifications AS n
          SET is_read = TRUE
        WHERE n.is_read = FALSE AND ${VISIBLE}`,
      [actor.employeeId, actor.role],
    )
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось обновить' }
  }

  revalidatePath('/dashboard/notifications')
  return { success: true }
}
