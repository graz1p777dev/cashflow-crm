'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { Plus, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { formatMoney } from '@/lib/formatters'
import type { Deal, DealEmployee, DealStage, DealViewer } from '@/types'
import { getDealsData, moveDeal } from '@/actions/deals'
import { stageSoft } from './deal-config'
import DealCard from './DealCard'
import DealModal from './DealModal'

interface Props {
  initialStages: DealStage[]
  initialDeals: Deal[]
  employees: DealEmployee[]
  me: DealViewer
}

interface ModalState {
  open: boolean
  deal: Deal | null
  isNew: boolean
  stageId: string
}

/** Итог колонки: сумма по валютам, поэтому не одно число, а несколько. */
function columnTotals(deals: Deal[]): string[] {
  const byCurrency = new Map<string, number>()
  for (const d of deals) {
    if (d.amount === null) continue
    byCurrency.set(d.currency, (byCurrency.get(d.currency) ?? 0) + Number(d.amount))
  }
  return [...byCurrency.entries()].map(([currency, sum]) => formatMoney(sum, currency))
}

export default function DealsBoard({ initialStages, initialDeals, employees, me }: Props) {
  const [deals, setDeals] = useState<Deal[]>(initialDeals)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState<ModalState>({
    open: false, deal: null, isNew: false, stageId: '',
  })
  const [refreshing, startRefresh] = useTransition()

  const stages = initialStages
  const defaultStageId = useMemo(
    () => stages.find((s) => s.is_default)?.id ?? stages[0]?.id ?? '',
    [stages]
  )

  // Realtime-подписка живёт вне рендера, а знать о текущем перетаскивании ей
  // нужно — держим id и в состоянии (для отрисовки), и в ref (для колбэка).
  const dragIdRef = useRef<string | null>(null)
  const beginDrag = (id: string) => {
    dragIdRef.current = id
    setDragId(id)
  }

  const employeeMap = useMemo(() => {
    const m = new Map<string, DealEmployee>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])

  const refresh = useCallback(async () => {
    const data = await getDealsData()
    setDeals(data.deals)
  }, [])

  // ─── Обновление ──────────────────────────────────────────────────────────
  // Раньше — Supabase Realtime-подписка на deals; на Postgres без Realtime —
  // поллинг, с той же защитой от сбоя текущего перетаскивания.
  useEffect(() => {
    const interval = setInterval(() => {
      if (dragIdRef.current) return
      refresh()
    }, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  // ─── Фильтрация и раскладка по колонкам ────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return deals
    return deals.filter((d) =>
      `${d.title} ${d.customer_name ?? ''} ${d.customer_phone ?? ''} ${d.customer_username ?? ''} ${d.city ?? ''} ${d.address ?? ''}`
        .toLowerCase()
        .includes(q)
    )
  }, [deals, search])

  const columns = useMemo(() => {
    const map = new Map<string, Deal[]>()
    for (const s of stages) map.set(s.id, [])
    for (const d of filtered) map.get(d.stage_id)?.push(d)
    return map
  }, [filtered, stages])

  // ─── Перетаскивание ────────────────────────────────────────────────────────
  const endDrag = () => {
    dragIdRef.current = null
    setDragId(null)
    setDragOverStage(null)
  }

  const performDrop = async (toStageId: string) => {
    const id = dragId
    endDrag()
    if (!id) return

    const moving = deals.find((d) => d.id === id)
    if (!moving || moving.stage_id === toStageId) return

    const snapshot = deals
    const movedAt = new Date().toISOString()
    setDeals((prev) =>
      prev.map((d) => (d.id === id ? { ...d, stage_id: toStageId, stage_changed_at: movedAt } : d))
    )

    const res = await moveDeal(id, toStageId)
    if (!res.success) {
      toast.error(res.error)
      setDeals(snapshot) // откат
    }
  }

  const openNew = (stageId: string) =>
    setModal({ open: true, deal: null, isNew: true, stageId })
  const openEdit = (deal: Deal) =>
    setModal({ open: true, deal, isNew: false, stageId: deal.stage_id })
  const closeModal = () => setModal((m) => ({ ...m, open: false }))

  return (
    <div className="flex h-[calc(100vh-52px)] flex-col">
      {/* Заголовок и панель */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div>
          <p className="kicker">Воронка продаж</p>
          <h1 className="block-title">Сделки</h1>
          <span className="span-rule" aria-hidden />
          <p className="mt-1.5 text-[13px] text-gray-400">
            {me.role === 'owner' || me.role === 'rop'
              ? `Все сделки магазина · ${deals.length}`
              : `Ваши сделки · ${deals.length}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Клиент, телефон, название…"
              className="h-9 w-56 rounded-xl border border-gray-200 bg-white/80 pl-8 pr-3 text-[13px] outline-none transition-colors focus:border-gray-300"
            />
          </div>

          <button
            onClick={() => startRefresh(refresh)}
            disabled={refreshing}
            className="flex h-9 items-center gap-1.5 rounded-xl border border-gray-200 bg-white/80 px-3 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-60"
            title="Перечитать сделки"
          >
            <RefreshCw size={15} className={cn(refreshing && 'animate-spin')} />
            Обновить
          </button>

          <button
            onClick={() => openNew(defaultStageId)}
            className="flex h-9 items-center gap-1.5 rounded-xl px-4 text-[13px] font-semibold text-white brand-gradient brand-shadow transition-transform hover:-translate-y-0.5"
          >
            <Plus size={16} />
            Создать сделку
          </button>
        </div>
      </div>

      {/* Доска */}
      <div className="flex flex-1 gap-4 overflow-x-auto px-6 pb-6 scroll-hidden">
        {stages.map((stage) => {
          const list = columns.get(stage.id) ?? []
          const totals = columnTotals(list)
          const isTarget = dragOverStage === stage.id
          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault()
                setDragOverStage(stage.id)
              }}
              onDrop={(e) => {
                e.preventDefault()
                void performDrop(stage.id)
              }}
              className={cn(
                'flex w-[290px] shrink-0 flex-col rounded-2xl border transition-colors',
                isTarget && dragId
                  ? 'border-[#cdb8e8] bg-[#f3e9f8]/60'
                  : 'border-gray-100 bg-gray-50/60'
              )}
            >
              {/* Заголовок колонки */}
              <div className="px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: stage.color }}
                    />
                    <span className="truncate text-[13px] font-semibold text-gray-700">
                      {stage.name}
                    </span>
                    <span
                      className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold"
                      style={{ color: stage.color, background: stageSoft(stage.color) }}
                    >
                      {list.length}
                    </span>
                  </div>
                  <button
                    onClick={() => openNew(stage.id)}
                    className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-white hover:text-gray-600"
                    title="Добавить в этап"
                  >
                    <Plus size={15} />
                  </button>
                </div>
                <p className="mt-1 truncate text-[11px] text-gray-400">
                  {totals.length ? totals.join(' · ') : 'Без суммы'}
                </p>
              </div>

              {/* Карточки */}
              <div className="flex-1 space-y-2 overflow-y-auto px-2.5 pb-3 scroll-hidden">
                {list.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    employees={employeeMap}
                    stageColor={stage.color}
                    dragging={dragId === deal.id}
                    onDragStart={() => beginDrag(deal.id)}
                    onDragEnd={endDrag}
                    onClick={() => openEdit(deal)}
                  />
                ))}

                {dragId && isTarget && <div className="h-[3px] rounded-full bg-[#430c61]" />}

                {list.length === 0 && !dragId && (
                  <button
                    onClick={() => openNew(stage.id)}
                    className="w-full rounded-xl border border-dashed border-gray-200 py-6 text-center text-[12px] text-gray-400 transition-colors hover:border-gray-300 hover:text-gray-500"
                  >
                    Пусто — добавить сделку
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {modal.open && (
        <DealModal
          deal={modal.deal}
          isNew={modal.isNew}
          defaultStageId={modal.stageId || defaultStageId}
          stages={stages}
          employees={employees}
          me={me}
          onClose={closeModal}
          onSaved={refresh}
        />
      )}
    </div>
  )
}
