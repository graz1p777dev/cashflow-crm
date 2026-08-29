// Продвижение сделки по воронке по сигналам Telegram-бота Cashflow.
//
// Бот (bot/cashflow_bot/crm.py, push_stage) на ключевых шагах записи шлёт
// PATCH /api/internal/deals с action. Здесь action превращается в конкретный
// deal_stages.id.
//
// status и deal_events заполняет БД-триггер
// (trg_deals_sync_stage_state / trg_deals_log_stage_change,
// supabase/migrations/036_deals.sql) — здесь их не трогаем. Сумму и состав
// брони сделке не проставляем: это отдельная таблица game_bookings.

import { query, queryOne } from '@/lib/db'

/** action → название этапа (supabase/migrations/036_deals.sql). */
const ACTION_STAGE_NAME: Record<string, string> = {
  started: 'Начал запись',
  contact: 'Оставил контакты',
  booked: 'Записан на игру',
  confirmed: 'Подтвердил участие',
  attended: 'Пришёл на игру',
  no_show: 'Не пришёл',
}

// no_show — не шаг воронки вперёд, а фиксация того, что человек не дошёл:
// случиться это может на любом этапе, поэтому правило «только вперёд»
// для него не применяется.
const BYPASS_FORWARD_ONLY = new Set(['no_show'])

export interface AdvanceDealResult {
  ok: boolean
  id?: string
  skipped?: 'not_found' | 'terminal' | 'unknown_action' | 'no_change'
  error?: string
}

export async function advanceDealFromBotAction(
  externalKey: string,
  action: string
): Promise<AdvanceDealResult> {
  const targetStageName = ACTION_STAGE_NAME[action]
  if (!targetStageName) return { ok: false, skipped: 'unknown_action' }

  const key = externalKey.trim()
  if (!key) return { ok: false, error: 'externalKey пустой' }

  try {
    const deal = await queryOne<{ id: string; stage_id: string; status: string }>(
      `SELECT id, stage_id, status
         FROM public.deals
        WHERE external_key = $1
          AND deleted_at IS NULL
        LIMIT 1`,
      [key],
    )
    if (!deal) return { ok: false, skipped: 'not_found' }

    // Сделку, которую менеджер уже закрыл (выиграна/потеряна), бот не трогает.
    if (deal.status !== 'open') return { ok: true, skipped: 'terminal' }

    const currentStage = await queryOne<{ sort_order: number }>(
      'SELECT sort_order FROM public.deal_stages WHERE id = $1 LIMIT 1',
      [deal.stage_id],
    )

    const target = await queryOne<{ id: string; sort_order: number }>(
      'SELECT id, sort_order FROM public.deal_stages WHERE name = $1 LIMIT 1',
      [targetStageName],
    )
    if (!target) return { ok: false, error: `Этап "${targetStageName}" не найден` }

    // Воронка двигается только вперёд — повторное распознанное намерение
    // (например клиент второй раз спросил про товар) не откатывает сделку.
    // Исключение — no_show (см. BYPASS_FORWARD_ONLY выше).
    if (
      !BYPASS_FORWARD_ONLY.has(action) &&
      currentStage &&
      target.sort_order <= currentStage.sort_order
    ) {
      return { ok: true, id: deal.id, skipped: 'no_change' }
    }

    await query('UPDATE public.deals SET stage_id = $1 WHERE id = $2', [target.id, deal.id])

    return { ok: true, id: deal.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
