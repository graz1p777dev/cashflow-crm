import Link from 'next/link'
import {
  Bell, BellRing, CalendarClock, ListChecks, Target, TimerOff, UserCheck,
} from 'lucide-react'
import {
  getMonthKpiStats,
  getTaskSummary,
  getUnreadNotificationsCount,
} from '@/lib/dashboard-queries'
import { formatMoney } from '@/lib/formatters'
import { CHART_TEXT } from '@/components/charts/chart-theme'
import EmptyState from '@/components/common/EmptyState'

interface OpsSectionProps {
  dateStr: string
  year: number
  month: number
  role: string
  permissionLevel?: string
  employeeId?: string
  accessToken: string
}

export default async function OpsSection({
  dateStr,
  year,
  month,
  role,
  permissionLevel,
  employeeId,
}: OpsSectionProps) {
  const effectiveLevel =
    permissionLevel ??
    (role === 'mp' || role === 'lmai' ? 'employee' : role === 'rop' ? 'department_head' : 'owner')
  const filterById = effectiveLevel === 'employee' ? employeeId : undefined

  const [tasks, unread, kpi] = await Promise.all([
    getTaskSummary(dateStr, employeeId),
    getUnreadNotificationsCount(employeeId),
    // Тот же запрос делает LeftPanel для KPI-карточек. Здесь он нужен под
    // другой вопрос — «сколько процентов плана уже сделано», — а панели
    // стримятся независимыми Suspense-границами и общий кэш им не поделить.
    getMonthKpiStats(year, month, filterById),
  ])

  return (
    <section className="flex flex-col gap-7 px-6 pb-10 pt-9">
      <div>
        <div className="kicker">Работа · за пределами итогов</div>
        <h2 className="block-title" style={{ marginTop: 7 }}>
          Менеджеру и маркетологу
        </h2>
        <p className="mt-2 max-w-2xl text-sm" style={{ color: 'var(--ink-3)' }}>
          Всё, что нужно в течение дня: задачи и план — из CRM, трафик витрины и бот — из магазина.
        </p>
      </div>

      {/* ═══ Менеджеру ═══ */}
      <BlockHeader
        icon={<UserCheck size={14} />}
        title="Менеджеру"
        hint="Что горит и насколько выполнен план месяца"
      />

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Tile
          icon={<ListChecks size={13} />}
          label="Открытых задач"
          value={tasks.active}
          color={CHART_TEXT.primary}
          href="/dashboard/tasks"
        />
        <Tile
          icon={<TimerOff size={13} />}
          label="Просрочено"
          value={tasks.overdue}
          color={tasks.overdue > 0 ? CHART_TEXT.negative : CHART_TEXT.neutral}
          href="/dashboard/tasks"
        />
        <Tile
          icon={<CalendarClock size={13} />}
          label="Срок сегодня"
          value={tasks.dueToday}
          color={CHART_TEXT.secondary}
          href="/dashboard/tasks"
        />
        <Tile
          icon={<Target size={13} />}
          label="Назначено на меня"
          value={tasks.mine}
          color={CHART_TEXT.positive}
          href="/dashboard/tasks"
        />
        <Tile
          icon={unread > 0 ? <BellRing size={13} /> : <Bell size={13} />}
          label="Непрочитанных уведомлений"
          value={unread}
          color={unread > 0 ? CHART_TEXT.primary : CHART_TEXT.neutral}
          href="/dashboard/notifications"
        />
      </div>

      {tasks.active === 0 && (
        <EmptyState
          icon={ListChecks}
          size="sm"
          title="Открытых задач нет"
          hint="Задачи появятся здесь, как только их создадут на доске «Задачи»."
        />
      )}

      {/* План месяца */}
      <Card title={`Выполнение плана · ${monthName(month)}`}>
        {kpi.plan_fv === 0 && kpi.plan_sales === 0 && kpi.plan_revenue === 0 ? (
          <EmptyState
            icon={Target}
            size="sm"
            title="План на месяц не выставлен"
            hint="Заполните декомпозицию — прогресс появится здесь автоматически."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <PlanBar label="Первичные визиты" fact={kpi.fv} plan={kpi.plan_fv} />
            <PlanBar label="Продажи" fact={kpi.sales} plan={kpi.plan_sales} />
            <PlanBar
              label="Выручка"
              fact={kpi.revenue}
              plan={kpi.plan_revenue}
              format={(value) => formatMoney(value)}
            />
          </div>
        )}
      </Card>
    </section>
  )
}

// ─── Оформление ──────────────────────────────────────────────────────────────

function monthName(month: number) {
  return new Date(2000, month - 1, 1).toLocaleString('ru-RU', { month: 'long' })
}

function BlockHeader({
  icon, title, hint,
}: {
  icon: React.ReactNode
  title: string
  hint: string
}) {
  return (
    <div className="flex items-baseline gap-3 span-rule">
      <h3 className="flex items-center gap-2 text-base font-bold" style={{ color: 'var(--ink)' }}>
        <span style={{ color: 'var(--brand-ink)' }}>{icon}</span>
        {title}
      </h3>
      <span className="text-xs" style={{ color: 'var(--ink-3)' }}>{hint}</span>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-5" style={{ border: '1px solid var(--line)' }}>
      <p className="mb-3.5 text-sm font-semibold" style={{ color: 'var(--ink)' }}>{title}</p>
      {children}
    </div>
  )
}

/** Плитка-число. Либо value (число), либо готовый text — например «$0.00» или «12%». */
function Tile({
  icon, label, value, text, color, href,
}: {
  icon: React.ReactNode
  label: string
  value?: number
  text?: string
  color: string
  href?: string
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-xl font-bold" style={{ color }}>
        {icon}
        {text ?? (value ?? 0).toLocaleString('ru-RU')}
      </div>
      <div className="mt-0.5 text-xs" style={{ color: 'var(--ink-3)' }}>{label}</div>
    </>
  )

  if (href) {
    return (
      <Link
        href={href}
        className="card-hover block rounded-2xl bg-white px-4 py-3.5"
        style={{ border: '1px solid var(--line)' }}
      >
        {body}
      </Link>
    )
  }
  return (
    <div className="rounded-2xl bg-white px-4 py-3.5" style={{ border: '1px solid var(--line)' }}>
      {body}
    </div>
  )
}

function PlanBar({
  label, fact, plan, format,
}: {
  label: string
  fact: number
  plan: number
  format?: (value: number) => string
}) {
  const show = format ?? ((value: number) => value.toLocaleString('ru-RU'))
  const pct = plan > 0 ? Math.min(100, (fact / plan) * 100) : 0
  const done = plan > 0 && fact >= plan

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-xs" style={{ color: 'var(--ink-2)' }}>{label}</span>
        <span className="text-xs tabular-nums" style={{ color: 'var(--ink-3)' }}>
          <span className="font-semibold" style={{ color: 'var(--ink)' }}>{show(fact)}</span>
          {' из '}
          {plan > 0 ? show(plan) : '—'}
          {plan > 0 && (
            <span className="ml-1.5 font-semibold" style={{ color: done ? CHART_TEXT.positive : CHART_TEXT.primary }}>
              {Math.round(pct)}%
            </span>
          )}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: done ? '#04815a' : 'linear-gradient(90deg, #430c61, #7b3fa0)',
          }}
        />
      </div>
    </div>
  )
}
