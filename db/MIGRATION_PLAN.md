# Data migration plan: Supabase → Railway Postgres

Phase 1 planning document. **Nothing here has been executed.** No command in this
file has been run against production Supabase; the only thing that has actually
happened is that `db/schema.sql` was applied to the empty Railway database.

Supabase stays fully intact and untouched throughout. The cutover is an
environment-variable change in the app, and so is the rollback.

---

## 0. Preconditions — **VERIFIED 2026-08-29** (3 of 4 closed)

Checked read-only against the live Supabase project (ref `tmbynmssxviiowtxtxtg`)
via PostgREST with the service-role key. No writes were made. Evidence:
`db/live-schema-openapi.json` (raw) and `db/live-data-summary.md` (counts).

There is no separate production project — this is the only Supabase project for
this app, so "does the repo match production" and "does the repo match dev" are
the same question.

1. ~~**Does the repo's migration set match production?**~~ — **CLOSED. It does.**
   The live `public` schema exposes exactly 41 tables. All 41 exist in
   `db/schema.sql` with identical column names, types, nullability and defaults.
   Zero drift.

   The 034 / 037 / 038 / 040 / 041 mystery is **resolved**: the live catalog
   contains nothing the committed migrations do not account for, so those
   numbers never produced public-schema DDL. `deal_stages.description` (from
   039) and `deals.city` / `deals.address` (from `20260810154527`) are both
   present, bracketing the gap on both sides. The hand-made changes recorded in
   `025a` and `026a` are likewise reflected — the repo's compensating migrations
   captured them correctly.

   Caveat on method: PostgREST's OpenAPI document does not report defaults for
   `jsonb` columns, so `kpi_templates.metrics DEFAULT '{}'` and
   `settings.extra DEFAULT '{}'` were confirmed from migrations 006/014 instead.
   It also cannot see indexes, CHECK constraints, functions or triggers — those
   remain derived from the migration files, which the table/column agreement
   gives good reason to trust.

2. ~~**`public.marketing_daily_data` DDL.**~~ — **CLOSED. The table does not
   exist.** PostgREST returns 404, and it is absent from the OpenAPI document.
   Phase 1's reconstructed definition has been **deleted** from `db/schema.sql`.
   The app's two call sites
   (`src/lib/data/adapters/marketing/SupabaseMarketingAdapter.ts`,
   `src/app/dashboard/calendar/page.tsx`) are querying a table that has never
   existed and are failing silently today. Phase 2 decides: delete the marketing
   adapter, or introduce the table as a new feature. Either way it is **not** a
   migration concern — nothing to carry over.

3. **`auth.users.encrypted_password` format.** — **STILL OPEN.** The `auth`
   schema is not exposed over PostgREST, so this cannot be settled without a
   direct Postgres connection. See §3. Mitigating fact: there are only **4
   employees**, which makes Path B (forced password reset) obviously correct and
   drains most of the risk out of leaving this open.

4. ~~**Row counts per table.**~~ — **CLOSED.** Exact counts captured in
   `db/live-data-summary.md`. Headline: **273 rows across 41 tables**, of which
   roughly 100 are reference seeds. 4 employees, 13 deals, 12 games, 12 game
   bookings, 61 bot messages, 43 notifications, 5 tasks. The entire
   HR/KPI/finance side — consultations, salaries, attendance, finance
   transactions, documents, all KPI result tables — is **empty**.

   Read `db/live-data-summary.md` before executing §4: at this volume most of
   the load machinery is precaution rather than necessity, but the seed-UUID
   collision described in §2 becomes the migration's main hazard.

   For the final before/after comparison still use exact `SELECT count(*)` per
   table on both sides.

---

## 1. Connection strings

```bash
# Read-only usage only. Supabase → Settings → Database → Connection string.
export SUPABASE_URL='postgresql://postgres:<PASSWORD>@db.<ref>.supabase.co:5432/postgres'
export RAILWAY_URL='postgresql://cashflow:<PASSWORD>@altaria.proxy.rlwy.net:24718/cashflow'
```

Do not put real passwords in this file or in shell history (`export
HISTCONTROL=ignorespace` and prefix the export with a space, or use a
`.env.migration` file that is gitignored).

---

## 2. Schema on the target

Already done and verified:

```bash
psql "$RAILWAY_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
```

`db/schema.sql` **seeds reference data** (roles, departments, finance_categories,
kpi_templates, work_schedules, integrations, settings, deal_stages). Those rows
have *new* UUIDs that do not match production. Before importing real data, clear
them, or every FK in the dump will point at a row that does not exist:

```sql
-- Run on Railway, before any data import.
TRUNCATE
  public.roles, public.departments, public.finance_categories,
  public.kpi_templates, public.work_schedules, public.integrations,
  public.settings, public.deal_stages
CASCADE;
```

---

## 3. `auth.users` — the special case

Supabase does not expose `auth` schema dumps through the pooler, and even with a
direct connection the password material needs judgement.

