// ─── notify() ──────────────────────────────────────────────────────────────
// Единая точка записи в public.notifications. Вызывается и из Server Actions/
// Route Handlers этого приложения (смена пароля, нагрузка сервера), и из
// внешних систем через POST /api/internal/notify (бот, деплой-скрипт).
//
// Никогда не бросает исключение наружу — уведомление не должно ронять
// основной поток (смену пароля, ответ API статуса сервера и т.д.).

import { query } from '@/lib/db'

export type NotificationType =
  | 'kpi_alert'
  | 'kpi_success'
  | 'plan_100'
  | 'absence'
  | 'salary_ready'
  | 'finance_alert'
  | 'system'
  | 'sale'
  | 'consultation_booked'
  | 'consultation_reminder'
  | 'sale_lead'
  | 'server_load'
  | 'deploy'
  | 'security'
  | 'audit'
  | 'game_booking'
  | 'bot_message'

export interface NotifyInput {
  type: NotificationType
  title: string
  body?: string
  actionUrl?: string
  isImportant?: boolean
  sourceType?: string
  sourceId?: string
  /** Если не задано — уходит всем сотрудникам с ролью owner. */
  employeeIds?: string[]
}

export async function notify(input: NotifyInput): Promise<void> {
  try {
    let employeeIds = input.employeeIds
    if (!employeeIds) {
      // Как и раньше: адресатов не задали — уходит всем владельцам.
      // deleted_at не фильтруем намеренно, чтобы не менять поведение:
      // старый запрос тоже брал всех с role = 'owner'.
      const owners = await query<{ id: string }>(
        `SELECT id FROM public.employees WHERE role = 'owner'`,
      )
      employeeIds = owners.map((e) => e.id)
    }
    if (employeeIds.length === 0) return

    // Одна вставка на всех адресатов вместо N: unnest разворачивает массив
    // employee_id в строки, остальные значения повторяются.
    await query(
      `INSERT INTO public.notifications
         (employee_id, type, title, body, action_url, is_important, source_type, source_id)
       SELECT employee_id, $2, $3, $4, $5, $6, $7, $8
         FROM unnest($1::uuid[]) AS employee_id`,
      [
        employeeIds,
        input.type,
        input.title,
        input.body ?? null,
        input.actionUrl ?? null,
        input.isImportant ?? false,
        input.sourceType ?? null,
        input.sourceId ?? null,
      ],
    )
  } catch (err) {
    console.error('[notify] failed to insert notification:', err)
  }
}
