import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getActor } from '@/lib/auth/actor'
import { getDayGreeting } from '@/lib/formatters'
import LeftPanel from '@/components/dashboard/LeftPanel'
import LeftPanelSkeleton from '@/components/dashboard/LeftPanelSkeleton'
import RightPanel from '@/components/dashboard/RightPanel'
import RightPanelSkeleton from '@/components/dashboard/RightPanelSkeleton'
import OpsSection from '@/components/dashboard/OpsSection'
import PageLoader from '@/components/common/PageLoader'

export const metadata = { title: 'Дашборд — Cashflow' }

export default async function DashboardPage() {
  // getActor() отдаёт роль, отдел и permission_level одним запросом,
  // с учётом impersonation. Фолбэк для системных ролей — внутри него.
  const actor = await getActor()

  // TODO(миграция): LeftPanel/RightPanel всё ещё строят Supabase-клиент из
  // accessToken. Их перевод на @/lib/db — отдельный шаг (вместе с остальными
  // Realtime-компонентами); до тех пор токена взять неоткуда и панели данных
  // не покажут. Проп сохранён, чтобы не менять их сигнатуры раньше времени.
  const accessToken = ''

  const role            = actor?.role ?? 'mp'
  const permissionLevel = actor?.permissionLevel ?? 'employee'
  const employeeId      = actor?.employeeId ?? undefined
  const departmentId    = actor?.departmentId ?? null

  // Нет сессии — middleware должен поймать раньше, но на всякий случай
  if (!actor) redirect('/auth/login')

  // Бухгалтер видит только финансы
  if (permissionLevel === 'accountant') redirect('/dashboard/finance')

  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const greeting = getDayGreeting()

  const dateStr = now.toISOString().substring(0, 10)
  const dayLabel = now.toLocaleString('ru-RU', { day: 'numeric', month: 'long' })
  const monthLabel = now.toLocaleString('ru-RU', { month: 'long', year: 'numeric' })

  return (
    <div className="flex flex-col">

      {/* ── Первый экран: на десктопе две колонки на всю высоту, каждая
             со своей прокруткой. Ниже него страница продолжается, поэтому
             фиксированная height (а не min-height) обязательна: колонки
             должны упереться в границу экрана, а не растянуться под весь
             документ. На телефоне колонки складываются друг под друга и
             высоту не фиксируем — иначе внутри узкого экрана появились бы
             две независимые прокрутки вместо одной страницы. ── */}
      <div className="flex flex-col md:h-[calc(100vh-52px)] md:flex-shrink-0 md:flex-row">

      {/* ── Левая панель: итоги месяца ── */}
      <div
        className="flex w-full flex-col border-b border-[rgba(28,20,22,0.07)] glass md:w-[55%] md:overflow-y-auto md:border-b-0 md:border-r"
        style={{
          borderTop: 'none',
          borderLeft: 'none',
          minWidth: 0,
        }}
      >
        <div className="px-6 pt-6 pb-4 flex-shrink-0">
          <div className="kicker">{greeting} · {monthLabel}</div>
          <h2 className="block-title" style={{ marginTop: 7 }}>
            Итоги месяца
          </h2>
        </div>

        <Suspense fallback={<LeftPanelSkeleton />}>
          <LeftPanel
            year={year}
            month={month}
            employeeId={employeeId}
            role={role}
            permissionLevel={permissionLevel}
            accessToken={accessToken}
          />
        </Suspense>
      </div>

      {/* ── Правая панель: сегодня ── */}
      <div
        className="flex w-full flex-col md:w-[45%] md:overflow-y-auto"
        style={{ minWidth: 0 }}
      >
        <div className="px-6 pt-6 pb-4 flex-shrink-0">
          <div className="kicker">Сегодня</div>
          <h2 className="block-title" style={{ marginTop: 7 }}>
            {dayLabel}
          </h2>
        </div>

        <Suspense fallback={<RightPanelSkeleton />}>
          <RightPanel
            dateStr={dateStr}
            role={role}
            permissionLevel={permissionLevel}
            employeeId={employeeId}
            departmentId={departmentId}
            accessToken={accessToken}
          />
        </Suspense>
      </div>
      </div>

      {/* ── Ниже первого экрана: работа менеджера и маркетолога.
             Отдельная Suspense-граница — блок ходит и в Supabase, и в витрину,
             и не должен задерживать первый экран. ── */}
      <div style={{ borderTop: '1px solid rgba(28,20,22,0.07)', background: 'var(--paper)' }}>
        <Suspense fallback={<PageLoader minHeight="320px" />}>
          <OpsSection
            dateStr={dateStr}
            year={year}
            month={month}
            role={role}
            permissionLevel={permissionLevel}
            employeeId={employeeId}
            accessToken={accessToken}
          />
        </Suspense>
      </div>
    </div>
  )
}
