'use server'

// Воронка продаж (036_deals.sql). Сделки заводятся сами, когда человек
// записывается на игру через Telegram-бота (src/lib/deals/auto-create.ts),
// либо вручную из доски.
//
// ─── Про видимость сделок ────────────────────────────────────────────────────
// Раньше «какие сделки видны» решала RLS-политика deals_select через
// can_see_deal(). RLS вместе с Supabase ушла (db/schema.sql, DECISION 1), но
// сам предикат Phase 1 сохранила как обычную SQL-функцию с явным параметром:
//   can_see_deal(p_user_id UUID, d_responsible UUID)
// Поэтому здесь он подставляется в WHERE — правило видимости остаётся ровно
// тем же и продолжает жить в одном месте, а не переписывается на TypeScript.
//
// Тот же предикат стоит и в UPDATE: под RLS политика deals_update отсекала
// чужие сделки, и запрос возвращал ноль строк — отсюда ответ «Сделка
// недоступна» / «Недостаточно прав». Без него любой сотрудник мог бы
// отредактировать чужую сделку по прямому id.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { query, queryOne } from '@/lib/db'
import { getActor } from '@/lib/auth/actor'
import type {
  Deal,
  DealEmployee,
  DealMessage,
  DealSource,
  DealStage,
  DealViewer,
} from '@/types'

export type DealActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string }

// ─── Текущий сотрудник ───────────────────────────────────────────────────────

interface Viewer extends DealViewer {
  /** users.id — нужен как аргумент can_see_deal(). */
  userId: string
}

/**
 * Заменяет прежнюю пару getSession() + SELECT role FROM employees.
 *
 * Отличие в поведении, осознанное: getActor() учитывает impersonation, а
 * прежний код смотрел только на user_id из сессии. То есть владелец, вошедший
 * «от имени» менеджера, теперь видит доску глазами этого менеджера — ровно
 * то, ради чего impersonation и существует.
 */
async function getViewer(): Promise<Viewer | null> {
  const actor = await getActor()
  if (!actor || !actor.employeeId) return null
  return {
    id: actor.employeeId,
    role: actor.role as DealViewer['role'],
    name: actor.name ?? '',
    userId: actor.userId,
  }
}

// can_see_deal() принимает users.id, а при impersonation действующее лицо —
// другой сотрудник. Поэтому в предикат уходит user_id того, чьими глазами
// смотрим, а не настоящего пользователя.
const VIEWER_USER_ID = `(SELECT e.user_id FROM public.employees e WHERE e.id = $1)`

// ─── Данные для доски ────────────────────────────────────────────────────────

export interface DealsData {
  stages: DealStage[]
  deals: Deal[]
  employees: DealEmployee[]
  me: DealViewer | null
}

export async function getDealsData(): Promise<DealsData> {
  const me = await getViewer()
  if (!me) return { stages: [], deals: [], employees: [], me: null }

  // Три независимых запроса — параллельно, как и было.
  const [stages, deals, employees] = await Promise.all([
    // Этапы — справочник, их видели все вошедшие (deal_stages_select USING TRUE).
    query<DealStage>(
      `SELECT id, name, sort_order, kind, color, is_default, description
         FROM public.deal_stages
        ORDER BY sort_order`,
    ),
    query<Deal>(
      `SELECT d.*
         FROM public.deals d
        WHERE d.deleted_at IS NULL
          AND public.can_see_deal(${VIEWER_USER_ID}, d.responsible_employee_id)
        ORDER BY d.created_at DESC`,
      [me.id],
    ),
    // Имена всех сотрудников — для пикера ответственного. Под Supabase это
    // шло через service-role клиент в обход RLS; отдельного клиента больше
    // нет, ограничения — тоже, так что это просто запрос.
    query<DealEmployee>(
      `SELECT id, name, avatar_url
         FROM public.employees
        WHERE deleted_at IS NULL
        ORDER BY name`,
    ),
  ])

  return { stages, deals, employees, me }
}

// ─── Форма сделки ────────────────────────────────────────────────────────────

const DealSchema = z.object({
  title: z.string().trim().min(1, 'Введите название сделки').max(300, 'Слишком длинное название'),
  stage_id: z.string().uuid('Выберите этап'),
  amount: z.number().nonnegative('Сумма не может быть отрицательной').nullable().optional(),
  currency: z.enum(['KGS', 'USD', 'RUB']).default('KGS'),
  customer_name: z.string().nullable().optional(),
  customer_phone: z.string().nullable().optional(),
  customer_username: z.string().nullable().optional(),
  city: z.string().max(120, 'Слишком длинное название города').nullable().optional(),
  address: z.string().max(500, 'Слишком длинный адрес').nullable().optional(),
  responsible_employee_id: z.string().uuid().nullable().optional(),
  note: z.string().nullable().optional(),
})

export type DealFormData = z.input<typeof DealSchema>

const clean = (value: string | null | undefined) => value?.trim() || null

