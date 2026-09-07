'use server'

import { revalidatePath } from 'next/cache'
import { query, queryOne } from '@/lib/db'
import { getActor } from '@/lib/auth/actor'
import { recordAudit } from '@/actions/audit'

export type ActionResult = { success: true } | { success: false; error: string }

export interface DeptRow {
  id: string
  name: string
  description: string | null
  is_active: boolean
}

export interface RoleRow {
  id: string
  name: string
  label: string
  description: string | null
  is_system: boolean
  permission_level: string
}

export interface WorkScheduleRow {
  id: string
  name: string
  description: string | null
  is_system: boolean
  is_active: boolean
}

export interface DealStageRow {
  id: string
  name: string
  description: string | null
  color: string
  sort_order: number
  kind: 'normal' | 'won' | 'lost'
  is_default: boolean
}

// ─── Auth guard ────────────────────────────────────────────────────────────────
// Раньше requireSession() возвращал Supabase-сессию (RLS сам фильтровал
// данные по политике «только вошедшие»). Теперь запросы идут напрямую, поэтому
// проверка — как в employees.ts: есть ли действующий actor.

async function requireSession() {
  return getActor()
}

// ─── Departments ───────────────────────────────────────────────────────────────

export async function getDepartments(): Promise<DeptRow[]> {
  const session = await requireSession()
  if (!session) return []
  return query<DeptRow>(
    `SELECT id, name, description, is_active
       FROM public.departments
      WHERE is_active = TRUE
      ORDER BY name`,
  )
}

