// Вход без ввода пароля — ТОЛЬКО для локальной разработки.
//
// Включается переменной AUTH_BYPASS=1, которая живёт исключительно в
// .env.local (он в .gitignore и на прод не попадает). Без этой переменной
// роут отдаёт 404, поэтому на задеплоенном сайте обычный вход по логину и
// паролю остаётся единственным способом попасть в систему.
//
// Реализовано именно как настоящий вход под заведённым владельцем, а не как
// подставной пользователь: сессия настоящая, значит роли и права работают
// ровно так же, как в бою, и локальная разработка не расходится с продакшеном.
import { NextResponse } from 'next/server'
import { signIn } from '@/actions/auth'

export async function GET(request: Request) {
  if (process.env.AUTH_BYPASS !== '1') {
    return new NextResponse('Not found', { status: 404 })
  }

  const email = process.env.DEV_LOGIN_EMAIL
  const password = process.env.DEV_LOGIN_PASSWORD
  if (!email || !password) {
    return new NextResponse(
      'AUTH_BYPASS=1, но не заданы DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD в .env.local',
      { status: 500 },
    )
  }

  // Тот же signIn, что и у обычной формы входа: ставит cf_session, проходит
  // через ту же проверку пароля и ту же брутфорс-защиту.
  const result = await signIn(email, password)

  if (!result.success) {
    return new NextResponse(
      `Не удалось войти как ${email}: ${result.error}. ` +
        'Проверьте, что пользователь заведён: npm run seed:owner',
      { status: 500 },
    )
  }

  const next = result.mustChangePassword ? '/auth/change-password' : '/dashboard'
  return NextResponse.redirect(new URL(next, request.url))
}
