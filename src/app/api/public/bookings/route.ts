// ─── /api/public/bookings ───────────────────────────────────────────────────
// Запись на игру из Telegram-бота.
//
//   POST  — записать (идемпотентно: повтор с того же чата обновляет бронь)
//   GET   — брони этого чата, чтобы бот показал «Мои записи»
//   PATCH — отмена или подтверждение брони самим человеком
//
// Свободные места проверяет БД-триггер check_game_seats (042_games.sql): двое
// могут нажать «Записаться» одновременно, и последнее место должно достаться
// одному. Проверка осталась в базе намеренно — только там она атомарна.
//
// Аутентификация не менялась: бот ходит с общим секретом BOT_API_TOKEN
// (guardBotRequest), сессии пользователя здесь нет и не было. Поменялся
// только доступ к данным — Supabase на Postgres.

import { NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { guardBotRequest, readJson } from '@/lib/public-api'
import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { advanceDealFromBotAction } from '@/lib/deals/advance-stage'
import { notify } from '@/lib/notifications/notify'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const NO_SEATS = 'Свободных мест нет'

interface BookingPayload {
  gameId?: string
  name?: string
  phone?: string | null
  seats?: number
  telegramChatId?: number
  telegramUsername?: string | null
}

export async function POST(request: Request) {
  const guard = guardBotRequest(request)
  if (!guard.ok) return guard.response

  const payload = await readJson<BookingPayload>(request)
  if (!payload) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { gameId, telegramChatId } = payload
  const name = payload.name?.trim()
  const seats = payload.seats ?? 1

  if (!gameId) return NextResponse.json({ error: 'gameId is required' }, { status: 400 })
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (!telegramChatId) {
    return NextResponse.json({ error: 'telegramChatId is required' }, { status: 400 })
  }
  if (!Number.isInteger(seats) || seats < 1 || seats > 10) {
    return NextResponse.json({ error: 'seats must be 1..10' }, { status: 400 })
  }

  const g = await queryOne<{
    id: string
    title: string
    starts_at: string
    seats_total: number
    is_published: boolean
    status: string
  }>(
    `SELECT id, title, starts_at, seats_total, is_published, status
       FROM public.games
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [gameId],
  )

  if (!g) return NextResponse.json({ error: 'Game not found' }, { status: 404 })
  if (!g.is_published || g.status !== 'planned') {
    return NextResponse.json({ error: 'Game is not open' }, { status: 409 })
  }

  // Сделка в воронке. Падение здесь не должно ломать запись: место человеку
  // важнее карточки в CRM, поэтому ошибку только логируем. Сделка заводится
  // до брони намеренно: даже если мест не хватило, человек остаётся лидом
  // в «Неразобранном» — ему можно предложить другую дату.
  const deal = await upsertDealFromInbound({
    externalKey: `tg:${telegramChatId}`,
    source: 'telegram',
    customerName: name,
    customerPhone: payload.phone ?? null,
    customerUsername: payload.telegramUsername ?? null,
  })
  if (deal.error) console.error('public/bookings: deal upsert failed', deal.error)

  let bookingId: string
  try {
    // Повторная запись того же чата — обновление своей брони, а не вторая:
    // ON CONFLICT по game_bookings_chat_unique (game_id, telegram_chat_id).
    // Ручные брони под это ограничение не попадают — у них
    // telegram_chat_id NULL, а NULL в UNIQUE не конфликтует сам с собой.
    //
    // status сбрасывается в 'booked' осознанно: у Supabase .upsert() писал
    // весь объект row целиком, включая status: 'booked', поэтому повторная
    // запись после отмены возвращала бронь в силу. Перечисляем колонки в
    // DO UPDATE поимённо, чтобы это осталось видимым решением, а не
    // побочным эффектом формы записи.
    //
    // Перенесённая как есть особенность, которую стоит знать: при ON CONFLICT
    // DO UPDATE сначала срабатывает BEFORE INSERT-триггер check_game_seats и
    // считает предлагаемую бронь как ДОПОЛНИТЕЛЬНУЮ к уже существующей.
    // Поэтому человек, у которого на этой игре уже есть бронь, при повторной
    // записи может получить 'no_seats', даже если фактически всего лишь
    // уменьшает число мест. Под Supabase .upsert() компилировался в тот же
    // INSERT ... ON CONFLICT, так что вело себя это ровно так же — здесь не
    // чиним, чтобы перенос оставался переносом.
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO public.game_bookings
         (game_id, name, phone, telegram_chat_id, telegram_username,
          seats, source, status, deal_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'bot', 'booked', $7)
       ON CONFLICT (game_id, telegram_chat_id) DO UPDATE
          SET name              = EXCLUDED.name,
              phone             = EXCLUDED.phone,
              telegram_username = EXCLUDED.telegram_username,
              seats             = EXCLUDED.seats,
              source            = EXCLUDED.source,
              status            = EXCLUDED.status,
              deal_id           = EXCLUDED.deal_id
       RETURNING id`,
      [
        gameId,
        name,
        payload.phone?.trim() || null,
        telegramChatId,
        payload.telegramUsername?.replace(/^@/, '') || null,
        seats,
        deal.id,
      ],
    )
    if (!inserted) {
      console.error('public/bookings insert returned no row')
      return NextResponse.json({ error: 'Database error' }, { status: 500 })
    }
    bookingId = inserted.id
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message.includes(NO_SEATS)) {
      return NextResponse.json({ error: 'no_seats' }, { status: 409 })
    }
    console.error('public/bookings insert failed', message)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }

  await advanceDealFromBotAction(`tg:${telegramChatId}`, 'booked')

  await notify({
    type: 'game_booking',
    title: `Запись на игру: ${name}`,
    body: `${g.title} · мест: ${seats}${payload.phone ? ` · ${payload.phone}` : ''}`,
    actionUrl: '/dashboard/games',
    sourceType: 'game',
    sourceId: g.id,
  })

  // Раньше это была admin.rpc('game_seats_taken', ...). Функция никуда не
  // делась — она обычная SQL-функция и в plain Postgres (db/schema.sql),
  // так что RPC превращается в прямой SELECT.
  const taken = await queryOne<{ taken: number }>(
    'SELECT public.game_seats_taken($1) AS taken',
    [gameId],
  )

  return NextResponse.json({
    ok: true,
    bookingId,
    seatsFree: Math.max(0, g.seats_total - (taken?.taken ?? 0)),
  })
}

