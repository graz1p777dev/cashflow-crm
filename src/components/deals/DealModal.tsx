'use client'

import { useEffect, useState, useTransition } from 'react'
import { X, Trash2, MessagesSquare, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import Modal from '../Modal'
import { cn } from '@/lib/utils'
import {
  createDeal,
  updateDeal,
  deleteDeal,
  getDealConversation,
} from '@/actions/deals'
import type {
  Deal,
  DealCurrency,
  DealEmployee,
  DealMessage,
  DealStage,
  DealViewer,
} from '@/types'
import { DEAL_CURRENCIES, DEAL_SOURCE } from './deal-config'

interface Props {
  deal: Deal | null
  isNew: boolean
  defaultStageId: string
  stages: DealStage[]
  employees: DealEmployee[]
  me: DealViewer
  onClose: () => void
  onSaved: () => void
}

interface FormState {
  title: string
  stage_id: string
  amount: string
  currency: DealCurrency
  customer_name: string
  customer_phone: string
  customer_username: string
  city: string
  address: string
  responsible_employee_id: string
  note: string
}

const AMO_MEDIA_MESSAGE = /^\[([^\]]+)]\s+(https:\/\/\S+)$/i

function ChatMessageContent({ text }: { text: string }) {
  const media = text.match(AMO_MEDIA_MESSAGE)
  if (!media) return text
  const type = media[1].toLowerCase()
  const label = type === 'picture' || type === 'image'
    ? '📷 Открыть фото'
    : type === 'video'
      ? '🎬 Открыть видео'
      : type === 'audio' || type === 'voice'
        ? '🎤 Открыть аудио'
        : '📎 Открыть вложение'
  return (
    <a
      href={media[2]}
      target="_blank"
      rel="noreferrer"
      className="font-medium underline underline-offset-2"
    >
      {label}
    </a>
  )
}

