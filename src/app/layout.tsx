import type { Metadata } from 'next'
import { Manrope, Unbounded } from 'next/font/google'
import { cookies } from 'next/headers'
import './globals.css'
import { AuthProvider } from '@/contexts/AuthContext'
import { getActor } from '@/lib/auth/actor'
import { queryOne } from '@/lib/db'
import { Toaster } from 'sonner'
import { Employee } from '@/types'
import { DEFAULT_ACCENT, ACCENT_COOKIE_NAME, isAccentId } from '@/lib/accent-theme'

// Текст — Manrope, как на лендинге Cashflow (--font-body).
const manrope = Manrope({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-sans',
})

// Заголовки и логотип — Unbounded (--font-logo с лендинга). Геометрический
// гротеск широкий, поэтому берём только светлые начертания: в плотных
// таблицах жирный Unbounded «забивает» данные.
const unbounded = Unbounded({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600'],
  variable: '--font-display',
})

const fontVars = `${manrope.variable} ${unbounded.variable}`

// Полная карточка сотрудника для AuthProvider. Actor несёт только поля,
// нужные для проверок прав, а контексту нужен весь Employee.
async function loadEmployee(employeeId: string | null): Promise<Employee | null> {
  if (!employeeId) return null
  return queryOne<Employee>(
    'SELECT * FROM public.employees WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
    [employeeId],
  )
}

export const metadata: Metadata = {
  title: 'Cashflow CRM',
  description: 'Система управления бизнесом',
}

// Root layout — читает сессию и employee один раз на SSR.
// Передаёт данные в AuthProvider как начальное состояние:
// клиент стартует с уже известным пользователем, без race condition onAuthStateChange.
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const jar = await cookies()
  const accentCookie = jar.get(ACCENT_COOKIE_NAME)?.value
  const accent = isAccentId(accentCookie) ? accentCookie : DEFAULT_ACCENT

  // getActor() уже разрешает сессию, роль из БД и impersonation за один заход.
  const actor = await getActor()
  const initialImpersonation = actor?.impersonating ?? null

  let initialEmployee: Employee | null = null
  let initialRealUser: Employee | null = null

  if (actor) {
    if (initialImpersonation) {
      // Режим impersonation: realUser = owner, user = цель impersonation.
      const [real, effective] = await Promise.all([
        loadEmployee(actor.realEmployeeId),
        loadEmployee(actor.employeeId),
      ])
      initialRealUser = real
      initialEmployee = effective ?? real
    } else {
      initialEmployee = await loadEmployee(actor.employeeId)
    }
  }

  return (
    <html lang="ru" className={`h-full ${fontVars}`} data-accent={accent}>
      <body className={`${manrope.className} min-h-full bg-background`}>
        <AuthProvider
          initialEmployee={initialEmployee}
          initialRealUser={initialRealUser}
          initialImpersonation={initialImpersonation}
        >
          {children}
        </AuthProvider>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#ffffff',
              border: '1px solid #ece5e5',
              color: '#1b1517',
              borderRadius: '12px',
              boxShadow: '0 12px 32px -14px rgba(28,20,22,0.24)',
            },
          }}
        />
      </body>
    </html>
  )
}
