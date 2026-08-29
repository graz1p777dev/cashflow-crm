import { Pool, type PoolClient } from 'pg'

// Клиент Postgres поверх Railway. Заменяет Supabase-клиент как единственный
// путь к данным.
//
// ENV:
//   DATABASE_URL — строка подключения.
//     прод  — connection string инстанса Railway Postgres;
//     локал — свой Postgres, например
//             postgresql://postgres:postgres@localhost:5432/cashflow
//     Схема накатывается из db/schema.sql, инкременты — db/0NN_*.sql.
//
// Осознанно без ORM: 30+ файлов в src/actions/ ещё предстоит перевести с
// query-builder Supabase, и параметризованный SQL — то, подо что такой перенос
// можно вести механически, шаблон за шаблоном.

declare global {
  // eslint-disable-next-line no-var
  var __cashflowPgPool: Pool | undefined
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL не задан. Укажите строку подключения к Postgres ' +
        '(на Railway — из переменных сервиса, локально — в .env.local).',
    )
  }

  return new Pool({
    connectionString,
    // TCP-прокси Railway отдаёт соединение без TLS, локальный Postgres — тоже.
    // Управляемый инстанс с сертификатом включается через ?sslmode=require
    // прямо в DATABASE_URL, поэтому здесь ssl не навязываем.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
}

// В dev Next.js перезагружает модули на каждом изменении. Без кэша в globalThis
// каждая перезагрузка открывала бы новый пул и упиралась в лимит соединений.
export const pool: Pool = globalThis.__cashflowPgPool ?? createPool()

if (process.env.NODE_ENV !== 'production') {
  globalThis.__cashflowPgPool = pool
}

// Пул отдаёт ошибки простаивающих соединений отдельным событием. Без
// обработчика они всплывают как uncaughtException и роняют процесс.
pool.on('error', (err) => {
  console.error('[db] ошибка простаивающего соединения:', err.message)
})

/**
 * Выполняет параметризованный запрос и возвращает строки.
 *
 * Плейсхолдеры — только $1, $2, ... Значения передаются вторым аргументом
 * и никогда не склеиваются в текст запроса.
 *
 *   const rows = await query<{ id: string }>(
 *     'SELECT id FROM employees WHERE role = $1', ['owner'],
 *   )
 */
// T намеренно без ограничения QueryResultRow: то ограничение — индексная
// сигнатура, а объявленные через interface типы (Employee и почти всё в
// src/types) под неё не подходят. Приведение здесь вместо `as` в каждом из
// 30+ файлов src/actions, которые ещё предстоит перенести.
export async function query<T>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query(text, params)
  return result.rows as T[]
}

/**
 * Первая строка результата или null. Замена .single() / .maybeSingle().
 */
export async function queryOne<T>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/**
 * Выполняет callback в транзакции: COMMIT при успехе, ROLLBACK при исключении.
 * Соединение возвращается в пул в любом случае.
 *
 * Запросы внутри идут через переданный client — не через query() сверху,
 * иначе они уйдут в другое соединение и окажутся вне транзакции.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