**What must be verified first** (read-only, on the direct connection):

```sql
SELECT id, email, left(encrypted_password, 7) AS hash_prefix, length(encrypted_password) AS len
FROM auth.users
LIMIT 5;
```

Interpret the result — do not guess:

- **`$2a$`, `$2b$` or `$2y$` prefix, length 60** → plain bcrypt. GoTrue has
  historically stored bcrypt in the standard modular-crypt format, and if that
  is what you see, the hashes are directly verifiable by `bcryptjs.compare()`
  and can be carried over as-is. **Still test this end-to-end** with one real
  user's known password in a scratch environment before betting the migration on
  it.
- **Anything else** (`$argon2...`, a different length, base64 blob, empty for
  OAuth-only users) → **not portable**. Take the reset path below.

Also note: users who only ever signed in via OAuth/magic link have no usable
password at all, regardless of format.

### Path A — hashes are plain bcrypt and verified working

```bash
psql "$SUPABASE_URL" -At -F $'\t' -c \
  "COPY (SELECT id, email, encrypted_password, created_at, updated_at
         FROM auth.users WHERE deleted_at IS NULL AND encrypted_password IS NOT NULL)
   TO STDOUT" > users.tsv

psql "$RAILWAY_URL" -c \
  "\\copy public.users (id, email, password_hash, created_at, updated_at) FROM 'users.tsv'"
```

Users keep their existing passwords. `employees.user_id` values stay valid
because the UUIDs are preserved.

### Path B — hashes are not portable (assume this until proven otherwise)

Import identities without usable passwords, and force everyone through a reset:

```bash
psql "$SUPABASE_URL" -At -F $'\t' -c \
  "COPY (SELECT id, email, created_at, updated_at
         FROM auth.users WHERE deleted_at IS NULL) TO STDOUT" > users.tsv

psql "$RAILWAY_URL" -c \
  "\\copy public.users (id, email, created_at, updated_at) FROM 'users.tsv'"
```

`password_hash` is `NOT NULL`, so either add a temporary default of `''` for the
load and rely on the app treating an empty hash as "no password set", or
generate a random bcrypt hash per row. Either way, set the existing forced-reset
flag so the app funnels everyone through the change-password screen it already
has:

```sql
UPDATE public.employees SET must_change_password = true;
```

Communicate to staff before cutover: everyone sets a new password on first
login. For a ~10-person internal CRM this is a 5-minute inconvenience and it
removes the entire hash-portability risk class. **Recommended.**

---

## 4. Table order for the data load

FK-safe order. Load each table fully before starting the next.

| # | Table | Depends on |
|---|-------|-----------|
| 1 | `users` | — |
| 2 | `roles` | — |
| 3 | `departments` *(with `manager_id` NULL)* | — |
| 4 | `employees` | users, departments |
| 5 | `departments.manager_id` — UPDATE pass | employees |
| 6 | `permissions` | roles |
| 7 | `work_schedules` | — |
| 8 | `schedules`, `attendance` | employees |
| 9 | `kpi_templates` | — |
| 10 | `employee_kpi` | employees, kpi_templates |
| 11 | `consultations` | employees |
| 12 | `daily_activity`, `sales_plan_weekly` | employees |
| 13 | `salaries` → `salary_calculations` | employees |
| 14 | `finance_categories` | — |
| 15 | `finance_transactions` *(with `document_id` NULL)* | finance_categories, employees |
| 16 | `document_folders` → `documents` | employees, document_folders |
| 17 | `finance_transactions.document_id` — UPDATE pass | documents |
| 18 | `finance_periods` | — |
| 19 | `investors` → `investor_payouts` | investors, finance_transactions, employees |
| 20 | `notifications` | employees |
| 21 | `integrations`, `settings` | — |
| 22 | `audit_logs` | employees |
| 23 | `kpi_role_settings` → `kpi_items`, `kpi_bonus_blocks` → `kpi_bonus_tiers` | cascade in order |
| 24 | `employee_kpi_results`, `employee_kpi_item_results` | employees, kpi_items |
| 25 | `advance_payments` | employees |
| 26 | `company_plans` | employees |
| 27 | `tasks` → `task_members` | employees, departments, tasks |
| 28 | `deal_stages` → `deals` → `deal_events` | cascade in order |
| 29 | `games` → `game_bookings` | games, deals |
| 30 | `bot_messages` | — |

Two self- and forward-referencing FKs need the two-pass treatment marked above:
`departments.manager_id → employees.id` and
`finance_transactions.document_id → documents.id`. `document_folders.parent_id`
is self-referential; load parents before children, or defer the constraint.

### Critical: disable triggers during the load

`db/schema.sql` installs the same recalculation triggers production has. Loading
historical rows would fire them thousands of times, mutating derived tables
(`sales_plan_weekly`, `finance_periods`, `employee_kpi_results`) and inserting
spurious `finance_transactions` and `notifications` rows. Run the whole import
with replication-role semantics, which suppresses user triggers:

