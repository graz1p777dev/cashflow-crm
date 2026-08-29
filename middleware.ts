import { NextResponse, type NextRequest } from 'next/server'
import { decodeSession, SESSION_COOKIE_NAME } from '@/lib/auth/session'

// Гейтинг маршрутов на подписанной cookie вместо supabase.auth.getUser().
//
// Раньше здесь были два похода наружу на каждый запрос: сетевой вызов GoTrue и
// запрос роли в employees. Теперь — только проверка HMAC локально.
//
// Роль берётся из payload (снимок на момент входа), и это сознательный размен:
// middleware остаётся без БД, но роль в нём может отстать от реальной, если
// владелец сменил её у уже вошедшего сотрудника. Поэтому здесь только
// удобные редиректы — доступ к данным закрывают проверки в Server Actions
// через getActor(), где роль читается из БД (db/AUTH_DESIGN.md §2).
//
// decodeSession использует node:crypto — это допустимо: начиная с Next.js 16
// middleware/proxy по умолчанию исполняется в Node.js-рантайме, а не в Edge
// (конфиг runtime при этом задавать нельзя, он бросает ошибку).
//
// Файл остаётся middleware.ts: в Next.js 16 конвенция переименована в proxy.ts,
// старое имя помечено deprecated, но продолжает работать. Переименование —
// отдельный шаг (npx @next/codemod middleware-to-proxy .), не смешиваем его с
// миграцией авторизации.

export function middleware(request: NextRequest) {
  const session = decodeSession(request.cookies.get(SESSION_COOKIE_NAME)?.value)

  const pathname      = request.nextUrl.pathname
  // /chat/[leadId] — история чата по ссылке из Telegram-карточки бота
  const isDashboard   = pathname.startsWith('/dashboard') || pathname.startsWith('/chat')
  const isInventory   = pathname.startsWith('/inventory')
  const isCashier     = pathname === '/cashier'
  const isAuthPage    = pathname.startsWith('/auth')

  // Без сессии — только публичные auth-страницы
  if ((isDashboard || isInventory || isCashier) && !session) {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    return NextResponse.redirect(url)
  }

  // Кассир не получает доступ к CRM и товароучёту даже при прямом вводе URL.
  if (session && (isDashboard || isInventory) && session.role === 'cashier') {
    const url = request.nextUrl.clone()
    url.pathname = '/cashier'
    return NextResponse.redirect(url)
  }

  // /auth/reset-password и /auth/change-password требуют активную сессию — не редиректим
  const isSessionRequired = pathname === '/auth/reset-password' || pathname === '/auth/change-password'
  if (isAuthPage && !isSessionRequired && session) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/chat/:path*',
    '/inventory/:path*',
    '/cashier',
    '/auth/:path*',
  ],
}
