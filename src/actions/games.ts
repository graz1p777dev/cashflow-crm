'use server'

// Расписание игр и записи на них (supabase/migrations/042_games.sql).
// Опубликованные игры отсюда забирает Telegram-бот через публичный API
// (src/app/api/public/games), записи из бота приходят обратно в
// game_bookings — CRM и бот работают с одной таблицей.
//
// ─── Про права ───────────────────────────────────────────────────────────────
// В этом файле раньше не было ни одной проверки прав: их целиком делала RLS
// (042_games.sql). Расписание видели все вошедшие (games_select USING TRUE), а
// править игры и брони могли только owner/rop/mp/lmai — бухгалтер получал
// отказ от базы. RLS вместе с Supabase ушла (db/schema.sql, DECISION 1),
// поэтому те же самые роли перечислены здесь явно: без этого бухгалтер молча
// получил бы права, которых у него не было.
// Удаление брони — отдельный, более узкий список (owner/rop), как в
// game_bookings_delete.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { query, queryOne } from '@/lib/db'
import { getActor } from '@/lib/auth/actor'
import type {
  BookingStatus,
  Game,
  GameBooking,
  GameWithSeats,
  UserRole,
} from '@/types'

export type GameActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string }

export interface GameHost {
  id: string
  name: string
}

export interface GamesData {
  games: GameWithSeats[]
  bookings: GameBooking[]
  hosts: GameHost[]
  role: UserRole | null
}

/** Занятые места считаем здесь, а не в БД-поле: одна правда — сами брони. */
const HOLDS_SEAT: BookingStatus[] = ['booked', 'confirmed', 'attended']

/** Кто правит игры и брони — точная копия WITH CHECK из 042_games.sql. */
const CAN_MANAGE: readonly string[] = ['owner', 'rop', 'mp', 'lmai']
/** Кто удаляет брони — game_bookings_delete был строже остальных политик. */
const CAN_DELETE_BOOKING: readonly string[] = ['owner', 'rop']

/** Роль действующего лица либо null, если сессии нет. */
async function currentRole(): Promise<string | null> {
  const actor = await getActor()
  return actor?.role ?? null
}

export async function getGamesData(): Promise<GamesData> {
  const role = await currentRole()
  if (!role) return { games: [], bookings: [], hosts: [], role: null }

  const [games, bookings, hosts] = await Promise.all([
    query<Game>(
      `SELECT * FROM public.games
        WHERE deleted_at IS NULL
        ORDER BY starts_at DESC`,
    ),
    query<GameBooking>(
      'SELECT * FROM public.game_bookings ORDER BY created_at',
    ),
    query<GameHost>(
      `SELECT id, name FROM public.employees
        WHERE deleted_at IS NULL
        ORDER BY name`,
    ),
  ])

  const taken = new Map<string, number>()
  for (const b of bookings) {
    if (!HOLDS_SEAT.includes(b.status)) continue
    taken.set(b.game_id, (taken.get(b.game_id) ?? 0) + b.seats)
  }

  return {
    games: games.map((g) => ({ ...g, seats_taken: taken.get(g.id) ?? 0 })),
    bookings,
    hosts,
    role: role as UserRole,
  }
}

// ─── Игра ────────────────────────────────────────────────────────────────────

const GameSchema = z.object({
  title: z.string().trim().min(1, 'Введите название').max(200, 'Слишком длинное название'),
  starts_at: z.string().min(1, 'Укажите дату и время'),
  duration_min: z.number().int().min(30, 'Минимум 30 минут').max(600, 'Максимум 10 часов'),
  venue: z.string().trim().min(1, 'Укажите место').max(300, 'Слишком длинный адрес'),
  price: z.number().nonnegative('Цена не может быть отрицательной'),
  currency: z.enum(['KGS', 'USD', 'RUB']).default('KGS'),
  seats_total: z.number().int().min(1, 'Минимум 1 место').max(60, 'Максимум 60 мест'),
  host_employee_id: z.string().uuid().nullable().optional(),
  note: z.string().nullable().optional(),
  is_published: z.boolean().default(false),
  status: z.enum(['planned', 'done', 'cancelled']).default('planned'),
})

export type GameFormData = z.input<typeof GameSchema>

const clean = (value: string | null | undefined) => value?.trim() || null

/**
 * Триггер check_game_seats() (042_games.sql) бросает 'Свободных мест нет: ...'
 * при попытке занять больше мест, чем есть. Двое могут нажать «Записаться»
 * одновременно, и последнее место должно достаться одному — поэтому проверка
 * живёт в БД, а не здесь, и текст ошибки распознаётся по подстроке ровно так
 * же, как это делалось с error.message от Supabase.
 */
function seatErrorText(e: unknown, fallbackHint: string): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.includes('Свободных мест нет') ? fallbackHint : message
}