export async function GET(request: Request) {
  const guard = guardBotRequest(request)
  if (!guard.ok) return guard.response

  const chatId = new URL(request.url).searchParams.get('chatId')
  if (!chatId) return NextResponse.json({ error: 'chatId is required' }, { status: 400 })

  try {
    // Вложенный games(...) у PostgREST — это обычный JOIN. Брони без игры
    // прежний код отфильтровывал в JS (`.filter((b) => b.games)`); здесь ту
    // же роль играет INNER JOIN.
    const rows = await query<{
      id: string
      seats: number
      status: string
      game_id: string
      game_title: string
      game_starts_at: string
      game_venue: string
      game_price: number
      game_currency: string
    }>(
      `SELECT b.id,
              b.seats,
              b.status,
              g.id         AS game_id,
              g.title      AS game_title,
              g.starts_at  AS game_starts_at,
              g.venue      AS game_venue,
              g.price      AS game_price,
              g.currency   AS game_currency
         FROM public.game_bookings b
         JOIN public.games g ON g.id = b.game_id
        WHERE b.telegram_chat_id = $1
          AND b.status IN ('booked', 'confirmed', 'attended')
        ORDER BY b.created_at DESC
        LIMIT 20`,
      [Number(chatId)],
    )

    return NextResponse.json({
      bookings: rows.map((b) => ({
        id: b.id,
        seats: b.seats,
        status: b.status,
        game: {
          id: b.game_id,
          title: b.game_title,
          startsAt: b.game_starts_at,
          venue: b.game_venue,
          price: Number(b.game_price),
          currency: b.game_currency,
        },
      })),
    })
  } catch (e) {
    console.error('public/bookings list failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
}

interface PatchPayload {
  bookingId?: string
  telegramChatId?: number
  status?: 'cancelled' | 'confirmed'
}

export async function PATCH(request: Request) {
  const guard = guardBotRequest(request)
  if (!guard.ok) return guard.response

  const payload = await readJson<PatchPayload>(request)
  if (!payload) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  if (!payload.bookingId) {
    return NextResponse.json({ error: 'bookingId is required' }, { status: 400 })
  }
  if (payload.status !== 'cancelled' && payload.status !== 'confirmed') {
    return NextResponse.json({ error: 'status must be cancelled|confirmed' }, { status: 400 })
  }
  // Человек через бота меняет только свою бронь: сверяем чат, иначе по
  // чужому id можно было бы отменить любую запись.
  if (!payload.telegramChatId) {
    return NextResponse.json({ error: 'telegramChatId is required' }, { status: 400 })
  }

  let updated: { id: string }[]
  try {
    updated = await query<{ id: string }>(
      `UPDATE public.game_bookings
          SET status = $3
        WHERE id = $1 AND telegram_chat_id = $2
        RETURNING id`,
      [payload.bookingId, payload.telegramChatId, payload.status],
    )
  } catch (e) {
    console.error('public/bookings patch failed', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Database error' }, { status: 500 })
  }
  if (updated.length === 0) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (payload.status === 'confirmed') {
    await advanceDealFromBotAction(`tg:${payload.telegramChatId}`, 'confirmed')
  }

  return NextResponse.json({ ok: true })
}
