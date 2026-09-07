import { query, queryOne } from '@/lib/db'
import type {
  PlanVsFactRow,
  DashboardMonthStats,
  DashboardTodayStats,
  LiveFeedItem,
  TeamMemberStatus,
  AttendanceStatus,
  UserRole,
} from '@/types'

// ─────────────────────────────────────────────
// Вспомогательные типы
// ─────────────────────────────────────────────

export interface WeekRevenuePoint {
  week: string
  revenue: number
  label: string
}

// ─────────────────────────────────────────────
// KPI статистика за месяц
// ─────────────────────────────────────────────

export async function getMonthKpiStats(
  year: number,
  month: number,
  employeeId?: string
): Promise<DashboardMonthStats> {
  const t0 = Date.now()
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`
  const endDate = new Date(year, month, 0)
  const endDateStr = `${year}-${String(month).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`

  // Факт: данные из sales_plan_weekly (агрегированы триггером)
  const decompositionRows = await query<{
    total_fv_fact: number | null
    total_sales_fact: number | null
    total_revenue_fact: number | null
    kpi_pct: number | null
    total_fv_plan: number | null
    total_sales_plan: number | null
    total_revenue_plan: number | null
  }>(
    `SELECT total_fv_fact, total_sales_fact, total_revenue_fact, kpi_pct, total_fv_plan, total_sales_plan, total_revenue_plan
       FROM public.sales_plan_weekly
      WHERE period_year = $1 AND period_month = $2
        AND ($3::uuid IS NULL OR employee_id = $3)`,
    [year, month, employeeId ?? null],
  )

  console.log(`[kpi] decompositionQuery: ${Date.now() - t0}ms`)
  if (!decompositionRows || decompositionRows.length === 0) {
    // Если нет строк декомпозиции — считаем из консультаций напрямую
    const consults = await query<{
      status_after_fv: string | null
      amount: number | null
      is_nv: boolean | null
    }>(
      `SELECT status_after_fv, amount, is_nv
         FROM public.consultations
        WHERE date >= $1 AND date <= $2
          AND deleted_at IS NULL
          AND ($3::uuid IS NULL OR manager_id = $3)`,
      [startDate, endDateStr, employeeId ?? null],
    )
    console.log(`[kpi] fallback consultQuery: ${Date.now() - t0}ms`)

    const fv = consults.filter(c =>
      c.status_after_fv !== null && c.status_after_fv !== undefined
    ).length

    const sales = consults.filter(c =>
      c.status_after_fv === 'Купила' || c.status_after_fv === 'Предоплата'
    ).length

    const revenue = consults.reduce((sum, c) => {
      if (c.status_after_fv === 'Купила' || c.status_after_fv === 'Предоплата') {
        return sum + (Number(c.amount) || 0)
      }
      return sum
    }, 0)

    return { fv, sales, revenue, kpi_pct: 0, plan_fv: 0, plan_sales: 0, plan_revenue: 0 }
  }

  // Суммируем по всем строкам (если несколько сотрудников)
  const totals = decompositionRows.reduce(
    (acc, row) => ({
      fv: acc.fv + (Number(row.total_fv_fact) || 0),
      sales: acc.sales + (Number(row.total_sales_fact) || 0),
      revenue: acc.revenue + (Number(row.total_revenue_fact) || 0),
      plan_fv: acc.plan_fv + (Number(row.total_fv_plan) || 0),
      plan_sales: acc.plan_sales + (Number(row.total_sales_plan) || 0),
      plan_revenue: acc.plan_revenue + (Number(row.total_revenue_plan) || 0),
      kpi_sum: acc.kpi_sum + (Number(row.kpi_pct) || 0),
    }),
    { fv: 0, sales: 0, revenue: 0, plan_fv: 0, plan_sales: 0, plan_revenue: 0, kpi_sum: 0 }
  )

  const kpi_pct = decompositionRows.length > 0
    ? totals.kpi_sum / decompositionRows.length
    : 0

  return {
    fv: totals.fv,
    sales: totals.sales,
    revenue: totals.revenue,
    kpi_pct: Math.round(kpi_pct * 10) / 10,
    plan_fv: totals.plan_fv,
    plan_sales: totals.plan_sales,
    plan_revenue: totals.plan_revenue,
  }
}

// ─────────────────────────────────────────────
// Выручка по неделям месяца
// ─────────────────────────────────────────────

export async function getRevenueByWeeks(
  year: number,
  month: number,
  employeeId?: string
): Promise<WeekRevenuePoint[]> {
  const t0 = Date.now()
  const daysInMonth = new Date(year, month, 0).getDate()
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`

  const [consults, activity] = await Promise.all([
    query<{ date: string; amount: number | null; status_after_fv: string | null }>(
      `SELECT date, amount, status_after_fv
         FROM public.consultations
        WHERE date >= $1 AND date <= $2
          AND status_after_fv IN ('Купила', 'Предоплата')
          AND deleted_at IS NULL
          AND ($3::uuid IS NULL OR manager_id = $3)`,
      [startDate, endDate, employeeId ?? null],
    ),
    query<{ date: string; revenue_fact: number | null }>(
      `SELECT date, revenue_fact
         FROM public.daily_activity
        WHERE date >= $1 AND date <= $2
          AND ($3::uuid IS NULL OR employee_id = $3)`,
      [startDate, endDate, employeeId ?? null],
    ),
  ])
  console.log(`[revenueByWeeks] ${Date.now() - t0}ms`)

  // Группируем по неделям (1–7, 8–14, 15–21, 22–end)
  const weeks: WeekRevenuePoint[] = [
    { week: '1', label: '1–7', revenue: 0 },
    { week: '2', label: '8–14', revenue: 0 },
    { week: '3', label: '15–21', revenue: 0 },
    { week: '4', label: `22–${daysInMonth}`, revenue: 0 },
  ]

  const revenueByDay = new Map<string, number>()
  for (const consultation of consults) {
    revenueByDay.set(consultation.date, (revenueByDay.get(consultation.date) ?? 0) + (Number(consultation.amount) || 0))
  }
  for (const row of activity) {
    if (row.revenue_fact !== null) revenueByDay.set(row.date, Number(row.revenue_fact) || 0)
  }

  for (const [date, revenue] of revenueByDay) {
    const day = Number(date.slice(-2))
    if (day <= 7) weeks[0].revenue += revenue
    else if (day <= 14) weeks[1].revenue += revenue
    else if (day <= 21) weeks[2].revenue += revenue
    else weeks[3].revenue += revenue
  }

  return weeks
}

// ─────────────────────────────────────────────
// Таблица план vs факт по сотрудникам
// ─────────────────────────────────────────────

export async function getPlanVsFactTable(
  year: number,
  month: number,
  employeeId?: string
): Promise<PlanVsFactRow[]> {
  const t0 = Date.now()
  const rows = await query<{
    employee_id: string
    employee_name: string
    total_fv_plan: number | null
    total_fv_fact: number | null
    total_sales_plan: number | null
    total_sales_fact: number | null
    total_revenue_fact: number | null
    kpi_pct: number | null
  }>(
    `SELECT spw.employee_id,
            e.name AS employee_name,
            spw.total_fv_plan, spw.total_fv_fact,
            spw.total_sales_plan, spw.total_sales_fact,
            spw.total_revenue_fact,
            spw.kpi_pct
       FROM public.sales_plan_weekly spw
       JOIN public.employees e ON e.id = spw.employee_id
      WHERE spw.period_year = $1 AND spw.period_month = $2
        AND ($3::uuid IS NULL OR spw.employee_id = $3)`,
    [year, month, employeeId ?? null],
  )
  console.log(`[planVsFact] ${Date.now() - t0}ms`)

  if (!rows || rows.length === 0) return []

  return rows.map((row) => ({
    employee_id: row.employee_id,
    employee_name: row.employee_name,
    plan_fv: Number(row.total_fv_plan) || 0,
    fact_fv: Number(row.total_fv_fact) || 0,
    plan_sales: Number(row.total_sales_plan) || 0,
    fact_sales: Number(row.total_sales_fact) || 0,
    revenue: Number(row.total_revenue_fact) || 0,
    kpi_pct: Math.round((Number(row.kpi_pct) || 0) * 10) / 10,
  }))
}

// ─────────────────────────────────────────────
// Статистика за сегодня (Today Cards)
// ─────────────────────────────────────────────

export async function getTodayStats(
  dateStr: string,
  employeeId?: string
): Promise<DashboardTodayStats> {
  const t0 = Date.now()
  const [consults, activity] = await Promise.all([
    query<{ status_after_fv: string | null; actual_status: string | null; amount: number | null }>(
      `SELECT status_after_fv, actual_status, amount
         FROM public.consultations
        WHERE date = $1
          AND deleted_at IS NULL
          AND ($2::uuid IS NULL OR manager_id = $2)`,
      [dateStr, employeeId ?? null],
    ),
    query<{ fv_fact: number | null; sales_fact: number | null; revenue_fact: number | null }>(
      `SELECT fv_fact, sales_fact, revenue_fact
         FROM public.daily_activity
        WHERE date = $1
          AND ($2::uuid IS NULL OR employee_id = $2)`,
      [dateStr, employeeId ?? null],
    ),
  ])
  console.log(`[todayStats] ${Date.now() - t0}ms`)

  const fv_today = consults.filter(c =>
    c.actual_status !== null
  ).length

  const sales_today = consults.filter(c =>
    c.status_after_fv === 'Купила' || c.status_after_fv === 'Предоплата'
  ).length

  const revenue_today = consults.reduce((sum, c) => {
    if (c.status_after_fv === 'Купила' || c.status_after_fv === 'Предоплата') {
      return sum + (Number(c.amount) || 0)
    }
    return sum
  }, 0)

  const hasActivity = activity.some((row) => row.fv_fact !== null || row.sales_fact !== null || row.revenue_fact !== null)
  if (!hasActivity) return { fv_today, sales_today, revenue_today }

  return activity.reduce((total, row) => ({
    fv_today: total.fv_today + (Number(row.fv_fact) || 0),
    sales_today: total.sales_today + (Number(row.sales_fact) || 0),
    revenue_today: total.revenue_today + (Number(row.revenue_fact) || 0),
  }), { fv_today: 0, sales_today: 0, revenue_today: 0 })
}

// ─────────────────────────────────────────────
// Лента событий (Live Feed)
// ─────────────────────────────────────────────

export async function getLiveFeed(
  dateStr: string,
  employeeId?: string,
  limit = 20
): Promise<LiveFeedItem[]> {
  const t0 = Date.now()
  const rows = await query<{
    id: string
    time: string | null
    client_name: string
    status_after_fv: LiveFeedItem['status'] | null
    actual_status: LiveFeedItem['status'] | null
    status: LiveFeedItem['status'] | null
    amount: number | null
    is_nv: boolean | null
    manager_name: string | null
  }>(
    `SELECT c.id, c.time, c.client_name, c.status_after_fv, c.actual_status, c.status, c.amount, c.is_nv,
            e.name AS manager_name
       FROM public.consultations c
       LEFT JOIN public.employees e ON e.id = c.manager_id
      WHERE c.date = $1
        AND c.deleted_at IS NULL
        AND ($2::uuid IS NULL OR c.manager_id = $2)
      ORDER BY c.time DESC
      LIMIT $3`,
    [dateStr, employeeId ?? null, limit],
  )
  console.log(`[liveFeed] ${Date.now() - t0}ms`)

  if (!rows || rows.length === 0) return []

  return rows.map(row => ({
    id: row.id,
    time: row.time ?? '00:00',
    client_name: row.client_name,
    manager_name: row.manager_name ?? 'Неизвестно',
    status: (row.status_after_fv ?? row.actual_status ?? row.status) as LiveFeedItem['status'],
    amount: Number(row.amount) || 0,
    is_nv: Boolean(row.is_nv),
  }))
}

// ─────────────────────────────────────────────
// Команда сейчас (Team Now)
// ─────────────────────────────────────────────

export async function getTeamNow(
  dateStr: string,
  departmentId?: string
): Promise<TeamMemberStatus[]> {
  const t0 = Date.now()
  const employees = await query<{
    id: string
    name: string
    avatar_url: string | null
    role: UserRole
  }>(
    `SELECT id, name, avatar_url, role
       FROM public.employees
      WHERE status = 'active'
        AND deleted_at IS NULL
        AND role <> 'owner'
        AND ($1::uuid IS NULL OR department_id = $1)`,
    [departmentId ?? null],
  )
  console.log(`[teamNow] employees: ${Date.now() - t0}ms`)

  if (!employees || employees.length === 0) return []

  const employeeIds = employees.map(e => e.id)

  const [attendanceRows, todaySales] = await Promise.all([
    query<{ employee_id: string; status: AttendanceStatus }>(
      `SELECT employee_id, status
         FROM public.attendance
        WHERE date = $1
          AND employee_id = ANY($2::uuid[])`,
      [dateStr, employeeIds],
    ),
    query<{ manager_id: string; status_after_fv: string | null; actual_status: string | null; amount: number | null }>(
      `SELECT manager_id, status_after_fv, actual_status, amount
         FROM public.consultations
        WHERE date = $1
          AND manager_id = ANY($2::uuid[])
          AND deleted_at IS NULL`,
      [dateStr, employeeIds],
    ),
  ])
  console.log(`[teamNow] attendance+sales: ${Date.now() - t0}ms`)

  const attendanceMap = new Map<string, AttendanceStatus>()
  for (const row of attendanceRows) {
    attendanceMap.set(row.employee_id, row.status)
  }

  // Считаем продажи сегодня
  const salesMap = new Map<string, { fv: number; sales: number }>()
  for (const c of todaySales) {
    const mid = c.manager_id
    const entry = salesMap.get(mid) ?? { fv: 0, sales: 0 }
    if (c.actual_status !== null) entry.fv += 1
    if (c.status_after_fv === 'Купила' || c.status_after_fv === 'Предоплата') entry.sales += 1
    salesMap.set(mid, entry)
  }

  return employees.map(emp => ({
    id: emp.id,
    name: emp.name,
    avatar_url: emp.avatar_url,
    role: emp.role,
    attendance_status: attendanceMap.get(emp.id) ?? null,
    fv_today: salesMap.get(emp.id)?.fv ?? 0,
    sales_today: salesMap.get(emp.id)?.sales ?? 0,
  }))
}

// ─────────────────────────────────────────────
// Расписание на сегодня
// ─────────────────────────────────────────────

export interface ScheduleItem {
  id: string
  time: string
  client_name: string
  status: string | null
  actual_status: string | null
  status_after_fv: string | null
  manager_name: string
  amount: number
  is_nv: boolean
  isPast: boolean
}

export async function getTodaySchedule(
  dateStr: string,
  employeeId?: string
): Promise<ScheduleItem[]> {
  const t0 = Date.now()
  const rows = await query<{
    id: string
    time: string | null
    client_name: string
    status: string | null
    actual_status: string | null
    status_after_fv: string | null
    amount: number | null
    is_nv: boolean | null
    manager_name: string | null
  }>(
    `SELECT c.id, c.time, c.client_name, c.status, c.actual_status, c.status_after_fv, c.amount, c.is_nv,
            e.name AS manager_name
       FROM public.consultations c
       LEFT JOIN public.employees e ON e.id = c.manager_id
      WHERE c.date = $1
        AND c.deleted_at IS NULL
        AND ($2::uuid IS NULL OR c.manager_id = $2)
      ORDER BY c.time ASC`,
    [dateStr, employeeId ?? null],
  )
  console.log(`[todaySchedule] ${Date.now() - t0}ms`)

  if (!rows || rows.length === 0) return []

  const nowTime = new Date().toTimeString().substring(0, 5)

  return rows.map(row => ({
    id: row.id,
    time: row.time ?? '00:00',
    client_name: row.client_name,
    status: row.status,
    actual_status: row.actual_status,
    status_after_fv: row.status_after_fv,
    manager_name: row.manager_name ?? '',
    amount: Number(row.amount) || 0,
    is_nv: Boolean(row.is_nv),
    isPast: (row.time ?? '00:00') < nowTime,
  }))
}

// ─────────────────────────────────────────────
// Сводка по доске задач (блок «Менеджеру» на дашборде)
// ─────────────────────────────────────────────

export interface TaskBoardSummary {
  /** Всё, что не done. */
  active: number
  /** Срок прошёл, задача не закрыта. */
  overdue: number
  /** Срок — сегодня. */
  dueToday: number
  /** Назначено на текущего сотрудника и не закрыто. */
  mine: number
}

// Видимость задачи раньше решала RLS-политика tasks_select через
// can_see_task(). RLS вместе с Supabase ушла (db/schema.sql), но сам
// предикат остался обычной SQL-функцией с явным зрителем — тем же, что
// использует src/actions/tasks.ts. Подставляем его в WHERE напрямую,
// вместо того чтобы переписывать правило видимости на TypeScript.
const VIEWER_USER_ID = `(SELECT e.user_id FROM public.employees e WHERE e.id = $1)`
const CAN_SEE_TASK = `public.can_see_task(
  ${VIEWER_USER_ID}, t.visibility, t.department_id, t.created_by, t.assignee_id, t.id
)`

export async function getTaskSummary(
  dateStr: string,
  employeeId?: string
): Promise<TaskBoardSummary> {
  const summary: TaskBoardSummary = { active: 0, overdue: 0, dueToday: 0, mine: 0 }
  if (!employeeId) return summary

  const rows = await query<{ status: string; due_date: string | null; assignee_id: string | null }>(
    `SELECT t.status, t.due_date, t.assignee_id
       FROM public.tasks t
      WHERE ${CAN_SEE_TASK}`,
    [employeeId],
  )

  for (const row of rows) {
    if (row.status === 'done') continue
    summary.active += 1
    const due = row.due_date
    if (due && due < dateStr) summary.overdue += 1
    if (due === dateStr) summary.dueToday += 1
    if (row.assignee_id === employeeId) summary.mine += 1
  }
  return summary
}

/**
 * Непрочитанные уведомления сотрудника.
 * Фильтр по employee_id обязателен: у owner политика notifications_select_owner
 * открывает чужие уведомления, и без него счётчик был бы «по всей компании».
 */
export async function getUnreadNotificationsCount(
  employeeId?: string
): Promise<number> {
  if (!employeeId) return 0
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM public.notifications
      WHERE employee_id = $1 AND is_read = FALSE`,
    [employeeId],
  )
  return row ? Number(row.count) : 0
}
