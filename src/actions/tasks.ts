'use server'

// Доска задач (supabase/migrations/032_tasks.sql).
//
// ─── Про видимость ───────────────────────────────────────────────────────────
// Кто видит задачу, решала RLS-политика tasks_select через can_see_task().
// RLS вместе с Supabase ушла (db/schema.sql, DECISION 1), но Phase 1 сохранила
// сам предикат обычной SQL-функцией с явным зрителем:
//   can_see_task(p_user_id, visibility, department_id, created_by, assignee, id)
// Поэтому он подставляется прямо в WHERE — правило остаётся одно и то же и
// продолжает жить в БД, а не переписывается на TypeScript.
//
// Тот же предикат стоит в UPDATE (политика tasks_update разрешала править
// всем, кто видит), а в DELETE — более узкое «автор или owner» из tasks_delete.
// Без них любой сотрудник мог бы двигать и удалять чужие задачи по прямому id.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { query, queryOne, transaction } from '@/lib/db'
import { getActor } from '@/lib/auth/actor'
import type {
  TaskStatus,
  TaskWithRelations,
  TaskEmployee,
  TaskViewer,
} from '@/types'

// ─── Результат действия ──────────────────────────────────────────────────────

export type ActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string }

// ─── Текущий сотрудник ───────────────────────────────────────────────────────

/**
 * Заменяет прежнюю пару getSession() + SELECT ... FROM employees.
 *
 * Как и в src/actions/deals.ts, getActor() учитывает impersonation: владелец
 * «от имени» сотрудника видит его доску, а не свою.
 */
async function getViewer(): Promise<TaskViewer | null> {
  const actor = await getActor()
  if (!actor || !actor.employeeId) return null
  return {
    id: actor.employeeId,
    role: actor.role,
    department_id: actor.departmentId,
    name: actor.name ?? '',
  }
}

// can_see_task() принимает users.id; при impersonation действующее лицо —
// другой сотрудник, поэтому user_id берём по employees.id зрителя.
const VIEWER_USER_ID = `(SELECT e.user_id FROM public.employees e WHERE e.id = $1)`

const CAN_SEE_TASK = `public.can_see_task(
  ${VIEWER_USER_ID}, t.visibility, t.department_id, t.created_by, t.assignee_id, t.id
)`

// ─── Данные для доски ────────────────────────────────────────────────────────

export interface TasksData {
  tasks: TaskWithRelations[]
  employees: TaskEmployee[]
  departments: { id: string; name: string }[]
  me: TaskViewer | null
}

export async function getTasksData(): Promise<TasksData> {
  const me = await getViewer()
  if (!me) return { tasks: [], employees: [], departments: [], me: null }

  const [tasks, members, employees, departments] = await Promise.all([
    query<TaskWithRelations>(
      `SELECT t.*
         FROM public.tasks t
        WHERE ${CAN_SEE_TASK}
        ORDER BY t.position ASC, t.created_at DESC`,
      [me.id],
    ),
    // task_members видны по тем же задачам, что и сами задачи
    // (task_members_select смотрел на существование задачи).
    query<{ task_id: string; employee_id: string }>(
      `SELECT m.task_id, m.employee_id
         FROM public.task_members m
         JOIN public.tasks t ON t.id = m.task_id
        WHERE ${CAN_SEE_TASK}`,
      [me.id],
    ),
    // Сотрудники и отделы — для пикеров и аватаров. Раньше шли через
    // service-role клиент в обход RLS; отдельного клиента больше нет.
    query<TaskEmployee>(
      `SELECT id, name, role, department_id, avatar_url
         FROM public.employees
        WHERE deleted_at IS NULL
        ORDER BY name`,
    ),
    query<{ id: string; name: string }>(
      `SELECT id, name FROM public.departments
        WHERE is_active = TRUE
        ORDER BY name`,
    ),
  ])

  const membersByTask = new Map<string, string[]>()
  for (const m of members) {
    const arr = membersByTask.get(m.task_id) ?? []
    arr.push(m.employee_id)
    membersByTask.set(m.task_id, arr)
  }

  const withRel: TaskWithRelations[] = tasks.map((t) => ({
    ...t,
    members: membersByTask.get(t.id) ?? [],
  }))

  return { tasks: withRel, employees, departments, me }
}

// ─── Схема формы ─────────────────────────────────────────────────────────────

