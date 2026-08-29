# Live Supabase — schema and data, as actually observed

Captured 2026-08-29 against project ref `tmbynmssxviiowtxtxtg` (the only Supabase
project backing this app). **Read-only**: PostgREST `GET` requests with the
service-role key. Nothing was written, altered or deleted.

Raw introspection output: `db/live-schema-openapi.json` (PostgREST OpenAPI
document, 41 table definitions with types, nullability, defaults, PK/FK notes).

---

## Row counts

Exact counts via `Prefer: count=exact` + `Range: 0-0`, reading `Content-Range`.

| Table | Rows | |
|---|---:|---|
| permissions | 65 | seed (020) |
| bot_messages | 61 | real |
| notifications | 43 | derived |
| deal_events | 19 | real |
| deals | 13 | real |
| games | 12 | real |
| game_bookings | 12 | real |
| finance_categories | 10 | seed |
| deal_stages | 7 | seed |
| roles | 5 | seed |
| tasks | 5 | real |
| employees | 4 | real |
| work_schedules | 4 | seed |
| departments | 3 | real |
| integrations | 3 | seed |
| kpi_bonus_blocks | 2 | real |
| kpi_templates | 2 | seed |
| kpi_role_settings | 1 | real |
| settings | 1 | seed (singleton) |
| advance_payments | 0 | |
| attendance | 0 | |
| audit_logs | 0 | |
| company_plans | 0 | |
| consultations | 0 | |
| daily_activity | 0 | |
| document_folders | 0 | |
| documents | 0 | |
| employee_kpi | 0 | |
| employee_kpi_item_results | 0 | |
| employee_kpi_results | 0 | |
| finance_periods | 0 | |
| finance_transactions | 0 | |
| investor_payouts | 0 | |
| investors | 0 | |
| kpi_bonus_tiers | 0 | |
| kpi_items | 0 | |
| salaries | 0 | |
| salary_calculations | 0 | |
| sales_plan_weekly | 0 | |
| schedules | 0 | |
| task_members | 0 | |

**Total: 273 rows across 41 tables, of which ~100 are seed/reference data.**

## What this means for the migration

The whole HR/KPI/finance half of the product has never been used: zero
consultations, zero salaries, zero KPI results, zero finance transactions, zero
attendance, zero documents. What exists is the CRM/bot half — 13 deals, 12
games with 12 bookings, 61 bot messages, 43 notifications, 5 tasks — plus 4
employees and the reference seeds.

Consequences for `db/MIGRATION_PLAN.md`:

- **The elaborate data-load machinery is over-engineered for this volume.** The
  two-pass FK ordering, `session_replication_role='replica'` trigger
  suppression and post-load FK re-validation all still hold, but the entire
  payload is ~170 non-seed rows and will load in seconds.
- **The derived-table drift risk is nearly moot.** `sales_plan_weekly`,
  `finance_periods`, `employee_kpi_results` and `salary_calculations` are all
  empty, so there is nothing for a stray trigger to corrupt. Only
  `notifications` (43 rows) is trigger-produced and non-empty.
- **The seed-data collision is the real hazard, not the volume.** `schema.sql`
  seeds roles, departments, finance_categories, kpi_templates, work_schedules,
  integrations, settings and deal_stages with *fresh* UUIDs. Live rows for all
  eight tables exist with *different* UUIDs, and `permissions.role_id`,
  `employees.department_id`, `deals.stage_id` and `employee_kpi.kpi_template_id`
  all point at the live ones. The `TRUNCATE ... CASCADE` step in §2 of the plan
  is mandatory, not optional.
- **A freeze window is barely needed** — minutes, and only against the bot,
  which is the one component actively writing.
- Only `bot_messages` has a sequence to reset (`BIGSERIAL`, max id ≥ 61).

## auth.users

Not reachable over PostgREST (the `auth` schema is not exposed), so the
`encrypted_password` question in §3 of the plan remains open and still needs a
direct Postgres connection. With only **4 employees**, Path B (import identities,
force a password reset on first login) is clearly the right call — it costs four
people one minute each and eliminates the hash-portability risk entirely.