export async function createDeal(input: DealFormData): Promise<DealActionResult<{ id: string }>> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const parsed = DealSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const d = parsed.data

  try {
    const created = await queryOne<{ id: string }>(
      `INSERT INTO public.deals
         (title, stage_id, amount, currency, customer_name, customer_phone,
          customer_username, city, address, source, responsible_employee_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        d.title,
        d.stage_id,
        d.amount ?? null,
        d.currency,
        clean(d.customer_name),
        clean(d.customer_phone),
        clean(d.customer_username),
        clean(d.city),
        clean(d.address),
        'manual' satisfies DealSource,
        d.responsible_employee_id ?? null,
        clean(d.note),
      ],
    )
    if (!created) return { success: false, error: 'Не удалось создать сделку' }

    revalidatePath('/dashboard/deals')
    return { success: true, data: { id: created.id } }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось создать сделку' }
  }
}

export async function updateDeal(id: string, input: DealFormData): Promise<DealActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const parsed = DealSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const d = parsed.data

  try {
    // status и stage_changed_at проставляет триггер БД — здесь их не трогаем.
    const updated = await query<{ id: string }>(
      `UPDATE public.deals AS t
          SET title = $3,
              stage_id = $4,
              amount = $5,
              currency = $6,
              customer_name = $7,
              customer_phone = $8,
              customer_username = $9,
              city = $10,
              address = $11,
              responsible_employee_id = $12,
              note = $13
        WHERE t.id = $2
          AND t.deleted_at IS NULL
          AND public.can_see_deal(${VIEWER_USER_ID}, t.responsible_employee_id)
        RETURNING t.id`,
      [
        me.id,
        id,
        d.title,
        d.stage_id,
        d.amount ?? null,
        d.currency,
        clean(d.customer_name),
        clean(d.customer_phone),
        clean(d.customer_username),
        clean(d.city),
        clean(d.address),
        d.responsible_employee_id ?? null,
        clean(d.note),
      ],
    )

    if (updated.length === 0) return { success: false, error: 'Сделка недоступна' }

    revalidatePath('/dashboard/deals')
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось сохранить сделку' }
  }
}

/** Перенос карточки между колонками. deal_events пишет триггер БД. */
export async function moveDeal(dealId: string, stageId: string): Promise<DealActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  try {
    const moved = await query<{ id: string }>(
      `UPDATE public.deals AS t
          SET stage_id = $3
        WHERE t.id = $2
          AND t.deleted_at IS NULL
          AND public.can_see_deal(${VIEWER_USER_ID}, t.responsible_employee_id)
        RETURNING t.id`,
      [me.id, dealId, stageId],
    )
    if (moved.length === 0) return { success: false, error: 'Недостаточно прав' }

    revalidatePath('/dashboard/deals')
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось перенести сделку' }
  }
}

/** Мягкое удаление — история переходов в deal_events остаётся. */
export async function deleteDeal(id: string): Promise<DealActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  try {
    const deleted = await query<{ id: string }>(
      `UPDATE public.deals AS t
          SET deleted_at = NOW()
        WHERE t.id = $2
          AND t.deleted_at IS NULL
          AND public.can_see_deal(${VIEWER_USER_ID}, t.responsible_employee_id)
        RETURNING t.id`,
      [me.id, id],
    )
    if (deleted.length === 0) return { success: false, error: 'Сделка недоступна' }

    revalidatePath('/dashboard/deals')
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось удалить сделку' }
  }
}


// ─── Переписка по сделке ─────────────────────────────────────────────────────

export interface DealConversation {
  messages: DealMessage[]
  /** Почему переписки нет — показываем вместо пустоты. */
  note: string | null
}

/**
 * Диалог из Telegram-бота записи на игру. Бот складывает сообщения в
 * bot_messages (миграция 100), CRM только читает: отвечать продолжают в боте.
 */
export async function getDealConversation(dealId: string): Promise<DealConversation> {
  const me = await getViewer()
  if (!me) return { messages: [], note: 'Нет авторизации' }

  const deal = await queryOne<{ external_key: string | null }>(
    `SELECT d.external_key
       FROM public.deals d
      WHERE d.id = $2
        AND public.can_see_deal(${VIEWER_USER_ID}, d.responsible_employee_id)
      LIMIT 1`,
    [me.id, dealId],
  )
  if (!deal) return { messages: [], note: 'Сделка недоступна' }

  if (!deal.external_key?.startsWith('tg:')) {
    return { messages: [], note: 'Сделка заведена вручную — переписки нет' }
  }

  const chatId = deal.external_key.slice('tg:'.length)
  const rows = await query<{
    id: number
    direction: 'in' | 'out'
    sender: 'client' | 'bot' | 'operator'
    text: string
    created_at: string
  }>(
    `SELECT id, direction, sender, text, created_at
       FROM public.bot_messages
      WHERE chat_id = $1
      ORDER BY created_at, id
      LIMIT 200`,
    [chatId],
  )

  const messages: DealMessage[] = rows.map((row) => ({
    id: String(row.id),
    direction: row.direction,
    sender: row.sender,
    text: row.text,
    created_at: row.created_at,
  }))

  return { messages, note: messages.length ? null : 'Сообщений пока нет' }
}
