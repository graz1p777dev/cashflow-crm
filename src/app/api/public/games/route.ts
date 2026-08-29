// ─── GET /api/public/games ──────────────────────────────────────────────────
// Список игр для Telegram-бота: только опубликованные, только будущие,
// со свободными местами. Черновики и отменённые игры бот не видит вовсе —
// фильтрация здесь, а не в боте, чтобы «скрыть игру» работало сразу.

import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { guardBotRequest } from '@/lib/public-api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'


export async function GET(request: Request) {
  const guard = guardBotRequest(request)
  if (!guard.ok) return guard.response

  // Игра, которая началась час назад, боту уже не нужна, а «сегодня в 18:00»
  // при запросе в 18:05 — ещё интересна: берём с запасом в час назад.
  const from = new Date(Date.now() - 3600_000).toISOString()

  try {
    // Свободные места считает game_seats_taken() — та же SQL-функция, что
    // стоит за проверкой мест в триггере. Раньше это были два запроса и
    // сведение брони в Map на стороне Node; теперь считает база, и «занято»
    // определяется ровно тем же выражением, что и при записи, — разойтись
    // этим двум местам больше негде.
    const rows = await query<{
      id: string
      title: string
      starts_at: string
      duration_min: number
      venue: string
      price: number
      currency: string
      seats_total: number
      seats_free: number
    }>(
      `SELECT g.id,
              g.title,
              g.starts_at,
              g.duration_min,
              g.venue,
              g.price,
              g.currency,
              g.seats_total,
              GREATEST(0, g.seats_total - public.game_seats_taken(g.id)) AS seats_free
         FROM public.games g
        WHERE g.is_published = TRUE
          AND g.status = 'planned'
          AND g.deleted_at IS NULL
          AND g.starts_at >= $1
        ORDER BY g.starts_at
        LIMIT 20`,
      [from],
    )

    return NextResponse.json({
      games: rows.map((g) => ({
        id: g.id,
        title: g.title,
        startsAt: g.starts_at,
        durationMin: g.duration_min,
        venue: g.venue,
        price: Number(g.price),
        currency: g.currency,
        seatsTotal: g.seats_total,
        seatsFree: g.seats_free,
      })),
    })
  } catch (e) {
    console.error('public/games failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}
