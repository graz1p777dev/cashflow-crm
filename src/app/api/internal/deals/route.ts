// ─── POST /api/internal/deals ───────────────────────────────────────────────
// Telegram-бот Cashflow (bot/cashflow_bot/crm.py, push_deal) зовёт этот
// эндпоинт при первом сообщении клиента: в CRM появляется сделка в
// «Неразобранном». Защита — тот же общий секрет, что у /api/internal/notify
// (INTERNAL_NOTIFY_TOKEN): у бота нет и не должно быть доступа к самой БД.
//
// Аутентификация при переезде с Supabase не менялась — она и не была на нём
// завязана. Поменялся только слой данных: upsertDealFromInbound и
// advanceDealFromBotAction ходят в Postgres напрямую.
//
// Вызов у бота fire-and-forget: если CRM недоступна, клиент всё равно
// получит ответ, а сделку заведёт следующий шаг записи.

import { NextResponse } from 'next/server'
import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { advanceDealFromBotAction } from '@/lib/deals/advance-stage'
import type { DealSource } from '@/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const VALID_SOURCES: readonly DealSource[] = [
  'telegram', 'whatsapp', 'instagram', 'manual', 'site',
]

export async function POST(request: Request) {
  const expectedToken = process.env.INTERNAL_NOTIFY_TOKEN
  if (!expectedToken) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (request.headers.get('x-internal-token') !== expectedToken) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let payload: {
    externalKey?: string
    source?: string
    customerName?: string | null
    customerPhone?: string | null
    customerUsername?: string | null
    city?: string | null
    address?: string | null
  }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!payload.externalKey || !payload.externalKey.trim()) {
    return NextResponse.json({ error: 'externalKey is required' }, { status: 400 })
  }
  if (!payload.source || !VALID_SOURCES.includes(payload.source as DealSource)) {
    return NextResponse.json({ error: 'Invalid source' }, { status: 400 })
  }

  const result = await upsertDealFromInbound({
    externalKey: payload.externalKey,
    source: payload.source as DealSource,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    customerUsername: payload.customerUsername,
    city: payload.city,
    address: payload.address,
  })

  if (result.error) {
    console.error('internal/deals upsert failed', result.error)
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({ ok: true, created: result.created, id: result.id })
}

// ─── PATCH /api/internal/deals ──────────────────────────────────────────────
// Бот на каждое сообщение клиента шлёт сюда распознанное намерение (action) —
// сделка двигается по этапам воронки без участия менеджера.
// См. src/lib/deals/advance-stage.ts.

export async function PATCH(request: Request) {
  const expectedToken = process.env.INTERNAL_NOTIFY_TOKEN
  if (!expectedToken) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (request.headers.get('x-internal-token') !== expectedToken) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let payload: { externalKey?: string; action?: string }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!payload.externalKey || !payload.externalKey.trim()) {
    return NextResponse.json({ error: 'externalKey is required' }, { status: 400 })
  }
  if (!payload.action) {
    return NextResponse.json({ error: 'action is required' }, { status: 400 })
  }

  const result = await advanceDealFromBotAction(payload.externalKey, payload.action)

  if (!result.ok) {
    if (result.skipped === 'not_found') {
      return NextResponse.json({ error: 'Deal not found' }, { status: 404 })
    }
    if (result.skipped === 'unknown_action') {
      return NextResponse.json({ error: `Unknown action: ${payload.action}` }, { status: 400 })
    }
    console.error('internal/deals advance failed', result.error)
    return NextResponse.json({ error: result.error || 'Advance failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, id: result.id ?? null, skipped: result.skipped ?? null })
}
