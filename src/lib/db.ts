import { Pool, types as pgTypes, type PoolClient } from 'pg'

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

// ─── Разбор типов: приводим к тому, что отдавал PostgREST ────────────────────
//
// Supabase отдавал результат как JSON, поэтому весь код в src/types и в
// компонентах написан под «numeric — это number, момент времени — ISO-строка».
// Драйвер pg по умолчанию отдаёт другое: numeric и bigint строками (ради
// точности, которая в JS-number не влезает), а даты — объектами Date.
//
// Без выравнивания это ломалось бы тихо и повсюду: `price.toFixed(2)` на
// строке падает, `seats_total - taken` даёт "10-3" → NaN, а сравнение дат
// строкой с Date молча всегда false. Поэтому разбор настраивается один раз
// здесь, а не правится по месту в тридцати с лишним файлах src/actions.
//
// Про точность: numeric у нас — это деньги (суммы сделок, оклады, цены) и
// коэффициенты KPI. Все они с большим запасом лежат в безопасном диапазоне
// double, и ровно так же вели себя под Supabase — то есть это не потеря
// точности, а сохранение текущего поведения. Если когда-нибудь появится
// колонка, которой double мало, ей нужен свой разбор в месте использования.

// numeric / decimal
pgTypes.setTypeParser(pgTypes.builtins.NUMERIC, (v) => (v === null ? null : Number(v)))
// bigint — telegram_chat_id и bot_messages.id
pgTypes.setTypeParser(pgTypes.builtins.INT8, (v) => (v === null ? null : Number(v)))
// date — отдаём как есть, 'YYYY-MM-DD': ровно то, что приходило от PostgREST
// (hire_date, birth_date, due_date хранятся и сравниваются как строки).
pgTypes.setTypeParser(pgTypes.builtins.DATE, (v) => v)
// timestamptz — ISO-строка вместо Date.
//
// timestamp БЕЗ зоны намеренно не трогаем: в схеме таких колонок нет ни одной
// (все моменты времени — timestamptz), а разбор наивного значения неизбежно
// пришлось бы привязать к какой-то зоне и молча сдвинуть время. Появится такая
// колонка — решать нужно будет вместе с ней, а не заранее и вслепую.
pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMPTZ, (v) =>
  v === null ? null : new Date(v).toISOString(),
)

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