```sql
SET session_replication_role = 'replica';
-- ... entire data load in this session ...
SET session_replication_role = 'origin';
```

If your loader reconnects per table, set it at the start of every session, or set
it on the role for the duration of the migration and reset afterwards.

### Generating the dumps

Per-table, data-only, matching the new schema exactly:

```bash
for t in users roles departments employees permissions work_schedules \
         schedules attendance kpi_templates employee_kpi consultations \
         daily_activity sales_plan_weekly salaries salary_calculations \
         finance_categories finance_transactions document_folders documents \
         finance_periods investors investor_payouts notifications \
         integrations settings audit_logs kpi_role_settings kpi_items \
         kpi_bonus_blocks kpi_bonus_tiers employee_kpi_results \
         employee_kpi_item_results advance_payments company_plans \
         tasks task_members deal_stages deals deal_events \
         games game_bookings bot_messages; do
  pg_dump "$SUPABASE_URL" --data-only --no-owner --no-acl \
    --table="public.$t" > "dump/${t}.sql"
done
```

`pg_dump --data-only` emits `COPY`, which is fast and preserves NULLs correctly.
Prefer it over hand-rolled `\copy` for everything except `auth.users`, which
`pg_dump --table` cannot reach without a direct (non-pooler) connection.

Import in the order of the table above:

```bash
psql "$RAILWAY_URL" -v ON_ERROR_STOP=1 \
  -c "SET session_replication_role='replica';" \
  -f dump/users.sql -f dump/roles.sql   # ...and so on, in order
```

### After the load

```sql
-- 1. Reset the BIGSERIAL sequence that COPY does not advance.
SELECT setval('public.bot_messages_id_seq',
              COALESCE((SELECT MAX(id) FROM public.bot_messages), 1));

-- 2. Re-enable triggers.
SET session_replication_role = 'origin';

-- 3. Re-validate every FK the load bypassed.
--    (session_replication_role='replica' also skips FK checks.)
```

Because `replica` mode skips FK *and* trigger enforcement, run a full validation
pass afterwards. The cheapest complete check is to drop and re-add each FK with
`NOT VALID` + `VALIDATE CONSTRAINT`, or simply:

```sql
-- Any row here is an orphan the load let through.
SELECT 'employees.user_id' AS fk, count(*) FROM public.employees e
  LEFT JOIN public.users u ON u.id = e.user_id
  WHERE e.user_id IS NOT NULL AND u.id IS NULL;
-- ...repeat per FK, or script it from information_schema.
```

Then `ANALYZE;` the whole database.

### Verification

- Exact `count(*)` per table, Supabase vs Railway — must match.
- Spot-check aggregates that must survive byte-for-byte:
  `SELECT sum(total_amount) FROM salaries;`,
  `SELECT sum(amount) FROM finance_transactions WHERE deleted_at IS NULL;`
- Confirm no derived-table drift: pick three `(employee, year, month)` triples,
  run `recalculate_decomposition` / `recalculate_kpi_results` on a *copy*, and
  confirm the results equal the imported values. A mismatch means either the
  trigger suppression leaked or the source data was already out of sync.

---

## 5. Cutover

The app talks to Supabase through env vars only
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`). Phase 2 replaces the four client wrappers in
`src/lib/supabase/` with a Postgres client reading `DATABASE_URL`.

Cutover = deploy the Phase-2 build with `DATABASE_URL` set. Nothing is written
to Supabase after that moment, and nothing is deleted from it.

Freeze window: put the app in read-only or take it down for the duration of the
dump+load (expected minutes at this data volume). Any write accepted by Supabase
after the dump starts is silently lost, so a freeze is not optional.

---

## 6. Rollback

Rollback is: **revert the environment variables and redeploy.**

Supabase is never modified, never truncated, never migrated. It remains a
complete, current-as-of-freeze copy of the system. Reverting the env vars puts
the app back on it in one deploy cycle.

The only asymmetry: any data written to Railway *after* cutover does not exist in
Supabase. So:

- Keep the Supabase project fully paid and running for at least 30 days after
  cutover. Do not pause it — paused Supabase projects can require support
  intervention to restore.
- During the first week, take a nightly `pg_dump` of the Railway database so a
  post-cutover rollback can replay new rows back into Supabase if it ever comes
  to that.
- Decide up front what the rollback deadline is (suggested: 72 hours). Past it,
  rolling back means losing new writes, and the answer becomes "fix forward".

Rollback checklist:

1. Set `NEXT_PUBLIC_SUPABASE_*` back to the live values; unset `DATABASE_URL`.
2. Redeploy the pre-migration build (tag it before cutover so it is one click).
3. Verify login and one write path.
4. Only then investigate what went wrong.

**Do not** drop or recreate the Railway database as part of rollback — leave it
for post-mortem.