const TaskSchema = z.object({
  title: z.string().trim().min(1, 'Название обязательно').max(300, 'Слишком длинное название'),
  description: z.string().nullable().optional(),
  status: z.enum(['todo', 'in_progress', 'review', 'done']).default('todo'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  visibility: z.enum(['all', 'department', 'private']).default('all'),
  assignee_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  due_date: z.string().nullable().optional(),
  member_ids: z.array(z.string().uuid()).default([]),
})

export type TaskFormData = z.input<typeof TaskSchema>

// ─── Создание ────────────────────────────────────────────────────────────────

export async function createTask(input: TaskFormData): Promise<ActionResult<{ id: string }>> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const parsed = TaskSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const d = parsed.data

  // Для видимости «отдел» привязываем задачу к отделу (по умолчанию — отдел автора).
  const department_id =
    d.visibility === 'department' ? (d.department_id ?? me.department_id ?? null) : null

  const memberIds = d.member_ids.filter((id) => id !== me.id && id !== d.assignee_id)

  try {
    // Задача и её участники — одной транзакцией. Раньше это были два
    // независимых запроса, и сбой на втором оставлял приватную задачу без
    // участников: видел бы её только автор.
    const created = await transaction(async (client) => {
      // Позиция — в конец выбранной колонки. Считается тем же запросом, что и
      // вставка: отдельный SELECT ... ORDER BY position DESC мог разойтись с
      // вставкой при двух одновременных созданиях.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.tasks
           (title, description, status, priority, visibility,
            assignee_id, department_id, due_date, created_by, position)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9,
                COALESCE(MAX(t.position), -1) + 1
           FROM public.tasks t
          WHERE t.status = $3
         RETURNING id`,
        [
          d.title,
          d.description?.trim() || null,
          d.status,
          d.priority,
          d.visibility,
          d.assignee_id ?? null,
          department_id,
          d.due_date || null,
          me.id,
        ],
      )
      const row = inserted.rows[0]
      if (!row) throw new Error('Не удалось создать задачу')

      if (d.visibility === 'private' && memberIds.length) {
        await client.query(
          `INSERT INTO public.task_members (task_id, employee_id)
           SELECT $1, employee_id FROM unnest($2::uuid[]) AS employee_id`,
          [row.id, memberIds],
        )
      }

      return row
    })

    revalidatePath('/dashboard/tasks')
    return { success: true, data: { id: created.id } }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось создать задачу' }
  }
}

// ─── Редактирование ──────────────────────────────────────────────────────────

export async function updateTask(id: string, input: TaskFormData): Promise<ActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const parsed = TaskSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const d = parsed.data

  const existing = await queryOne<{ created_by: string | null; visibility: string }>(
    `SELECT t.created_by, t.visibility
       FROM public.tasks t
      WHERE t.id = $2 AND ${CAN_SEE_TASK}
      LIMIT 1`,
    [me.id, id],
  )
  if (!existing) return { success: false, error: 'Задача не найдена или недоступна' }

  // Видимость и состав участников меняет только автор или owner.
  const canManage = me.role === 'owner' || existing.created_by === me.id
  const visibility = canManage ? d.visibility : (existing.visibility as typeof d.visibility)
  const department_id =
    visibility === 'department' ? (d.department_id ?? me.department_id ?? null) : null

  const memberIds = d.member_ids.filter((mid) => mid !== me.id && mid !== d.assignee_id)

  try {
    const ok = await transaction(async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE public.tasks AS t
            SET title = $3, description = $4, status = $5, priority = $6,
                assignee_id = $7, due_date = $8, visibility = $9, department_id = $10
          WHERE t.id = $2 AND ${CAN_SEE_TASK}
          RETURNING t.id`,
        [
          me.id,
          id,
          d.title,
          d.description?.trim() || null,
          d.status,
          d.priority,
          d.assignee_id ?? null,
          d.due_date || null,
          visibility,
          department_id,
        ],
      )
      if (updated.rowCount === 0) return false

      if (canManage) {
        // Состав участников пересобирается целиком, как и раньше.
        await client.query('DELETE FROM public.task_members WHERE task_id = $1', [id])
        if (visibility === 'private' && memberIds.length) {
          await client.query(
            `INSERT INTO public.task_members (task_id, employee_id)
             SELECT $1, employee_id FROM unnest($2::uuid[]) AS employee_id`,
            [id, memberIds],
          )
        }
      }
      return true
    })

    if (!ok) return { success: false, error: 'Недостаточно прав' }

    revalidatePath('/dashboard/tasks')
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось сохранить задачу' }
  }
}

// ─── Перемещение / переупорядочивание ────────────────────────────────────────

export async function moveTask(
  taskId: string,
  toStatus: TaskStatus,
  orderedIds: string[]
): Promise<ActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  try {
    const ok = await transaction(async (client) => {
      const moved = await client.query<{ id: string }>(
        `UPDATE public.tasks AS t
            SET status = $3
          WHERE t.id = $2 AND ${CAN_SEE_TASK}
          RETURNING t.id`,
        [me.id, taskId, toStatus],
      )
      if (moved.rowCount === 0) return false

      // Пересобираем позиции в целевой колонке. Раньше это была пачка
      // параллельных UPDATE'ов: при сбое середины колонка оставалась с
      // перемешанными позициями. Здесь — один запрос в той же транзакции,
      // что и сам перенос, порядок задаёт позиция id в массиве.
      if (orderedIds.length) {
        await client.query(
          `UPDATE public.tasks AS t
              SET position = ord.idx - 1
             FROM unnest($1::uuid[]) WITH ORDINALITY AS ord(id, idx)
            WHERE t.id = ord.id`,
          [orderedIds],
        )
      }
      return true
    })

    if (!ok) return { success: false, error: 'Недостаточно прав' }

    revalidatePath('/dashboard/tasks')
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось перенести задачу' }
  }
}

// ─── Удаление ────────────────────────────────────────────────────────────────

export async function deleteTask(id: string): Promise<ActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  try {
    // tasks_delete: автор или owner — и ничего шире.
    const deleted = await query<{ id: string }>(
      `DELETE FROM public.tasks AS t
        WHERE t.id = $1
          AND (t.created_by = $2 OR $3 = 'owner')
        RETURNING t.id`,
      [id, me.id, me.role],
    )
    if (deleted.length === 0) {
      return { success: false, error: 'Удалять задачу может только автор или владелец' }
    }

    revalidatePath('/dashboard/tasks')
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Не удалось удалить задачу' }
  }
}