export default function DealModal({
  deal,
  isNew,
  defaultStageId,
  stages,
  employees,
  me,
  onClose,
  onSaved,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [messages, setMessages] = useState<DealMessage[] | null>(null)
  const [chatNote, setChatNote] = useState<string | null>(null)
  const [conversationReload, setConversationReload] = useState(0)

  const [form, setForm] = useState<FormState>(() => ({
    title: deal?.title ?? '',
    stage_id: deal?.stage_id ?? defaultStageId,
    amount: deal?.amount !== null && deal?.amount !== undefined ? String(deal.amount) : '',
    currency: deal?.currency ?? 'KGS',
    customer_name: deal?.customer_name ?? '',
    customer_phone: deal?.customer_phone ?? '',
    customer_username: deal?.customer_username ?? '',
    city: deal?.city ?? '',
    address: deal?.address ?? '',
    responsible_employee_id: deal?.responsible_employee_id ?? '',
    note: deal?.note ?? '',
  }))

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  // Переписка живёт во внешней системе — тянем её только для открытой сделки.
  useEffect(() => {
    if (isNew || !deal) return
    let alive = true
    const timeout = window.setTimeout(() => {
      if (!alive) return
      alive = false
      setMessages([])
      setChatNote('База не ответила вовремя. Нажмите «Повторить».')
    }, 12_000)
    void getDealConversation(deal.id)
      .then((res) => {
        if (!alive) return
        window.clearTimeout(timeout)
        setMessages(res.messages)
        setChatNote(res.note)
      })
      .catch((error) => {
        if (!alive) return
        window.clearTimeout(timeout)
        console.error('deal conversation load failed', error)
        setMessages([])
        setChatNote('Не удалось загрузить переписку. Нажмите «Повторить».')
      })
    return () => {
      alive = false
      window.clearTimeout(timeout)
    }
  }, [isNew, deal, conversationReload])

  const handleSave = () => {
    if (!form.title.trim()) {
      toast.error('Введите название сделки')
      return
    }
    const amount = form.amount.trim() ? Number(form.amount.replace(',', '.')) : null
    if (amount !== null && !Number.isFinite(amount)) {
      toast.error('Сумма должна быть числом')
      return
    }

    const payload = {
      title: form.title,
      stage_id: form.stage_id,
      amount,
      currency: form.currency,
      customer_name: form.customer_name || null,
      customer_phone: form.customer_phone || null,
      customer_username: form.customer_username || null,
      city: form.city || null,
      address: form.address || null,
      responsible_employee_id: form.responsible_employee_id || null,
      note: form.note || null,
    }

    startTransition(async () => {
      const res = isNew ? await createDeal(payload) : await updateDeal(deal!.id, payload)
      if (res.success) {
        toast.success(isNew ? 'Сделка создана' : 'Изменения сохранены')
        onSaved()
        onClose()
      } else {
        toast.error(res.error)
      }
    })
  }

  const handleDelete = () => {
    if (!deal) return
    startTransition(async () => {
      const res = await deleteDeal(deal.id)
      if (res.success) {
        toast.success('Сделка удалена')
        onSaved()
        onClose()
      } else {
        toast.error(res.error)
      }
    })
  }

  const source = deal ? DEAL_SOURCE[deal.source] : DEAL_SOURCE.manual
  const SourceIcon = source.icon

  return (
    <Modal onClose={onClose} variant="right">
      <div className="flex h-[100dvh] w-[min(760px,100vw)] flex-col overflow-hidden bg-white shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Шапка */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <h2 className="text-base font-bold text-gray-900">
              {isNew ? 'Новая сделка' : 'Сделка'}
            </h2>
            {!isNew && (
              <span
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                style={{ color: source.color, background: source.bg }}
              >
                <SourceIcon size={11} />
                {source.label}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        {/* Тело */}
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5 scroll-hidden">
          <div className="space-y-1.5">
            <Label>Название</Label>
            <Input
              autoFocus
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Например: Игра 15 августа — 2 участника"
              maxLength={300}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Этап</Label>
              <Select value={form.stage_id} onValueChange={(v) => set('stage_id', v as string)}>
                {/* Base UI Select без children показывает сырой value (UUID) —
                    имя этапа рендерим явно. */}
                <SelectTrigger>
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: stages.find((s) => s.id === form.stage_id)?.color ?? '#d1d5db' }}
                        aria-hidden
                      />
                      {stages.find((s) => s.id === form.stage_id)?.name ?? 'Выберите этап'}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: s.color }}
                          aria-hidden
                        />
                        {s.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Ответственный</Label>
              <Select
                value={form.responsible_employee_id || 'none'}
                onValueChange={(v) => set('responsible_employee_id', v === 'none' ? '' : (v as string))}
              >
                <SelectTrigger>
                  <SelectValue>
                    {employees.find((e) => e.id === form.responsible_employee_id)?.name ?? 'Не назначен'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Не назначен</SelectItem>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
            <div className="space-y-1.5">
              <Label>Сумма</Label>
              <Input
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="Пока не известна"
                inputMode="decimal"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Валюта</Label>
              <Select
                value={form.currency}
                onValueChange={(v) => set('currency', v as DealCurrency)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEAL_CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Клиент</Label>
              <Input
                value={form.customer_name}
                onChange={(e) => set('customer_name', e.target.value)}
                placeholder="Имя"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Телефон</Label>
              <Input
                value={form.customer_phone}
                onChange={(e) => set('customer_phone', e.target.value)}
                placeholder="996…"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Ник</Label>
              <Input
                value={form.customer_username}
                onChange={(e) => set('customer_username', e.target.value)}
                placeholder="@username"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[180px_1fr]">
            <div className="space-y-1.5">
              <Label>Город</Label>
              <Input
                value={form.city}
                onChange={(e) => set('city', e.target.value)}
                placeholder="Бишкек"
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Адрес</Label>
              <Input
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                placeholder="Улица, дом, квартира"
                maxLength={500}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Заметка</Label>
            <Textarea
              value={form.note}
              onChange={(e) => set('note', e.target.value)}
              placeholder="Что обсудили, о чём договорились…"
              rows={3}
            />
          </div>

          {/* Переписка — только чтение, вести её продолжают там, где начали */}
          {!isNew && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <MessagesSquare size={14} className="text-gray-400" />
                <Label>Переписка</Label>
              </div>
              {messages === null ? (
                <p className="text-[12px] text-gray-400">Загружаем диалог…</p>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 px-4 py-5 text-center text-[12px] text-gray-400">
                  <span>{chatNote ?? 'Переписки нет'}</span>
                  {chatNote?.includes('Повторить') && (
                    <button
                      type="button"
                      onClick={() => {
                        setMessages(null)
                        setChatNote(null)
                        setConversationReload((value) => value + 1)
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#f3e9f8] px-3 py-1.5 font-semibold text-[#430c61] transition-colors hover:bg-[#e7d6f2]"
                    >
                      <RefreshCw size={13} />
                      Повторить
                    </button>
                  )}
                </div>
              ) : (
                <div className="max-h-[42vh] space-y-1.5 overflow-y-auto rounded-xl bg-gray-50/70 p-3 scroll-hidden">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={cn(
                        'max-w-[85%] rounded-xl px-3 py-1.5 text-[12px] leading-snug whitespace-pre-wrap',
                        m.direction === 'in'
                          ? 'bg-white text-gray-700 shadow-sm'
                          : 'ml-auto text-white brand-gradient'
                      )}
                    >
                      {m.direction === 'out' && (m.sender === 'bot' || m.sender === 'operator') && (
                        <span className="mb-0.5 block text-[10px] font-semibold opacity-80">
                          {m.sender === 'bot' ? '🤖 Бот' : '👤 Менеджер'}
                        </span>
                      )}
                      <ChatMessageContent text={m.text} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Низ */}
        <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-6 py-4">
          {!isNew && me.role === 'owner' ? (
            <button
              onClick={handleDelete}
              disabled={isPending}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-gray-400 transition-colors hover:bg-[#f3e9f8] hover:text-[#430c61] disabled:opacity-50"
            >
              <Trash2 size={15} />
              Удалить
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={isPending}>
              Отмена
            </Button>
            <Button onClick={handleSave} disabled={isPending}>
              {isPending ? 'Сохраняем…' : isNew ? 'Создать' : 'Сохранить'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
