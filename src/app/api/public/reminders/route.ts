// ─── GET /api/public/reminders ──────────────────────────────────────────────
// Кого бот напоминает о завтрашней игре. Бот опрашивает эту ручку по
// расписанию и сам следит, чтобы не отправить напоминание дважды
// (его SQLite, таблица reminders_sent) — CRM состояние рассылок не хранит.
//
// withinHours — окно от «сейчас» вперёд: 26 часов покрывает «завтра
// в это же время» с запасом на то, что бот проснулся чуть позже.

import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { guardBotRequest } from '@/lib/public-api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const guard = guardBotRequest(request)
  if (!guard.ok) return guard.response

  const raw = new URL(request.url).searchParams.get('withinHours')
  const hours = Math.min(72, Math.max(1, Number(raw) || 26))

  type Row = {
    id: string
    name: string
    seats: number
    status: string
    telegram_chat_id: number
    game_id: string
    game_title: string
    game_starts_at: string
    game_venue: string
  }

  let rows: Row[]
  try {
    rows = await query<Row>(
      `SELECT b.id, b.name, b.seats, b.status, b.telegram_chat_id,
              g.id AS game_id, g.title AS game_title, g.starts_at AS game_starts_at, g.venue AS game_venue
         FROM public.game_bookings b
         JOIN public.games g ON g.id = b.game_id
        WHERE b.telegram_chat_id IS NOT NULL
          AND b.status IN ('booked', 'confirmed')
          AND g.starts_at >= $1
          AND g.starts_at <= $2
          AND g.status = 'planned'
          AND g.deleted_at IS NULL`,
      [new Date().toISOString(), new Date(Date.now() + hours * 3600_000).toISOString()],
    )
  } catch (e) {
    console.error('public/reminders failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  return NextResponse.json({
    reminders: rows.map((b) => ({
      bookingId: b.id,
      chatId: b.telegram_chat_id,
      name: b.name,
      seats: b.seats,
      status: b.status,
      game: {
        id: b.game_id,
        title: b.game_title,
        startsAt: b.game_starts_at,
        venue: b.game_venue,
      },
    })),
  })
}
