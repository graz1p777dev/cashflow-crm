// Автосоздание сделки по входящему сообщению клиента.
//
// Единственный вход — push от Telegram-бота записи на игры
// (/api/internal/deals).
//
// ВАЖНО: только серверный код. Вызов приходит снаружи сессии пользователя
// (бот): сделку создаёт система, а не сотрудник, поэтому актора здесь нет и
// проверять нечего — вход защищён общим секретом на уровне ручки.
//
// Идемпотентность держится на UNIQUE deals.external_key: повторное
// сообщение того же клиента не создаёт вторую сделку.

import { queryOne } from '@/lib/db'
import type { DealSource } from '@/types'

export interface InboundDeal {
  /** Стабильный ключ клиента в канале: tg:<chat_id>. */
  externalKey: string
  source: DealSource
  customerName?: string | null
  customerPhone?: string | null
  customerUsername?: string | null
  city?: string | null
  address?: string | null
}

const SOURCE_FALLBACK: Record<DealSource, string> = {
  telegram: 'Клиент из Telegram',
  whatsapp: 'Клиент из WhatsApp',
  instagram: 'Клиент из Instagram',
  site: 'Клиент с сайта',
  manual: 'Клиент',
}

/** Заголовок сделки: имя → username → телефон → канал. Пустым не бывает. */
export function dealTitleFor(input: InboundDeal): string {
  const candidates = [input.customerName, input.customerUsername, input.customerPhone]
  for (const value of candidates) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed.slice(0, 300)
  }
  return SOURCE_FALLBACK[input.source]
}

export interface UpsertDealResult {
  created: boolean
  id: string | null
  error?: string
}

/**
 * Создаёт сделку в этапе по умолчанию («Неразобранное»), если её ещё нет.
 * Существующую не трогает — менеджер мог уже изменить заголовок и сумму.
 */
export async function upsertDealFromInbound(input: InboundDeal): Promise<UpsertDealResult> {
  const key = input.externalKey.trim()
  if (!key) return { created: false, id: null, error: 'external_key пустой' }

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM public.deals WHERE external_key = $1 LIMIT 1',
    [key],
  )
  if (existing) return { created: false, id: existing.id }

  const stage = await queryOne<{ id: string }>(
    'SELECT id FROM public.deal_stages WHERE is_default = TRUE LIMIT 1',
  )
  if (!stage) return { created: false, id: null, error: 'Не найден этап по умолчанию' }

  try {
    // ON CONFLICT DO NOTHING — гонка двух сообщений подряд не должна падать
    // 23505; ровно то, что делал ignoreDuplicates у Supabase. При конфликте
    // RETURNING не возвращает ничего, поэтому created остаётся false.
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO public.deals
         (title, stage_id, source, external_key,
          customer_name, customer_phone, customer_username, city, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (external_key) DO NOTHING
       RETURNING id`,
      [
        dealTitleFor(input),
        stage.id,
        input.source,
        key,
        input.customerName?.trim() || null,
        input.customerPhone?.trim() || null,
        input.customerUsername?.trim() || null,
        input.city?.trim().slice(0, 120) || null,
        input.address?.trim().slice(0, 500) || null,
      ],
    )

    return { created: Boolean(inserted), id: inserted?.id ?? null }
  } catch (e) {
    return { created: false, id: null, error: e instanceof Error ? e.message : String(e) }
  }
}