export async function createDepartment(name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  let created: { id: string } | null
  try {
    created = await queryOne<{ id: string }>(
      `INSERT INTO public.departments (name, description, is_active)
       VALUES ($1, $2, TRUE)
       RETURNING id`,
      [name.trim(), description.trim() || null],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка создания отдела' }
  }
  await recordAudit({ action: 'create', resourceType: 'department', resourceId: created?.id, summary: `Создан отдел «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function updateDepartment(id: string, name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  try {
    await query(
      `UPDATE public.departments
          SET name = $2, description = $3, updated_at = NOW()
        WHERE id = $1`,
      [id, name.trim(), description.trim() || null],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка изменения отдела' }
  }
  await recordAudit({ action: 'update', resourceType: 'department', resourceId: id, summary: `Изменён отдел «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function deleteDepartment(id: string): Promise<ActionResult> {
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM public.employees
      WHERE department_id = $1 AND deleted_at IS NULL`,
    [id],
  )
  const count = Number(countRow?.count ?? 0)
  if (count > 0) {
    return { success: false, error: `Нельзя удалить: к этому отделу привязаны сотрудники (${count} чел.) — сначала переведите их в другой отдел` }
  }
  const removed = await queryOne<{ name: string }>(
    'SELECT name FROM public.departments WHERE id = $1 LIMIT 1',
    [id],
  )
  try {
    await query('DELETE FROM public.departments WHERE id = $1', [id])
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка удаления отдела' }
  }
  await recordAudit({ action: 'delete', resourceType: 'department', resourceId: id, summary: `Удалён отдел «${removed?.name ?? ''}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── Roles ─────────────────────────────────────────────────────────────────────

export async function getRoles(): Promise<RoleRow[]> {
  const session = await requireSession()
  if (!session) return []
  return query<RoleRow>(
    `SELECT id, name, label, description, is_system, permission_level
       FROM public.roles
      WHERE deleted_at IS NULL
      ORDER BY created_at`,
  )
}

export async function createRole(
  name: string,
  label: string,
  description: string,
  permissionLevel: 'employee' | 'department_head',
): Promise<ActionResult> {
  if (!label.trim()) return { success: false, error: 'Название роли обязательно' }
  const slug = (name || label).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  if (!slug) return { success: false, error: 'Системное имя должно содержать латинские буквы' }
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  try {
    await query(
      `INSERT INTO public.roles (name, label, description, permission_level, is_system)
       VALUES ($1, $2, $3, $4, FALSE)`,
      [slug, label.trim(), description.trim() || null, permissionLevel],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка создания роли' }
  }
  await recordAudit({ action: 'create', resourceType: 'role', summary: `Создана роль «${label.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function updateRole(
  id: string,
  label: string,
  description: string,
  permissionLevel?: 'employee' | 'department_head',
): Promise<ActionResult> {
  if (!label.trim()) return { success: false, error: 'Название роли обязательно' }
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  const role = await queryOne<{ is_system: boolean }>(
    'SELECT is_system FROM public.roles WHERE id = $1 LIMIT 1',
    [id],
  )
  try {
    // Системные роли: label заблокирован — он отображает name-slug в UI, изменение сломает ориентацию
    if (role?.is_system) {
      await query(
        `UPDATE public.roles SET description = $2, updated_at = NOW() WHERE id = $1`,
        [id, description.trim() || null],
      )
    } else if (permissionLevel) {
      await query(
        `UPDATE public.roles
            SET label = $2, description = $3, permission_level = $4, updated_at = NOW()
          WHERE id = $1`,
        [id, label.trim(), description.trim() || null, permissionLevel],
      )
    } else {
      await query(
        `UPDATE public.roles SET label = $2, description = $3, updated_at = NOW() WHERE id = $1`,
        [id, label.trim(), description.trim() || null],
      )
    }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка изменения роли' }
  }
  await recordAudit({ action: 'update', resourceType: 'role', resourceId: id, summary: `Изменена роль «${label.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function deleteRole(id: string): Promise<ActionResult> {
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  const role = await queryOne<{ is_system: boolean; name: string }>(
    'SELECT is_system, name FROM public.roles WHERE id = $1 LIMIT 1',
    [id],
  )
  if (role?.is_system) return { success: false, error: 'Системные роли нельзя удалять' }
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM public.employees
      WHERE role = $1 AND deleted_at IS NULL`,
    [role?.name ?? ''],
  )
  const count = Number(countRow?.count ?? 0)
  if (count > 0) {
    return { success: false, error: `Нельзя удалить: к этой роли привязаны сотрудники (${count} чел.) — сначала измените их роль` }
  }
  try {
    await query('DELETE FROM public.roles WHERE id = $1 AND is_system = FALSE', [id])
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка удаления роли' }
  }
  await recordAudit({ action: 'delete', resourceType: 'role', resourceId: id, summary: `Удалена роль «${role?.name ?? ''}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── Work Schedules ────────────────────────────────────────────────────────────

export async function getWorkSchedules(): Promise<WorkScheduleRow[]> {
  const session = await requireSession()
  if (!session) return []
  return query<WorkScheduleRow>(
    `SELECT id, name, description, is_system, is_active
       FROM public.work_schedules
      WHERE is_active = TRUE
      ORDER BY created_at`,
  )
}

export async function createWorkSchedule(name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  try {
    await query(
      `INSERT INTO public.work_schedules (name, description, is_system, is_active)
       VALUES ($1, $2, FALSE, TRUE)`,
      [name.trim(), description.trim() || null],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка создания графика' }
  }
  await recordAudit({ action: 'create', resourceType: 'work_schedule', summary: `Создан график «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function updateWorkSchedule(id: string, name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  try {
    await query(
      `UPDATE public.work_schedules
          SET name = $2, description = $3, updated_at = NOW()
        WHERE id = $1`,
      [id, name.trim(), description.trim() || null],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка изменения графика' }
  }
  await recordAudit({ action: 'update', resourceType: 'work_schedule', resourceId: id, summary: `Изменён график «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function deleteWorkSchedule(id: string): Promise<ActionResult> {
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  const ws = await queryOne<{ is_system: boolean; name: string }>(
    'SELECT is_system, name FROM public.work_schedules WHERE id = $1 LIMIT 1',
    [id],
  )
  if (ws?.is_system) return { success: false, error: 'Системные графики нельзя удалять' }
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM public.employees
      WHERE schedule_type = $1 AND deleted_at IS NULL`,
    [ws?.name ?? ''],
  )
  const count = Number(countRow?.count ?? 0)
  if (count > 0) {
    return { success: false, error: `Нельзя удалить: этот график используют ${count} сотр. — сначала измените им график` }
  }
  try {
    await query('DELETE FROM public.work_schedules WHERE id = $1 AND is_system = FALSE', [id])
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка удаления графика' }
  }
  await recordAudit({ action: 'delete', resourceType: 'work_schedule', resourceId: id, summary: `Удалён график «${ws?.name ?? ''}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── Этапы воронки сделок ────────────────────────────────────────────────────

export async function getDealStages(): Promise<DealStageRow[]> {
  const session = await requireSession()
  if (!session) return []
  return query<DealStageRow>(
    `SELECT id, name, description, color, sort_order, kind, is_default
       FROM public.deal_stages
      ORDER BY sort_order`,
  )
}

/** Новые этапы всегда 'normal' — 'won'/'lost' зарезервированы под два
 * уже заведённых терминальных этапа, отчётность считает конверсию по ним. */
export async function createDealStage(name: string, description: string, color: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  const last = await queryOne<{ sort_order: number }>(
    `SELECT sort_order FROM public.deal_stages ORDER BY sort_order DESC LIMIT 1`,
  )
  const nextOrder = (last?.sort_order ?? 0) + 1
  let created: { id: string } | null
  try {
    created = await queryOne<{ id: string }>(
      `INSERT INTO public.deal_stages (name, description, color, sort_order, kind, is_default)
       VALUES ($1, $2, $3, $4, 'normal', FALSE)
       RETURNING id`,
      [name.trim(), description.trim() || null, color.trim() || '#94a3b8', nextOrder],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка создания этапа' }
  }
  await recordAudit({ action: 'create', resourceType: 'deal_stage', resourceId: created?.id, summary: `Создан этап воронки «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/deals')
  return { success: true }
}

export async function updateDealStage(id: string, name: string, description: string, color: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  try {
    await query(
      `UPDATE public.deal_stages
          SET name = $2, description = $3, color = $4, updated_at = NOW()
        WHERE id = $1`,
      [id, name.trim(), description.trim() || null, color.trim() || '#94a3b8'],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка изменения этапа' }
  }
  await recordAudit({ action: 'update', resourceType: 'deal_stage', resourceId: id, summary: `Изменён этап воронки «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/deals')
  return { success: true }
}

export async function deleteDealStage(id: string): Promise<ActionResult> {
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }
  const stage = await queryOne<{ name: string; is_default: boolean }>(
    'SELECT name, is_default FROM public.deal_stages WHERE id = $1 LIMIT 1',
    [id],
  )
  if (!stage) return { success: false, error: 'Этап не найден' }
  if (stage.is_default) {
    return { success: false, error: 'Этап по умолчанию нельзя удалить — в него попадают новые сделки' }
  }
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM public.deals
      WHERE stage_id = $1 AND deleted_at IS NULL`,
    [id],
  )
  const count = Number(countRow?.count ?? 0)
  if (count > 0) {
    return { success: false, error: `Нельзя удалить: на этом этапе ${count} сделок(и) — сначала перенесите их на другой этап` }
  }
  try {
    await query('DELETE FROM public.deal_stages WHERE id = $1', [id])
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { success: false, error: err.message ?? 'Ошибка удаления этапа' }
  }
  await recordAudit({ action: 'delete', resourceType: 'deal_stage', resourceId: id, summary: `Удалён этап воронки «${stage.name}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/deals')
  return { success: true }
}
