'use server'

// Карточки сотрудников, их KPI-планы и справочники для форм.
//
// Аккаунт для входа заводится и удаляется не здесь: этим занимаются
// createAuthUser/deleteAuthUser из src/actions/auth.ts, перенесённые на
// public.users в предыдущем шаге. Тут остаётся только сама карточка.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { query, queryOne } from '@/lib/db'
import { getActor, isOwner } from '@/lib/auth/actor'
import { validatePassword } from '@/lib/auth-validation'
import { createAuthUser } from '@/actions/auth'
import { recordAudit } from '@/actions/audit'
import type { Employee, Department } from '@/types'

// ─── getEmployees ─────────────────────────────────────────────────────────────
// Раньше список шёл через service-role клиент в обход RLS: архив (deleted_at
// IS NOT NULL) политики не отдавали. Отдельного клиента больше нет — запрос
// прямой, а флаг includeArchived работает так же.

export async function getEmployees(includeArchived: boolean): Promise<{
  employees: Employee[]
  departments: Pick<Department, 'id' | 'name'>[]
  roles: { value: string; label: string }[]
  schedules: { value: string; label: string }[]
}> {
  const actor = await getActor()
  if (!actor) return { employees: [], departments: [], roles: [], schedules: [] }

  const [employees, departments, roleRows, scheduleRows] = await Promise.all([
    query<Employee>(
      `SELECT * FROM public.employees
        WHERE ($1::boolean OR deleted_at IS NULL)
        ORDER BY name`,
      [includeArchived],
    ),
    query<Pick<Department, 'id' | 'name'>>(
      `SELECT id, name FROM public.departments
        WHERE is_active = TRUE
        ORDER BY name`,
    ),
    query<{ name: string; label: string }>(
      `SELECT name, label FROM public.roles
        WHERE deleted_at IS NULL
        ORDER BY created_at`,
    ),
    query<{ name: string; description: string | null }>(
      `SELECT name, description FROM public.work_schedules
        WHERE is_active = TRUE
        ORDER BY created_at`,
    ),
  ])

  return {
    employees,
    departments,
    roles: roleRows.map((r) => ({ value: r.name, label: r.label })),
    schedules: scheduleRows.map((s) => ({
      value: s.name,
      label: s.description ? `${s.name} — ${s.description}` : s.name,
    })),
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const EmployeeSchema = z.object({
  name:             z.string().min(2, 'Имя обязательно (мин. 2 символа)'),
  email:            z.string().email('Некорректный email'),
  phone:            z.string().nullable().optional(),
  role:             z.string().min(1, 'Роль обязательна'),
  department_id:    z.string().uuid().nullable().optional(),
  hire_date:        z.string().nullable().optional(),
  birth_date:       z.string().nullable().optional(),
  base_salary:      z.number().min(0).default(0),
  kpi_coefficient:  z.number().min(0).default(1.0).optional(),
  schedule_type:    z.string().min(1).default('5/2'),
  work_start_time:  z.string().default('09:00'),
  work_end_time:    z.string().default('18:00'),
  status:           z.enum(['active', 'probation', 'archived']).default('active'),
  notes:            z.string().nullable().optional(),
  // Пароль нужен только при создании — при обновлении передаётся как пустая строка
  initial_password: z.string().optional(),
})

export type EmployeeFormData = z.infer<typeof EmployeeSchema>
export type ActionResult = { success: true } | { success: false; error: string }

// Проверка «только владелец» переехала в @/lib/auth/actor как isOwner():
// смотрит на настоящую роль из БД, поэтому владелец в режиме impersonation
// прав не теряет, а подделанная cookie impersonate_as их не даёт.

// ─── createEmployee ───────────────────────────────────────────────────────────

export async function createEmployee(data: EmployeeFormData): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }

  const parsed = EmployeeSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  // Валидация пароля — обязателен при создании
  const password = parsed.data.initial_password ?? ''
  if (!password) return { success: false, error: 'Задайте начальный пароль для сотрудника' }
  const pwErr = validatePassword(password)
  if (pwErr) return { success: false, error: pwErr }

  // Проверяем уникальность email в employees
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM public.employees
      WHERE email = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [parsed.data.email],
  )
  if (existing) return { success: false, error: 'Сотрудник с таким email уже существует' }

  // Порядок обратный прежнему, и это осознанно.
  //
  // Раньше сначала заводился auth-пользователь, потом карточка, а при сбое
  // карточки auth-пользователь удалялся вручную — компенсация, которая сама
  // могла не сработать. Теперь сначала вставляется карточка, а createAuthUser
  // одной транзакцией создаёт public.users и проставляет employees.user_id
  // (см. src/actions/auth.ts). Компенсация осталась одна и она проще: не
  // получилось завести аккаунт — удаляем только что созданную карточку.
  let employeeId: string
  try {
    const created = await queryOne<{ id: string }>(
      `INSERT INTO public.employees
         (name, email, phone, role, department_id, hire_date, birth_date,
          base_salary, kpi_coefficient, schedule_type, work_start_time,
          work_end_time, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        parsed.data.name,
        parsed.data.email,
        parsed.data.phone ?? null,
        parsed.data.role,
        parsed.data.department_id ?? null,
        parsed.data.hire_date ?? null,
        parsed.data.birth_date ?? null,
        parsed.data.base_salary,
        parsed.data.kpi_coefficient,
        parsed.data.schedule_type,
        parsed.data.work_start_time,
        parsed.data.work_end_time,
        parsed.data.status,
        parsed.data.notes ?? null,
      ],
    )
    if (!created) return { success: false, error: 'Ошибка создания сотрудника' }
    employeeId = created.id
  } catch (e) {
    const err = e as { code?: string; message?: string }
    console.error('[createEmployee] insert:', err.code, err.message)
    if (err.code === '23505') return { success: false, error: 'Email уже занят' }
    return { success: false, error: 'Ошибка создания сотрудника' }
  }

  const auth = await createAuthUser(parsed.data.email, password, employeeId)
  if (!auth.success) {
    // Откат: без аккаунта сотрудник войти не сможет, а карточка-призрак
    // займёт email и сломает повторную попытку.
    await query('DELETE FROM public.employees WHERE id = $1', [employeeId])
    return auth
  }

  await recordAudit({ action: 'create', resourceType: 'employee', summary: `Добавлен сотрудник ${parsed.data.name}` })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── updateEmployee ───────────────────────────────────────────────────────────

export async function updateEmployee(id: string, data: EmployeeFormData): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }

  const parsed = EmployeeSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  // Проверяем уникальность email (кроме текущего)
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM public.employees
      WHERE email = $1 AND deleted_at IS NULL AND id <> $2
      LIMIT 1`,
    [parsed.data.email, id],
  )
  if (existing) return { success: false, error: 'Сотрудник с таким email уже существует' }

  try {
    await query(
      `UPDATE public.employees
          SET name = $2, email = $3, phone = $4, role = $5, department_id = $6,
              hire_date = $7, birth_date = $8, base_salary = $9,
              kpi_coefficient = $10, schedule_type = $11, work_start_time = $12,
              work_end_time = $13, status = $14, notes = $15
        WHERE id = $1 AND deleted_at IS NULL`,
      [
        id,
        parsed.data.name,
        parsed.data.email,
        parsed.data.phone ?? null,
        parsed.data.role,
        parsed.data.department_id ?? null,
        parsed.data.hire_date ?? null,
        parsed.data.birth_date ?? null,
        parsed.data.base_salary,
        parsed.data.kpi_coefficient,
        parsed.data.schedule_type,
        parsed.data.work_start_time,
        parsed.data.work_end_time,
        parsed.data.status,
        parsed.data.notes ?? null,
      ],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    console.error('[updateEmployee]', err.code, err.message)
    return { success: false, error: 'Ошибка обновления сотрудника' }
  }

  await recordAudit({ action: 'update', resourceType: 'employee', resourceId: id, summary: `Изменён сотрудник ${parsed.data.name}` })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── archiveEmployee (soft delete) ───────────────────────────────────────────

export async function archiveEmployee(id: string): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }

  const emp = await queryOne<{ name: string; deleted_at: string | null; status: string }>(
    'SELECT name, deleted_at, status FROM public.employees WHERE id = $1 LIMIT 1',
    [id],
  )
  if (!emp) return { success: false, error: 'Сотрудник не найден' }
  if (emp.deleted_at || emp.status === 'archived') return { success: false, error: 'Сотрудник уже уволен' }

  try {
    await query(
      `UPDATE public.employees
          SET deleted_at = NOW(), status = 'archived'
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    console.error('[archiveEmployee]', err.code, err.message)
    return { success: false, error: 'Ошибка увольнения сотрудника' }
  }

  // TODO(следующий шаг): решить, гасить ли аккаунт уволенного (deleteAuthUser
  // из src/actions/auth.ts). Сейчас — нет, ровно как и раньше: этот файл
  // никогда его не звал. Вход при этом всё равно закрыт, но не аккаунтом, а
  // getActor(): он берёт только сотрудников с deleted_at IS NULL и после
  // архивации возвращает null. Строка employees.user_id при этом остаётся,
  // так что restoreEmployee возвращает сотруднику прежний вход.

  await recordAudit({ action: 'update', resourceType: 'employee', resourceId: id, summary: `Уволен сотрудник ${emp.name ?? ''}` })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── restoreEmployee ──────────────────────────────────────────────────────────

export async function restoreEmployee(id: string): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }

  const emp = await queryOne<{ name: string }>(
    'SELECT name FROM public.employees WHERE id = $1 LIMIT 1',
    [id],
  )

  try {
    await query(
      `UPDATE public.employees
          SET deleted_at = NULL, status = 'active'
        WHERE id = $1 AND deleted_at IS NOT NULL`,
      [id],
    )
  } catch (e) {
    const err = e as { code?: string; message?: string }
    console.error('[restoreEmployee]', err.code, err.message)
    return { success: false, error: 'Ошибка восстановления сотрудника' }
  }

  await recordAudit({ action: 'update', resourceType: 'employee', resourceId: id, summary: `Восстановлен сотрудник ${emp?.name ?? ''}` })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── upsertEmployeeKpi ────────────────────────────────────────────────────────

export interface KpiPlanFormData {
  plan_fv:        number | null
  plan_sales:     number | null
  plan_revenue:   number | null
  plan_appeals:   number | null
  plan_leads:     number | null
  plan_nv:        number | null
  plan_work_days: number | null
}

export async function upsertEmployeeKpi(
  employeeId: string,
  year: number,
  month: number,
  data: KpiPlanFormData,
): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }

  try {
    await query(
      `INSERT INTO public.employee_kpi
         (employee_id, period_year, period_month, plan_fv, plan_sales,
          plan_revenue, plan_appeals, plan_leads, plan_nv, plan_work_days, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL)
       ON CONFLICT (employee_id, period_year, period_month) DO UPDATE
          SET plan_fv        = EXCLUDED.plan_fv,
              plan_sales     = EXCLUDED.plan_sales,
              plan_revenue   = EXCLUDED.plan_revenue,
              plan_appeals   = EXCLUDED.plan_appeals,
              plan_leads     = EXCLUDED.plan_leads,
              plan_nv        = EXCLUDED.plan_nv,
              plan_work_days = EXCLUDED.plan_work_days,
              created_by     = EXCLUDED.created_by`,
      [
        employeeId,
        year,
        month,
        data.plan_fv,
        data.plan_sales,
        data.plan_revenue,
        data.plan_appeals,
        data.plan_leads,
        data.plan_nv,
        data.plan_work_days,
      ],
    )
  } catch (e) {
    console.error('[upsertEmployeeKpi]', e instanceof Error ? e.message : e)
    return { success: false, error: 'Ошибка сохранения KPI-планов' }
  }

  // Пересчитываем sales_plan_weekly чтобы kpi_pct обновился сразу.
  // Была RPC — стала обычным вызовом SQL-функции. Сбой пересчёта, как и
  // раньше, только логируется: планы уже сохранены.
  //
  // Приведение к smallint обязательно: recalculate_decomposition объявлена как
  // (uuid, smallint, smallint), а нетипизированный числовой параметр Postgres
  // разрешает в integer и функцию не находит.
  try {
    await query(
      'SELECT public.recalculate_decomposition($1, $2::smallint, $3::smallint)',
      [employeeId, year, month],
    )
  } catch (e) {
    console.error('[upsertEmployeeKpi] recalculate_decomposition failed:', e instanceof Error ? e.message : e)
  }

  // Инвалидируем кэш — следующий getEmployeesData получит свежие данные
  const { globalCache } = await import('@/lib/data/cache/MemoryCache')
  globalCache.invalidate(`employees:${year}:${month - 1}`)
  globalCache.invalidate(`employees:${year}:${month}`)

  const kpiEmp = await queryOne<{ name: string }>(
    'SELECT name FROM public.employees WHERE id = $1 LIMIT 1',
    [employeeId],
  )
  await recordAudit({
    action: 'update',
    resourceType: 'employee_kpi',
    resourceId: employeeId,
    summary: `Изменён KPI-план ${kpiEmp?.name ?? ''} на ${String(month).padStart(2, '0')}.${year}`,
  })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── getEmployeeKpiPlan ───────────────────────────────────────────────────────

export async function getEmployeeKpiPlan(
  employeeId: string,
  year: number,
  month: number,
): Promise<KpiPlanFormData | null> {
  if (!await isOwner()) return null

  return queryOne<KpiPlanFormData>(
    `SELECT plan_fv, plan_sales, plan_revenue, plan_appeals,
            plan_leads, plan_nv, plan_work_days
       FROM public.employee_kpi
      WHERE employee_id = $1 AND period_year = $2 AND period_month = $3
      LIMIT 1`,
    [employeeId, year, month],
  )
}
