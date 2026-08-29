import { redirect } from 'next/navigation'
import { queryOne } from '@/lib/db'
import { getSession } from '@/lib/auth/session'
import DashboardShell from './DashboardShell'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Читаем сессию здесь, на уровне Layout (вне Suspense), чтобы cookies() был
  // зарегистрирован до начала стриминга.
  const session = await getSession()

  if (!session) redirect('/auth/login')

  const emp = await queryOne<{ must_change_password: boolean }>(
    'SELECT must_change_password FROM public.employees WHERE user_id = $1 LIMIT 1',
    [session.uid],
  )

  if (emp?.must_change_password) redirect('/auth/change-password')

  return <DashboardShell>{children}</DashboardShell>
}
