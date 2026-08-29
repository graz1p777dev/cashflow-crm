// Проверка отзыва сессий при смене пароля (db/003_password_changed_at.sql).
//
// Гоняется по живой БД в транзакции, которая всегда откатывается: тестовые
// пользователь и сотрудник не остаются в данных.
//
// Проверяется ровно тот предикат, что стоит в getActor()
// (src/lib/auth/actor.ts): сотрудник возвращается только если iot токена не
// раньше users.password_changed_at с точностью до секунды.
//
//   DATABASE_URL=... node scripts/verify-session-revocation.mjs

import pg from 'pg'

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })

// Копия предиката из SELF_SELECT в src/lib/auth/actor.ts. Держать синхронно.
const SELF_SELECT = `
  SELECT e.id
    FROM public.employees e
   WHERE e.deleted_at IS NULL
     AND e.user_id = $1
     AND EXISTS (
       SELECT 1
         FROM public.users u
        WHERE u.id = e.user_id
          AND (
            u.password_changed_at IS NULL
            OR date_trunc('second', u.password_changed_at) <= to_timestamp($2)
          )
     )
   LIMIT 1
`

let failures = 0

function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name} (ожидалось ${expected}, получено ${actual})`)
}

await client.connect()
await client.query('BEGIN')

try {
  const email = `session-revocation-test-${Date.now()}@example.invalid`

  const { rows: [user] } = await client.query(
    `INSERT INTO public.users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  await client.query(
    `INSERT INTO public.employees (name, email, role, user_id)
     VALUES ('Тест отзыва сессии', $1, 'mp', $2)`,
    [email, user.id],
  )

  const seen = async (iat) => (await client.query(SELF_SELECT, [user.id, iat])).rowCount === 1

  // 1. Пароль ни разу не менялся — любая живая сессия действительна.
  const oldIat = Math.floor(Date.now() / 1000) - 3600
  check('сессия до смены пароля, password_changed_at IS NULL', await seen(oldIat), true)

  // 2. Смена пароля. NOW() в транзакции — время её начала, поэтому берём
  //    clock_timestamp(): нужен реальный момент «сейчас», как в проде.
  await client.query(
    `UPDATE public.users
        SET password_hash = 'y', password_changed_at = clock_timestamp()
      WHERE id = $1`,
    [user.id],
  )

  // 3. Старая сессия (выдана час назад) — отозвана.
  check('сессия, выданная ДО смены пароля, отвергается', await seen(oldIat), false)

  // 4. Свежая сессия, выданная после смены — принимается. iat берём как в
  //    createSession(): целые секунды текущего времени.
  const { rows: [{ changed_at_epoch }] } = await client.query(
    `SELECT extract(epoch FROM password_changed_at) AS changed_at_epoch
       FROM public.users WHERE id = $1`,
    [user.id],
  )
  const freshIat = Math.floor(Number(changed_at_epoch))
  check('сессия, выданная В ТУ ЖЕ секунду (как после changeOwnPassword)', await seen(freshIat), true)
  check('сессия, выданная ПОСЛЕ смены пароля', await seen(freshIat + 1), true)

  // 5. Граница: сессия на секунду раньше смены — уже отозвана.
  check('сессия на секунду раньше смены пароля', await seen(freshIat - 1), false)
} finally {
  await client.query('ROLLBACK')
  await client.end()
}

console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалено проверок: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
