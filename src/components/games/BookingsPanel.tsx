'use client'

import { useMemo, useState, useTransition } from 'react'
import { X, Plus, Trash2, Phone, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import Modal from '../Modal'
import { formatMoney } from '@/lib/formatters'
import { createBooking, setBookingStatus, deleteBooking } from '@/actions/games'
import type { BookingStatus, GameBooking, GameWithSeats } from '@/types'
import { BOOKING_SOURCE, BOOKING_STATUS, HOLDS_SEAT, formatGameWhen } from './game-config'

interface Props {
  game: GameWithSeats
  bookings: GameBooking[]
  canDelete: boolean
  onClose: () => void
  onChanged: () => void
}

const STATUS_ORDER: BookingStatus[] = ['booked', 'confirmed', 'attended', 'cancelled', 'no_show']

export default function BookingsPanel({ game, bookings, canDelete, onClose, onChanged }: Props) {
  const [isPending, startTransition] = useTransition()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [seats, setSeats] = useState('1')

  const taken = useMemo(
    () => bookings.filter((b) => HOLDS_SEAT.includes(b.status)).reduce((sum, b) => sum + b.seats, 0),
    [bookings]
  )
  const free = game.seats_total - taken

  const add = () => {
    if (!name.trim()) {
      toast.error('Введите имя')
      return
    }
    const count = Number(seats)
    if (!Number.isFinite(count) || count < 1) {
      toast.error('Мест — целое число от 1')
      return
    }
    startTransition(async () => {
      const res = await createBooking({
        game_id: game.id,
        name,
        phone: phone || null,
        seats: count,
      })
      if (res.success) {
        toast.success('Запись добавлена')
        setName(''); setPhone(''); setSeats('1'); setAdding(false)
        onChanged()
      } else {
        toast.error(res.error)
      }
    })
  }

  const changeStatus = (id: string, status: BookingStatus) =>
    startTransition(async () => {
      const res = await setBookingStatus(id, status)
      if (res.success) onChanged()
      else toast.error(res.error)
    })

  const remove = (id: string) =>
    startTransition(async () => {
      const res = await deleteBooking(id)
      if (res.success) {
        toast.success('Запись удалена')
        onChanged()
      } else {
        toast.error(res.error)
      }
    })

  return (
    <Modal onClose={onClose} variant="right">
      <div className="flex h-[100dvh] w-[min(640px,100vw)] flex-col overflow-hidden bg-white shadow-2xl animate-in slide-in-from-right duration-200">
        <div className="flex items-start justify-between border-b border-gray-100 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold text-gray-900">{game.title}</h2>
            <p className="mt-0.5 text-[13px] text-gray-500">{formatGameWhen(game.starts_at)}</p>
            <p className="mt-1 text-[12px] text-gray-400">
              {game.venue} · {formatMoney(Number(game.price), game.currency)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-6 py-3">
          <p className="text-[13px] text-gray-600">
            Занято <b className="text-gray-900">{taken}</b> из {game.seats_total}
            {free > 0
              ? <span className="text-gray-400"> · свободно {free}</span>
              : <span className="text-[#781a3e]"> · мест нет</span>}
          </p>
          <button
            onClick={() => setAdding((v) => !v)}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-50"
          >
            <Plus size={14} />
            Записать вручную
          </button>
        </div>

        {adding && (
          <div className="grid grid-cols-1 items-end gap-2 border-b border-gray-100 px-6 py-3 sm:grid-cols-[1fr_1fr_80px_auto]">
            <div className="space-y-1">
              <Label>Имя</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Телефон</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+996…" />
            </div>
            <div className="space-y-1">
              <Label>Мест</Label>
              <Input type="number" value={seats} onChange={(e) => setSeats(e.target.value)} />
            </div>
            <Button onClick={add} disabled={isPending}>Добавить</Button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4 scroll-hidden">
          {bookings.length === 0 ? (
            <p className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-[13px] text-gray-400">
              Записей пока нет. Опубликуйте игру — бот покажет её людям.
            </p>
          ) : (
            <div className="space-y-2">
              {bookings.map((b) => {
                const meta = BOOKING_STATUS[b.status]
                return (
                  <div
                    key={b.id}
                    className="rounded-xl border border-gray-100 px-3.5 py-3 transition-colors hover:border-gray-200"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-semibold text-gray-900">
                          {b.name}
                          {b.seats > 1 && (
                            <span className="ml-1.5 text-[12px] font-normal text-gray-400">
                              · {b.seats} мест
                            </span>
                          )}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-gray-500">
                          {b.phone && (
                            <span className="inline-flex items-center gap-1">
                              <Phone size={11} />{b.phone}
                            </span>
                          )}
                          {b.telegram_username && (
                            <span className="inline-flex items-center gap-1">
                              <Send size={11} />@{b.telegram_username}
                            </span>
                          )}
                          <span className="text-gray-400">{BOOKING_SOURCE[b.source]}</span>
                        </div>
                      </div>
                      <span
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ color: meta.color, background: meta.bg }}
                      >
                        {meta.label}
                      </span>
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {STATUS_ORDER.filter((s) => s !== b.status).map((s) => (
                        <button
                          key={s}
                          onClick={() => changeStatus(b.id, s)}
                          disabled={isPending}
                          className="rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-50"
                        >
                          {BOOKING_STATUS[s].label}
                        </button>
                      ))}
                      {canDelete && (
                        <button
                          onClick={() => remove(b.id)}
                          disabled={isPending}
                          className="ml-auto rounded-md p-1 text-gray-300 transition-colors hover:bg-[#fdeaea] hover:text-[#781a3e] disabled:opacity-50"
                          title="Удалить запись"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
