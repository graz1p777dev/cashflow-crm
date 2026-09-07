// ─── POST /api/public/messages ──────────────────────────────────────────────
// Бот складывает сюда переписку, чтобы менеджер видел её в карточке сделки
// (src/actions/deals.ts, getDealConversation). Отвечать продолжают в боте —
// CRM только читает.

import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { guardBotRequest, readJson } from '@/lib/public-api'
import { notify } from '@/lib/notifications/notify'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface MessagePayload {
  chatId?: number | string
  direction?: 'in' | 'out'
  sender?: 'client' | 'bot' | 'operator'
  text?: string
}

export async function POST(request: Request) {
  const guard = guardBotRequest(request)
  if (!guard.ok) return guard.response

  const payload = await readJson<MessagePayload>(request)
  if (!payload) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const text = payload.text?.trim()
  if (!payload.chatId) return NextResponse.json({ error: 'chatId is required' }, { status: 400 })
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 })
  if (payload.direction !== 'in' && payload.direction !== 'out') {
    return NextResponse.json({ error: 'direction must be in|out' }, { status: 400 })
  }

  try {
    await query(
      `INSERT INTO public.bot_messages (chat_id, direction, sender, text)
       VALUES ($1, $2, $3, $4)`,
      [
        String(payload.chatId),
        payload.direction,
        payload.sender ?? (payload.direction === 'in' ? 'client' : 'bot'),
        // Длинные простыни в карточке всё равно не читают, а таблицу раздувают.
        text.slice(0, 4000),
      ],
    )
  } catch (e) {
    console.error('public/messages insert failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  // Входящие от клиента менеджер видит в карточке сделки — отдельное
  // уведомление не нужно. Ответы бота — обычные (не важные) уведомления,
  // отдельно от важных game_booking. sourceId не передаём: bot_messages.id
  // BIGSERIAL, а notifications.source_id — UUID.
  if (payload.direction === 'out') {
    await notify({
      type: 'bot_message',
      title: 'Ответ бота',
      body: text.slice(0, 200),
      actionUrl: '/dashboard/deals',
      isImportant: false,
      sourceType: 'bot_message',
    })
  }

  return NextResponse.json({ ok: true })
}
