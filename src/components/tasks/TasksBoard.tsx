'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, UserRound, Users } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type {
  TaskWithRelations,
  TaskEmployee,
  TaskStatus,
  TaskViewer,
} from '@/types'
import { getTasksData, moveTask } from '@/actions/tasks'
import { TASK_COLUMNS } from './task-config'
import TaskCard from './TaskCard'
import TaskModal from './TaskModal'

interface Props {
  initialTasks: TaskWithRelations[]
  employees: TaskEmployee[]
  departments: { id: string; name: string }[]
  me: TaskViewer
}

interface DragOver {
  col: TaskStatus
  beforeId: string | null
}

interface ModalState {
  open: boolean
  task: TaskWithRelations | null
  isNew: boolean
  defaultStatus?: TaskStatus
}

const byPosition = (a: TaskWithRelations, b: TaskWithRelations) =>
  a.position - b.position || a.created_at.localeCompare(b.created_at)

export default function TasksBoard({ initialTasks, employees, departments, me }: Props) {
  const [tasks, setTasks] = useState<TaskWithRelations[]>(initialTasks)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<DragOver | null>(null)
  const [search, setSearch] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [modal, setModal] = useState<ModalState>({ open: false, task: null, isNew: false })

  const dragIdRef = useRef<string | null>(null)
  dragIdRef.current = dragId

  const employeeMap = useMemo(() => {
    const m = new Map<string, TaskEmployee>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])

  // ─── Обновление: живое обновление у всех открытых пользователей ───────────
  // Раньше — Supabase Realtime-подписка на tasks; на Postgres без Realtime —
  // поллинг, с той же защитой от сбоя текущего перетаскивания.
  const refresh = useCallback(async () => {
    const data = await getTasksData()
    setTasks(data.tasks)
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      if (dragIdRef.current) return
      refresh()
    }, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  // ─── Фильтрация ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tasks.filter((t) => {
      if (onlyMine && t.assignee_id !== me.id && t.created_by !== me.id) return false
      if (q) {
        const hay = `${t.title} ${t.description ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [tasks, search, onlyMine, me.id])

  const columns = useMemo(() => {
    const map = new Map<TaskStatus, TaskWithRelations[]>()
    for (const c of TASK_COLUMNS) map.set(c.key, [])
    for (const t of filtered) map.get(t.status)?.push(t)
    for (const c of TASK_COLUMNS) map.get(c.key)!.sort(byPosition)
    return map
  }, [filtered])

  // ─── Перетаскивание ──────────────────────────────────────────────────────
  const endDrag = () => {
    setDragId(null)
    setDragOver(null)
  }

  const performDrop = async (toStatus: TaskStatus) => {
    const id = dragId
    const over = dragOver
    endDrag()
    if (!id) return

    const moving = tasks.find((t) => t.id === id)
    if (!moving) return

    const beforeId = over?.col === toStatus ? over.beforeId : null

    // Целевая колонка без перемещаемой задачи, по порядку.
    const dest = tasks
      .filter((t) => t.status === toStatus && t.id !== id)
      .sort(byPosition)

    let insertAt = dest.length
    if (beforeId) {
      const i = dest.findIndex((t) => t.id === beforeId)
      if (i !== -1) insertAt = i
    }
    dest.splice(insertAt, 0, moving)
    const destIds = dest.map((t) => t.id)

    // Ничего не изменилось — та же колонка, та же позиция.
    const prevOrder = tasks
      .filter((t) => t.status === toStatus)
      .sort(byPosition)
      .map((t) => t.id)
    if (moving.status === toStatus && prevOrder.join() === destIds.join()) return

    // Оптимистичное обновление.
    const posInDest = new Map(destIds.map((tid, i) => [tid, i]))
    const snapshot = tasks
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === id) return { ...t, status: toStatus, position: posInDest.get(id)! }
        if (posInDest.has(t.id)) return { ...t, position: posInDest.get(t.id)! }
        return t
      })
    )

    const res = await moveTask(id, toStatus, destIds)
    if (!res.success) {
      toast.error(res.error)
      setTasks(snapshot) // откат
    }
  }

  const openNew = (status?: TaskStatus) =>
    setModal({ open: true, task: null, isNew: true, defaultStatus: status })
  const openEdit = (task: TaskWithRelations) =>
    setModal({ open: true, task, isNew: false })
  const closeModal = () => setModal((m) => ({ ...m, open: false }))

  const total = tasks.length

  return (
    <div className="flex h-[calc(100vh-52px)] flex-col">
      {/* Заголовок и панель */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Задачи</h1>
          <p className="mt-0.5 text-[13px] text-gray-400">
            {me.role === 'owner'
              ? `Все задачи компании · ${total}`
              : `Доска задач · ${total}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск…"
              className="h-9 w-44 rounded-xl border border-gray-200 bg-white/80 pl-8 pr-3 text-[13px] outline-none transition-colors focus:border-gray-300"
            />
          </div>

          <button
            onClick={() => setOnlyMine((v) => !v)}
            className={cn(
              'flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[13px] font-medium transition-colors',
              onlyMine
                ? 'border-transparent text-white brand-gradient'
                : 'border-gray-200 bg-white/80 text-gray-600 hover:bg-gray-50'
            )}
            title="Показать только мои задачи"
          >
            {onlyMine ? <UserRound size={15} /> : <Users size={15} />}
            {onlyMine ? 'Мои' : 'Все'}
          </button>

          <button
            onClick={() => openNew()}
            className="flex h-9 items-center gap-1.5 rounded-xl px-4 text-[13px] font-semibold text-white brand-gradient brand-shadow transition-transform hover:-translate-y-0.5"
          >
            <Plus size={16} />
            Новая задача
          </button>
        </div>
      </div>

      {/* Доска */}
      <div className="flex flex-1 gap-4 overflow-x-auto px-6 pb-6 scroll-hidden">
        {TASK_COLUMNS.map((col) => {
          const list = columns.get(col.key) ?? []
          const isTarget = dragOver?.col === col.key
          return (
            <div
              key={col.key}
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault()
                setDragOver({ col: col.key, beforeId: null })
              }}
              onDrop={(e) => {
                e.preventDefault()
                void performDrop(col.key)
              }}
              className={cn(
                'flex w-[300px] shrink-0 flex-col rounded-2xl border transition-colors',
                isTarget && dragId
                  ? 'border-[#cdb8e8] bg-[#f3e9f8]/60'
                  : 'border-gray-100 bg-gray-50/60'
              )}
            >
              {/* Заголовок колонки */}
              <div className="flex items-center justify-between px-3 py-3">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: col.accent }} />
                  <span className="text-[13px] font-semibold text-gray-700">{col.label}</span>
                  <span
                    className="rounded-full px-1.5 text-[11px] font-semibold"
                    style={{ color: col.accent, background: col.soft }}
                  >
                    {list.length}
                  </span>
                </div>
                <button
                  onClick={() => openNew(col.key)}
                  className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-white hover:text-gray-600"
                  title="Добавить в колонку"
                >
                  <Plus size={15} />
                </button>
              </div>

              {/* Карточки */}
              <div className="flex-1 space-y-2 overflow-y-auto px-2.5 pb-3 scroll-hidden">
                {list.map((task) => (
                  <div
                    key={task.id}
                    onDragOver={(e) => {
                      if (!dragId) return
                      e.preventDefault()
                      e.stopPropagation()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const before = e.clientY < rect.top + rect.height / 2
                      const idx = list.findIndex((t) => t.id === task.id)
                      const beforeId = before ? task.id : (list[idx + 1]?.id ?? null)
                      setDragOver({ col: col.key, beforeId })
                    }}
                  >
                    {dragId && isTarget && dragOver?.beforeId === task.id && (
                      <div className="mb-2 h-[3px] rounded-full bg-[#430c61]" />
                    )}
                    <TaskCard
                      task={task}
                      employees={employeeMap}
                      dragging={dragId === task.id}
                      onDragStart={() => setDragId(task.id)}
                      onDragEnd={endDrag}
                      onClick={() => openEdit(task)}
                    />
                  </div>
                ))}

                {/* Плейсхолдер в конце / пустая колонка */}
                {dragId && isTarget && dragOver?.beforeId === null && (
                  <div className="h-[3px] rounded-full bg-[#430c61]" />
                )}
                {list.length === 0 && !dragId && (
                  <button
                    onClick={() => openNew(col.key)}
                    className="w-full rounded-xl border border-dashed border-gray-200 py-6 text-center text-[12px] text-gray-400 transition-colors hover:border-gray-300 hover:text-gray-500"
                  >
                    Пусто — добавить задачу
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {modal.open && (
        <TaskModal
          task={modal.task}
          isNew={modal.isNew}
          defaultStatus={modal.defaultStatus}
          employees={employees}
          departments={departments}
          me={me}
          onClose={closeModal}
          onSaved={refresh}
        />
      )}
    </div>
  )
}
