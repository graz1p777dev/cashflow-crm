import {
  getTodayStats,
  getLiveFeed,
  getTeamNow,
  getTodaySchedule,
} from '@/lib/dashboard-queries'
import TodayCards from './TodayCards'
import LiveFeed from './LiveFeed'
import TeamNow from './TeamNow'
import TodaySchedule from './TodaySchedule'

interface RightPanelProps {
  dateStr: string
  role: string
  permissionLevel?: string
  employeeId?: string
  departmentId?: string | null
  accessToken: string
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="font-medium"
      style={{
        fontSize: 12,
        color: '#6b7280',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        marginBottom: 12,
      }}
    >
      {children}
    </p>
  )
}

export default async function RightPanel({
  dateStr,
  role,
  permissionLevel,
  employeeId,
  departmentId,
}: RightPanelProps) {
  // permissionLevel используется для поддержки пользовательских ролей.
  const effectiveLevel = permissionLevel ?? (role === 'mp' || role === 'lmai' ? 'employee' : role === 'rop' ? 'department_head' : 'owner')
  const filterById = effectiveLevel === 'employee' ? employeeId : undefined
  const filterDept = effectiveLevel === 'department_head' ? (departmentId ?? undefined) : undefined

  const [todayStats, feedItems, teamMembers, scheduleItems] = await Promise.all([
    getTodayStats(dateStr, filterById),
    getLiveFeed(dateStr, filterById),
    (effectiveLevel === 'owner' || effectiveLevel === 'department_head')
      ? getTeamNow(dateStr, filterDept)
      : Promise.resolve([]),
    getTodaySchedule(dateStr, filterById),
  ])

  const currentTime = new Date().toTimeString().substring(0, 5)

  return (
    <div className="px-6 pb-6 flex flex-col gap-5">
      {/* Карточки дня */}
      <div>
        <SectionTitle>Итоги дня</SectionTitle>
        <TodayCards stats={todayStats} />
      </div>

      {/* Лента событий */}
      <div>
        <SectionTitle>Записи · лента</SectionTitle>
        <LiveFeed
          initialItems={feedItems}
          dateStr={dateStr}
          employeeId={filterById}
        />
      </div>

      {/* Команда сейчас */}
      {(effectiveLevel === 'owner' || effectiveLevel === 'department_head') && (
        <div>
          <SectionTitle>Команда сейчас</SectionTitle>
          <TeamNow members={teamMembers} />
        </div>
      )}

      {/* Расписание дня */}
      <div>
        <SectionTitle>Расписание дня</SectionTitle>
        <TodaySchedule items={scheduleItems} currentTime={currentTime} />
      </div>
    </div>
  )
}