export async function createGame(input: GameFormData): Promise<GameActionResult<{ id: string }>> {
  const role = await currentRole()
  if (!role) return { success: false, error: 'Нет авторизации' }
  if (!CAN_MANAGE.includes(role)) return { success: false, error: 'Недостаточно прав' }

  const parsed = GameSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const g = parsed.data

  try {
    const created = await queryOne<{ id: string }>(
      `INSERT INTO public.games
         (title, starts_at, duration_min, venue, price, currency, seats_total,
          host_employee_id, note, is_published, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        g.title,
        g.starts_at,
        g.duration_min,
        g.venue,
        g.price,
        g.currency,
        g.seats_total,
        g.host_employee_id ?? null,
        clean(g.note),
        g.is_published,
        g.status,
      ],
    )
    if (!created) return { success: false, error: 'Не удалось создать игру' }

    revalidatePath('/dashboard/games')
    return { success: true, data: { id: created.id } }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось создать игру' }
  }
}

export async function updateGame(id: string, input: GameFormData): Promise<GameActionResult> {
  const role = await currentRole()
  if (!role) return { success: false, error: 'Нет авторизации' }
  if (!CAN_MANAGE.includes(role)) return { success: false, error: 'Недостаточно прав' }

  const parsed = GameSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const g = parsed.data

  try {
    const updated = await query<{ id: string }>(
      `UPDATE public.games
          SET title = $2, starts_at = $3, duration_min = $4, venue = $5,
              price = $6, currency = $7, seats_total = $8,
              host_employee_id = $9, note = $10, is_published = $11, status = $12
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [
        id,
        g.title,
        g.starts_at,
        g.duration_min,
        g.venue,
        g.price,
        g.currency,
        g.seats_total,
        g.host_employee_id ?? null,
        clean(g.note),
        g.is_published,
        g.status,
      ],
    )
    if (updated.length === 0) return { success: false, error: 'Игра недоступна' }

    revalidatePath('/dashboard/games')
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось сохранить игру' }
  }
}

/** Публикация — единственное, что переключают из списка одним кликом. */
export async function setGamePublished(id: string, published: boolean): Promise<GameActionResult> {
  const role = await currentRole()
  if (!role) return { success: false, error: 'Нет авторизации' }
  if (!CAN_MANAGE.includes(role)) return { success: false, error: 'Недостаточно прав' }

  try {
    const updated = await query<{ id: string }>(
      `UPDATE public.games SET is_published = $2
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [id, published],
    )
    if (updated.length === 0) return { success: false, error: 'Игра недоступна' }

    revalidatePath('/dashboard/games')
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось изменить игру' }
  }
}

/** Мягкое удаление: записи людей остаются, история не теряется. */
export async function deleteGame(id: string): Promise<GameActionResult> {
  const role = await currentRole()
  if (!role) return { success: false, error: 'Нет авторизации' }
  if (!CAN_MANAGE.includes(role)) return { success: false, error: 'Недостаточно прав' }

  try {
    // Мягкое удаление — это UPDATE, поэтому список ролей тот же, что у
    // редактирования: games_delete (только owner) относилась к жёсткому
    // DELETE, которого здесь нет и не было.
    const deleted = await query<{ id: string }>(
      `UPDATE public.games SET deleted_at = NOW(), is_published = FALSE
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [id],
    )
    if (deleted.length === 0) return { success: false, error: 'Игра недоступна' }

    revalidatePath('/dashboard/games')
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось удалить игру' }
  }
}

// ─── Записи ──────────────────────────────────────────────────────────────────

const BookingSchema = z.object({
  game_id: z.string().uuid('Выберите игру'),
  name: z.string().trim().min(1, 'Введите имя').max(200, 'Слишком длинное имя'),
  phone: z.string().trim().max(32, 'Слишком длинный номер').nullable().optional(),
  seats: z.number().int().min(1, 'Минимум 1 место').max(10, 'Максимум 10 мест'),
  note: z.string().nullable().optional(),
})

export type BookingFormData = z.input<typeof BookingSchema>

/** Ручная запись — когда человек позвонил или пришёл сам, минуя бота. */
export async function createBooking(input: BookingFormData): Promise<GameActionResult> {
  const role = await currentRole()
  if (!role) return { success: false, error: 'Нет авторизации' }
  if (!CAN_MANAGE.includes(role)) return { success: false, error: 'Недостаточно прав' }

  const parsed = BookingSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const b = parsed.data

  try {
    await query(
      `INSERT INTO public.game_bookings (game_id, name, phone, seats, source, note)
       VALUES ($1, $2, $3, $4, 'manual', $5)`,
      [b.game_id, b.name, clean(b.phone), b.seats, clean(b.note)],
    )
  } catch (e) {
    // Проверку мест делает триггер БД — двое могут записаться одновременно.
    return { success: false, error: seatErrorText(e, 'Свободных мест нет') }
  }

  revalidatePath('/dashboard/games')
  return { success: true }
}

export async function setBookingStatus(
  id: string,
  status: BookingStatus
): Promise<GameActionResult> {
  const role = await currentRole()
  if (!role) return { success: false, error: 'Нет авторизации' }
  if (!CAN_MANAGE.includes(role)) return { success: false, error: 'Недостаточно прав' }

  let updated: { id: string }[]
  try {
    updated = await query<{ id: string }>(
      'UPDATE public.game_bookings SET status = $2 WHERE id = $1 RETURNING id',
      [id, status],
    )
  } catch (e) {
    // Возврат брони из «отменена» обратно в «записан» тоже проходит через
    // триггер: за это время место могли занять.
    return { success: false, error: seatErrorText(e, 'Свободных мест нет — сначала освободите место') }
  }
  if (updated.length === 0) return { success: false, error: 'Запись недоступна' }

  revalidatePath('/dashboard/games')
  return { success: true }
}

export async function deleteBooking(id: string): Promise<GameActionResult> {
  const role = await currentRole()
  if (!role) return { success: false, error: 'Нет авторизации' }
  if (!CAN_DELETE_BOOKING.includes(role)) return { success: false, error: 'Недостаточно прав' }

  try {
    await query('DELETE FROM public.game_bookings WHERE id = $1', [id])
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось удалить запись' }
  }

  revalidatePath('/dashboard/games')
  return { success: true }
}
