'use client'
import { useState } from 'react'
import type { LiveFeedItem } from '@/types'
import { STATUS_AFTER_FV_MAP, ACTUAL_STATUS_MAP, CONSULTATION_STATUS_MAP } from '@/lib/constants'
import { formatTime, formatMoney } from '@/lib/formatters'
import { Activity } from 'lucide-react'
import EmptyState from '@/components/common/EmptyState'

interface LiveFeedProps {
  initialItems: LiveFeedItem[]
  dateStr: string
  employeeId?: string
}

function getStatusStyle(status: LiveFeedItem['status']): { label: string; color: string; bg: string } {
  if (!status) return { label: '—', color: '#7d7174', bg: '#fdfbfb' }
  if (status in STATUS_AFTER_FV_MAP) return STATUS_AFTER_FV_MAP[status as keyof typeof STATUS_AFTER_FV_MAP]
  if (status in ACTUAL_STATUS_MAP) return ACTUAL_STATUS_MAP[status as keyof typeof ACTUAL_STATUS_MAP]
  if (status in CONSULTATION_STATUS_MAP) return CONSULTATION_STATUS_MAP[status as keyof typeof CONSULTATION_STATUS_MAP]
  return { label: status, color: '#7d7174', bg: '#fdfbfb' }
}

function FeedRow({ item, isNew }: { item: LiveFeedItem; isNew?: boolean }) {
  const style = getStatusStyle(item.status)
  return (
    <div
      className="flex items-start gap-3 py-2.5"
      style={{
        borderBottom: '1px solid #faf8f7',
        animation: isNew ? 'feedIn 0.2s ease-out' : undefined,
      }}
    >
      {/* Цветная точка */}
      <div
        className="rounded-full flex-shrink-0 mt-1"
        style={{ width: 7, height: 7, backgroundColor: style.color }}
      />
      {/* Данные */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="font-medium truncate"
            style={{ fontSize: 13, color: '#1b1517', maxWidth: 140 }}
          >
            {item.client_name}
          </span>
          <span
            className="rounded-md px-1.5 py-0.5 font-medium flex-shrink-0"
            style={{ fontSize: 10, color: style.color, backgroundColor: style.bg }}
          >
            {style.label}
          </span>
          {item.is_nv && (
            <span
              className="rounded-md px-1.5 py-0.5 font-medium flex-shrink-0"
              style={{ fontSize: 10, color: '#430c61', backgroundColor: '#fdfbfb' }}
            >
              НВ
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span style={{ fontSize: 11, color: '#7d7174' }}>{item.manager_name}</span>
          {item.amount > 0 && (
            <>
              <span style={{ color: '#ece5e5' }}>·</span>
              <span
                className="tabular-nums font-medium"
                style={{ fontSize: 11, color: '#15803d' }}
              >
                {formatMoney(item.amount)}
              </span>
            </>
          )}
        </div>
      </div>
      {/* Время */}
      <span
        className="flex-shrink-0 tabular-nums"
        style={{ fontSize: 11, color: '#7d7174' }}
      >
        {formatTime(item.time)}
      </span>
    </div>
  )
}

// Раньше эта лента обновлялась вживую через Supabase Realtime на INSERT в
// consultations (модуль Sprint 4, не принят — см. CLAUDE.md). На Postgress
// без Realtime строить под неиспользуемый модуль новую инфраструктуру не
// стали: лента остаётся статичной с initialItems, обновляется при
// перезагрузке страницы.
export default function LiveFeed({ initialItems }: LiveFeedProps) {
  const [items] = useState<LiveFeedItem[]>(initialItems)
  const newIds: Set<string> = new Set()

  if (items.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={Activity}
        title="Записей на сегодня нет"
        hint="Лента обновляется сама — новые события появятся здесь."
      />
    )
  }

  return (
    <>
      <style>{`
        @keyframes feedIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div
        className="rounded-xl overflow-hidden glass"
        style={{ maxHeight: 320, overflowY: 'auto' }}
      >
        <div className="px-4">
          {items.map(item => (
            <FeedRow key={item.id} item={item} isNew={newIds.has(item.id)} />
          ))}
        </div>
      </div>
    </>
  )
}
