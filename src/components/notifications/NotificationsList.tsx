'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Bell, Check, CheckCheck } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { getNotifications, markAllNotificationsRead, markNotificationRead } from '@/actions/notifications'
import { NOTIFICATION_TYPE_MAP } from '@/lib/constants'
import type { Notification } from '@/types'

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function NotificationsList({
  initialItems,
  initialFilter,
}: {
  initialItems: Notification[]
  initialFilter: 'all' | 'important'
}) {
  const [items, setItems] = useState(initialItems)
  const [isPending, startTransition] = useTransition()
  const { user } = useAuth()
  const router = useRouter()

  // Раньше — Supabase Realtime-подписка на INSERT в notifications; на
  // Postgres без Realtime — поллинг всего списка под текущий фильтр.
  useEffect(() => {
    if (!user?.id) return
    const interval = setInterval(() => {
      getNotifications(initialFilter).then(setItems)
    }, 8000)
    return () => clearInterval(interval)
  }, [user?.id, initialFilter])

  const unreadCount = items.filter(n => !n.is_read).length

  function handleMarkRead(id: string) {
    setItems(prev => prev.map(n => (n.id === id ? { ...n, is_read: true } : n)))
    startTransition(() => { markNotificationRead(id) })
  }

  function handleMarkAllRead() {
    setItems(prev => prev.map(n => ({ ...n, is_read: true })))
    startTransition(() => { markAllNotificationsRead() })
  }

  function setFilter(filter: 'all' | 'important') {
    router.push(filter === 'important' ? '/dashboard/notifications?filter=important' : '/dashboard/notifications')
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-semibold flex items-center gap-2" style={{ fontSize: 18, color: '#1b1517' }}>
          <Bell style={{ width: 18, height: 18 }} />
          Уведомления
          {unreadCount > 0 && (
            <span style={{ fontSize: 12, color: '#7d7174', fontWeight: 400 }}>
              · {unreadCount} непрочитанных
            </span>
          )}
        </h1>
        <button
          onClick={handleMarkAllRead}
          disabled={isPending || unreadCount === 0}
          className="flex items-center gap-1.5 rounded-md transition-colors disabled:opacity-40"
          style={{ fontSize: 12, color: '#430c61', padding: '6px 10px' }}
        >
          <CheckCheck style={{ width: 14, height: 14 }} />
          Прочитать всё
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setFilter('all')}
          className="rounded-md transition-colors"
          style={{
            fontSize: 12, padding: '6px 12px',
            backgroundColor: initialFilter === 'all' ? '#430c61' : '#fdfbfb',
            color: initialFilter === 'all' ? '#fff' : '#6b7280',
          }}
        >
          Все
        </button>
        <button
          onClick={() => setFilter('important')}
          className="rounded-md transition-colors"
          style={{
            fontSize: 12, padding: '6px 12px',
            backgroundColor: initialFilter === 'important' ? '#430c61' : '#fdfbfb',
            color: initialFilter === 'important' ? '#fff' : '#6b7280',
          }}
        >
          Важные
        </button>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-12" style={{ color: '#7d7174', fontSize: 13 }}>
          Уведомлений нет
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((n) => {
            const meta = NOTIFICATION_TYPE_MAP[n.type] ?? NOTIFICATION_TYPE_MAP.system
            const content = (
              <div
                className="flex items-start gap-3 rounded-lg transition-colors"
                style={{
                  padding: '12px 14px',
                  backgroundColor: n.is_read ? '#ffffff' : '#fdfbfb',
                  border: '1px solid #ebebee',
                }}
              >
                <span
                  className="flex items-center justify-center rounded-full flex-shrink-0"
                  style={{ width: 28, height: 28, backgroundColor: meta.bg, fontSize: 13 }}
                >
                  {meta.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium" style={{ fontSize: 13, color: '#1b1517' }}>
                      {n.title}
                    </span>
                    {!n.is_read && (
                      <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, backgroundColor: '#430c61' }} />
                    )}
                  </div>
                  {n.body && (
                    <p style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{n.body}</p>
                  )}
                  <span style={{ fontSize: 11, color: '#7d7174' }}>{formatDateTime(n.created_at)}</span>
                </div>
                {!n.is_read && (
                  <button
                    onClick={(e) => { e.preventDefault(); handleMarkRead(n.id) }}
                    title="Отметить прочитанным"
                    className="flex items-center justify-center rounded-md flex-shrink-0"
                    style={{ width: 24, height: 24, color: '#7d7174' }}
                  >
                    <Check style={{ width: 14, height: 14 }} />
                  </button>
                )}
              </div>
            )
            return n.action_url ? (
              <Link key={n.id} href={n.action_url} onClick={() => handleMarkRead(n.id)}>
                {content}
              </Link>
            ) : (
              <div key={n.id}>{content}</div>
            )
          })}
        </div>
      )}
    </div>
  )
}
