'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { Plus, Users, MapPin, Eye, EyeOff, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { formatMoney } from '@/lib/formatters'
import { getGamesData, setGamePublished, type GameHost } from '@/actions/games'
import type { GameBooking, GameWithSeats, UserRole } from '@/types'
import { GAME_STATUS, formatGameWhen } from './game-config'
import GameModal from './GameModal'
import BookingsPanel from './BookingsPanel'

interface Props {
  initialGames: GameWithSeats[]
  initialBookings: GameBooking[]
  hosts: GameHost[]
  role: UserRole
}

type Tab = 'upcoming' | 'past'

export default function GamesClient({ initialGames, initialBookings, hosts, role }: Props) {
  const [games, setGames] = useState(initialGames)
  const [bookings, setBookings] = useState(initialBookings)
  const [tab, setTab] = useState<Tab>('upcoming')
  const [editing, setEditing] = useState<GameWithSeats | null>(null)
  const [creating, setCreating] = useState(false)
  const [openedId, setOpenedId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const canDelete = role === 'owner'

  const refresh = useCallback(async () => {
    const data = await getGamesData()
    setGames(data.games)
    setBookings(data.bookings)
  }, [])

  // Записи приходят из бота, а не из этого браузера — без обновления список
  // молча устаревал бы, пока менеджер смотрит на карточку игры. Раньше это
  // была Supabase Realtime-подписка; на Postgres без Realtime — поллинг.
  useEffect(() => {
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  const now = Date.now()
  const visible = useMemo(
    () =>
      games
        .filter((g) =>
          tab === 'upcoming'
            ? new Date(g.starts_at).getTime() >= now - 6 * 3600_000
            : new Date(g.starts_at).getTime() < now - 6 * 3600_000
        )
        .sort((a, b) =>
          tab === 'upcoming'
            ? new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
            : new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime()
        ),
    [games, tab, now]
  )

  const bookingsOf = useCallback(
    (gameId: string) => bookings.filter((b) => b.game_id === gameId),
    [bookings]
  )

  const togglePublished = (game: GameWithSeats) =>
    startTransition(async () => {
      const res = await setGamePublished(game.id, !game.is_published)
      if (res.success) {
        toast.success(game.is_published ? 'Скрыта из бота' : 'Опубликована в боте')
        await refresh()
      } else {
        toast.error(res.error)
      }
    })

  const opened = openedId ? games.find((g) => g.id === openedId) ?? null : null

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="kicker">Расписание</p>
          <h1 className="block-title">Игры</h1>
          <span className="span-rule" aria-hidden />
          <p className="mt-1.5 text-[13px] text-gray-400">
            Опубликованные игры видны в Telegram-боте — оттуда и приходят записи.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-gray-200 p-0.5">
            {([['upcoming', 'Ближайшие'], ['past', 'Прошедшие']] as [Tab, string][]).map(
              ([id, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
                    tab === id ? 'bg-[#f3e9f8] text-[#430c61]' : 'text-gray-500 hover:bg-gray-50'
                  )}
                >
                  {label}
                </button>
              )
            )}
          </div>
          <button
            onClick={() => setCreating(true)}
            className="flex h-9 items-center gap-1.5 rounded-xl px-4 text-[13px] font-semibold text-white brand-gradient brand-shadow transition-transform hover:-translate-y-0.5"
          >
            <Plus size={16} />
            Новая игра
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-gray-200 px-4 py-12 text-center text-[13px] text-gray-400">
          {tab === 'upcoming' ? 'Ближайших игр нет. Создайте первую.' : 'Прошедших игр пока нет.'}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((game) => {
            const free = game.seats_total - game.seats_taken
            const pct = Math.min(100, Math.round((game.seats_taken / game.seats_total) * 100))
            const status = GAME_STATUS[game.status]
            return (
              <div
                key={game.id}
                className="card-hover flex flex-col gap-3 rounded-2xl bg-white p-4"
                style={{ border: '1px solid #f0eaea' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-semibold text-gray-900">{game.title}</p>
                    <p className="mt-0.5 text-[13px] text-gray-500">{formatGameWhen(game.starts_at)}</p>
                  </div>
                  <span
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{ color: status.color, background: status.bg }}
                  >
                    {status.label}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-gray-500">
                  <span className="inline-flex items-center gap-1">
                    <MapPin size={12} />{game.venue}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock size={12} />{game.duration_min} мин
                  </span>
                  <span className="font-semibold text-gray-700">
                    {formatMoney(Number(game.price), game.currency)}
                  </span>
                </div>

                {/* Полоса занятости: главное число этой страницы */}
                <div>
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="inline-flex items-center gap-1 text-gray-500">
                      <Users size={12} />
                      {game.seats_taken} / {game.seats_total}
                    </span>
                    <span className={free > 0 ? 'text-gray-400' : 'font-semibold text-[#781a3e]'}>
                      {free > 0 ? `свободно ${free}` : 'мест нет'}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full transition-[width] duration-300"
                      style={{
                        width: `${pct}%`,
                        background: free > 0
                          ? 'linear-gradient(90deg, #430C61, #7B3FA0)'
                          : '#781A3E',
                      }}
                    />
                  </div>
                </div>

                <div className="mt-auto flex items-center gap-2 pt-1">
                  <button
                    onClick={() => setOpenedId(game.id)}
                    className="h-8 flex-1 rounded-lg bg-[#f3e9f8] text-[13px] font-medium text-[#430c61] transition-colors hover:bg-[#e7d6f2]"
                  >
                    Записи · {bookingsOf(game.id).length}
                  </button>
                  <button
                    onClick={() => setEditing(game)}
                    className="h-8 rounded-lg border border-gray-200 px-3 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-50"
                  >
                    Изменить
                  </button>
                  <button
                    onClick={() => togglePublished(game)}
                    title={game.is_published ? 'Скрыть из бота' : 'Показать в боте'}
                    className={cn(
                      'flex size-8 items-center justify-center rounded-lg border transition-colors',
                      game.is_published
                        ? 'border-[#e7d6f2] bg-[#f3e9f8] text-[#430c61]'
                        : 'border-gray-200 text-gray-400 hover:bg-gray-50'
                    )}
                  >
                    {game.is_published ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {(creating || editing) && (
        <GameModal
          game={editing}
          hosts={hosts}
          canDelete={canDelete}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={refresh}
        />
      )}

      {opened && (
        <BookingsPanel
          game={opened}
          bookings={bookingsOf(opened.id)}
          canDelete={canDelete}
          onClose={() => setOpenedId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}
