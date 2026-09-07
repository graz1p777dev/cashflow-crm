import { query } from '@/lib/db'
import CalendarAnalytics from './CalendarAnalytics'

type SearchParams = Promise<{ month?: string }>

type DayAnalytics = {
  date: string
  fv: number
  sales: number
  revenue: number
  leads: number
  appeals: number
  adBudget: number
  activeCampaigns: number
  income: number
  expense: number
  events: number
  dailyPlan: number
}

function isMonth(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value))
}

export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const now = new Date()
  const month = isMonth(params.month)
    ? params.month
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const [year, monthNumber] = month.split('-').map(Number)
  const daysInMonth = new Date(year, monthNumber, 0).getDate()
  const from = `${month}-01`
  const to = `${month}-${String(daysInMonth).padStart(2, '0')}`

  // marketing_daily_data не существует в живой БД (db/MIGRATION_PLAN.md,
  // db/schema.sql §22) — запрос ниже осознанно повторяет прежнее поведение
  // (тихий сбой под Supabase), теперь как ошибка Postgres, перехватываемая так же.
  const [activityRows, consultationsRows, marketingRows, financeRows, planRows] = await Promise.all([
    query<{ date: string; fv_fact: number | null; sales_fact: number | null; revenue_fact: number | null; leads_fact: number | null; appeals_fact: number | null }>(
      `SELECT date, fv_fact, sales_fact, revenue_fact, leads_fact, appeals_fact
         FROM public.daily_activity
        WHERE date >= $1 AND date <= $2`,
      [from, to],
    ),
    query<{ date: string; actual_status: boolean | null; status_after_fv: string | null; amount: number | null }>(
      `SELECT date, actual_status, status_after_fv, amount
         FROM public.consultations
        WHERE date >= $1 AND date <= $2 AND deleted_at IS NULL`,
      [from, to],
    ),
    query<{ date: string; active_campaigns: number | null; budget: number | null; ad_appeals: number | null }>(
      `SELECT date, active_campaigns, budget, ad_appeals
         FROM public.marketing_daily_data
        WHERE date >= $1 AND date <= $2`,
      [from, to],
    ).catch((e) => {
      console.error('[CalendarPage] marketing_daily_data query failed (table missing):', e instanceof Error ? e.message : e)
      return []
    }),
    query<{ date: string; type: string; amount: number | null }>(
      `SELECT date, type, amount
         FROM public.finance_transactions
        WHERE date >= $1 AND date <= $2 AND deleted_at IS NULL`,
      [from, to],
    ),
    query<{ date_start: string; date_end: string; target_revenue: number | null }>(
      `SELECT date_start, date_end, target_revenue
         FROM public.company_plans
        WHERE date_start <= $2 AND date_end >= $1`,
      [from, to],
    ),
  ])

  const facts = new Map<string, DayAnalytics>()
  const entry = (date: string) => {
    const existing = facts.get(date)
    if (existing) return existing
    const created: DayAnalytics = {
      date, fv: 0, sales: 0, revenue: 0, leads: 0, appeals: 0,
      adBudget: 0, activeCampaigns: 0, income: 0, expense: 0, events: 0, dailyPlan: 0,
    }
    facts.set(date, created)
    return created
  }

  const activityOverrides = new Map<string, { fv: boolean; sales: boolean; revenue: boolean }>()
  for (const row of activityRows) {
    const day = entry(row.date as string)
    activityOverrides.set(row.date as string, {
      fv: row.fv_fact !== null,
      sales: row.sales_fact !== null,
      revenue: row.revenue_fact !== null,
    })
    day.fv += Number(row.fv_fact) || 0
    day.sales += Number(row.sales_fact) || 0
    day.revenue += Number(row.revenue_fact) || 0
    day.leads += Number(row.leads_fact) || 0
    day.appeals += Number(row.appeals_fact) || 0
  }

  for (const row of consultationsRows) {
    const date = row.date as string
    const day = entry(date)
    const override = activityOverrides.get(date)
    // daily_activity — главный источник дневного факта. Если конкретная
    // метрика в нём не внесена, берём её из консультаций как честный fallback.
    if (!override?.fv) day.fv += row.actual_status ? 1 : 0
    const isSale = row.status_after_fv === 'Купила' || row.status_after_fv === 'Предоплата'
    if (isSale && !override?.sales) day.sales += 1
    if (isSale && !override?.revenue) {
      day.revenue += Number(row.amount) || 0
    }
  }

  for (const row of marketingRows) {
    const day = entry(row.date as string)
    day.adBudget += Number(row.budget) || 0
    day.appeals += Number(row.ad_appeals) || 0
    day.activeCampaigns += Number(row.active_campaigns) || 0
  }

  for (const row of financeRows) {
    const day = entry(row.date as string)
    if (row.type === 'income') day.income += Number(row.amount) || 0
    if (row.type === 'expense') day.expense += Number(row.amount) || 0
  }

  for (const plan of planRows) {
    const planStart = new Date(`${plan.date_start}T00:00:00`)
    const planEnd = new Date(`${plan.date_end}T00:00:00`)
    const planDays = Math.max(1, Math.round((planEnd.getTime() - planStart.getTime()) / 86_400_000) + 1)
    const dailyPlan = (Number(plan.target_revenue) || 0) / planDays
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${month}-${String(day).padStart(2, '0')}`
      if (date >= String(plan.date_start) && date <= String(plan.date_end)) entry(date).dailyPlan += dailyPlan
    }
  }

  const data = Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`
    const day = entry(date)
    day.events = Number(day.fv > 0) + Number(day.sales > 0) + Number(day.adBudget > 0) + Number(day.income > 0 || day.expense > 0)
    return day
  })

  return <CalendarAnalytics month={month} days={data} />
}
