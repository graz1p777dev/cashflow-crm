# Auth & authorization design (post-Supabase)

**Design document only. No code in this repo implements any of it yet.**
Phase 1 delivers the schema and this plan; Phase 2 is the application rewrite.

Replaces: Supabase GoTrue sessions, `auth.uid()`, and 231 RLS policies
(exact count, `grep -c 'CREATE POLICY' supabase/migrations/*.sql`).

---

## 1. Session mechanism — recommendation

**Recommendation: a self-rolled signed-cookie session, in the shape of
`/Users/alihantorebekov/Desktop/Projects/Bots/bot-admin-panel/src/lib/session.ts`
but with a real payload — not NextAuth v5.**

### Why not NextAuth v5

NextAuth earns its keep when you need OAuth providers, account linking, email
verification flows, or a session shared across several apps. CashflowCRM needs
none of that. What it *does* need, NextAuth actively gets in the way of:

- **Impersonation.** `src/actions/auth.ts` implements it today with a separate
  `impersonate_as` httpOnly cookie read server-side (`getImpersonationState`,
  `startImpersonation`, `stopImpersonation`), audited on both ends. Under
  NextAuth this becomes a fight with the JWT/session callbacks, because the
  effective identity is no longer the authenticated identity. With our own
  cookie, impersonation is one more field in the payload and a rule that the
  real user id is the one written to `audit_logs`.
- **Forced password change.** `must_change_password` on `employees` gates the
  whole app after a successful login (`signIn` already checks it). That is a
  third session state — authenticated-but-restricted — which NextAuth models
  awkwardly and a payload field models trivially.
- **Role/employee linkage.** Every authorization decision needs
  `employee_id`, `role`, `department_id`, and `permission_level`. These come
  from a join across `employees` and `roles` and change when an owner edits a
  role. NextAuth's JWT strategy would cache them until the token expires, which
  is exactly wrong for a system where role changes must take effect now.
- **Dependency weight.** Adding `next-auth@5` (still in beta at time of writing)
  to a production ERP mid-migration adds an upgrade treadmill for functionality
  we are not using.

The counter-argument is real and should be weighed: rolling your own auth is
where teams introduce vulnerabilities. That risk is mitigated here because the
surface is small (one cookie, one hash function, no federation) and because the
crypto is delegated: `bcryptjs` for passwords, node's `crypto` for the cookie
signature. Nothing bespoke is invented.

### Shape

```
Cookie: cf_session   httpOnly, Secure, SameSite=Lax, Path=/, Max-Age=30d
Value:  base64url(JSON payload) "." hex(HMAC-SHA256(payload, SESSION_SECRET))
```

Payload: `{ uid, iat, exp }` — the user id and timestamps, nothing else.

**Deliberately NOT in the cookie:** role, employee_id, department_id,
permission_level, impersonation target. Those are looked up per request from the
database. A role stored in a cookie is a role that cannot be revoked, and this
system lets an owner edit roles at runtime. One indexed lookup on
`employees.user_id` per request is cheap; a stale privilege is not.

Verification must use `timingSafeEqual` (bot-admin-panel already does) and must
check `exp` — bot-admin-panel does not expire its sessions, and that is the one
thing not to copy from it.

`SESSION_SECRET`: 32+ random bytes, required at boot, no insecure development
fallback (bot-admin-panel's `|| "insecure-dev-secret"` is a footgun; fail fast
instead).

### Password storage

`bcryptjs` (pure JS, no native build step — matters on Railway) with cost
factor 12. `users.password_hash` holds the standard `$2b$` modular-crypt string.
Login compares with `bcrypt.compare`; always run a comparison against a dummy
hash when the email is unknown, so response time does not leak account
existence.

### Sessions to build in Phase 2

| Flow | Today (Supabase) | After |
|---|---|---|
| Login | `supabase.auth.signInWithPassword` | verify bcrypt, set `cf_session` |
| Logout | `supabase.auth.signOut` | clear cookie |
| Forced change | `changePasswordForce` + `must_change_password` | same flag, own update |
| Reset request | GoTrue email link | `password_reset_tokens` table + own mailer |
| Reset confirm | `confirmPasswordReset` | consume single-use token, set hash |
| Admin creates user | `auth.admin.createUser` | insert `users` + `employees` in one tx |
| Admin deletes user | `auth.admin.deleteUser` | delete `users` row (`employees.user_id` is `ON DELETE SET NULL`) |
| Impersonation | `impersonate_as` cookie | unchanged pattern |

**Note:** password reset requires an email sender, which Supabase was providing
for free. Pick one (Resend/Postmark/SMTP) in Phase 2 — this is an unbudgeted
dependency, flag it early.

`password_reset_tokens` is not in `db/schema.sql`; it is new surface for Phase 2
and should be added as a follow-up migration (`token_hash`, `user_id`,
`expires_at`, `used_at`).

---

## 2. `middleware.ts` mapping

Current middleware calls `supabase.auth.getUser()` (a network round-trip to
GoTrue on every matched request), then queries `employees` for the `cashier`
redirect.

Replacement, same three responsibilities:

1. **Is there a valid session?** Verify the cookie signature and `exp` locally.
   No network call, no database call — this is strictly faster than today.
2. **Route gating.** Identical logic, unchanged: `/dashboard`, `/chat`,
   `/inventory`, `/cashier` require a session; `/auth/*` redirects away when one
   exists, except `/auth/reset-password` and `/auth/change-password` which
   require one.
3. **Role-based redirect.** The `cashier` check needs a database read, which the
   Edge runtime cannot do over a raw TCP Postgres connection.

For (3), one of:

- **Move it out of middleware** into the `/dashboard` and `/inventory` layouts,
  where a Node-runtime server component can query freely. **Preferred** — it
  keeps middleware pure-crypto and removes a per-request query.
- Or set `export const runtime = 'nodejs'` on the middleware. Supported, but it
  gives up edge execution for every matched route.

Middleware must remain a *convenience* redirect, never the security boundary.
Bypassing it must not grant data access — that is §3's job. This is already true
today (RLS was the real boundary) and the property must be preserved.

Add a fourth responsibility that today lives in `signIn`: if
`must_change_password` is set, every route except `/auth/change-password` and
logout redirects there. Put it in the same layout-level check as the cashier
redirect.

---

## 3. Replacing the 231 RLS policies

### Be honest about what this is

This is **the single largest risk in the entire migration**, larger than the data
load. RLS failed *closed*: a policy you forgot to write meant nobody could read
the rows. Application checks fail *open*: a `requireRole()` you forget to write
means everybody can read the rows, and nothing tells you. The failure mode
inverts, and it inverts silently.

Hand-porting all 231 policies one-to-one is not proposed and should not be
attempted — many are redundant (the 025 `permission_level` policies duplicate the
002-020 `get_my_role()` policies additively), several guard tables the app never
queries, and the storage ones (019) are moot once files move to S3.

What *is* proposed: distil them into a small number of reusable rules, then prove
coverage mechanically.

### The pattern

Extend the `requireOwner()` helper already in `src/actions/auth.ts` into a
family, and make **every** Server Action open with one:

```ts
// Resolves cookie → { userId, employeeId, role, departmentId, permissionLevel,
// impersonating }. Throws if there is no valid session. One query, request-cached.
const actor = await requireActor()

const actor = await requireRole('owner', 'accountant')  // throws otherwise
const actor = await requirePermission('finances', 'edit')  // consults `permissions`
```

Row-scoping — the part RLS did that a role check does not — becomes an explicit
scope applied to the query:

```ts
// 'own' | 'team' | 'all', straight from the permissions table's scope column.
const rows = await db.consultations.findMany(
  scopeFilter(actor, 'consultations', { column: 'manager_id' })
)
```

`scopeFilter` emits: `manager_id = $employeeId` for `own`;
`manager_id IN (SELECT id FROM employees WHERE department_id = $deptId)` for
`team`; no predicate for `all`. That single function reproduces the intent of the
large majority of the 231 policies, because the policies themselves are almost
entirely that same three-way shape repeated per table.

The `permissions` table (seeded by `020_seed_permissions.sql` with a
role × resource × scope matrix) already encodes this. It is currently
decorative — nothing queries it. Phase 2 should make it the actual source of
truth, which turns "231 policies" into "one matrix + one filter function".

### Enforcing coverage

Discipline is not a control. Add mechanism:

- **Default-deny data layer.** Route every query through a repository that
  requires an `actor` argument. A query with no actor should be a *type error*,
  not a code-review catch.
- **Lint rule / CI check** asserting every exported function in
  `src/actions/*.ts` calls a `require*` helper on its first statement.
- **Integration tests per role.** For each of the five roles, drive the main
  read and write paths and assert on rows returned. This is the only thing that
  actually catches a missing scope filter.
- **Keep `audit_logs`.** It is the detection layer when prevention fails.

### The policies that need the most care

Ranked by how much intent would be lost if translated carelessly:

1. **`028_kpi_salary_redesign.sql` (33 policies) — highest risk.**
   This is not role gating; it encodes a *business invariant*: once
   `employee_kpi_results.is_closed = true`, the month is immutable, and
   `is_closed` can only be set through the `close_kpi_month` SECURITY DEFINER
   RPC. The `kpi_results_update_open` policy enforces that with a `WITH CHECK
   (is_closed = false)` — a subtlety that is easy to drop when converting to a
   role check, and dropping it means a closed payroll month becomes editable.
   `kpi_item_results_*` repeat the closed-month guard via `NOT EXISTS`
   subqueries. **This touches money. Port it as an explicit invariant with its
   own tests, and consider keeping a database-level guard (a BEFORE UPDATE
   trigger that rejects writes to closed rows) so it does not depend solely on
   application discipline.**

2. **`025_custom_roles.sql` (29 policies) — highest complexity.**
   It introduced a *second, parallel* authorization axis: `get_my_role()` (system
   roles) and `get_my_permission_level()` (all roles, via `roles.permission_level`),
   with the new policies **additive** to the old ones. Because RLS policies OR
   together, a user can be permitted by either axis. A naive port that picks one
   axis will silently change who can see what — in either direction. Decide
   explicitly which axis survives (recommendation: `permission_level` only, since
   it covers custom roles, with the five system roles mapping onto it) and
   diff the resulting access matrix against production behaviour before shipping.

3. **`documents` — split across `013_documents.sql` (5) and `019_storage.sql` (13).**
   Two layers guarded documents: metadata rows in `public.documents`, and the
   bytes in the `documents` storage bucket. The storage policy
   `documents_select_self` joins back to `public.documents` on
   `storage_path = name` to decide whether an `mp`/`lmai` may read a file.
   Once storage moves to S3 that policy has **no equivalent** — object stores do
   not run your SQL. Access control must move into a signed-URL issuing endpoint
   that performs the same check before minting a time-limited URL. If this is
   overlooked, every document becomes readable by anyone who can guess or
   retain a URL. Salary sheets and contracts live in that bucket.

4. **`007_consultations.sql` (13) + `009_salaries.sql` (12)** — the `rop`
   team-scope policies use `EXISTS` joins through `employees.department_id`.
   Straightforward to port, but they are the highest-traffic paths; get the
   `team` scope filter right once and they all follow.

5. **`015_audit_logs.sql` (2)** — append-only was enforced by the *absence* of
   UPDATE/DELETE policies. Absence does not translate: with RLS gone, the table
   is fully writable. Restore the guarantee with `REVOKE UPDATE, DELETE` on the
   table from the application role, or a trigger that raises on either.

Lower risk, port mechanically: 002/003/006/010/011/012/014/026/030/033
(owner-writes/all-read), 036/042 (deals & games, simple role lists),
032 (tasks — `can_see_task` is already a single reusable predicate, kept in
`db/schema.sql` with the viewer as an explicit parameter).

---

## 4. Functions rewritten to drop `auth.uid()`

Recorded here because it changes the calling convention for Phase 2.

| Original | New signature | Note |
|---|---|---|
| `get_my_employee_id()` | `get_employee_id(p_user_id uuid)` | renamed, param added |
| `get_my_role()` | `get_role(p_user_id uuid)` | renamed, param added |
| `get_my_department_id()` | `get_department_id(p_user_id uuid)` | renamed, param added |
| `get_my_permission_level()` | `get_permission_level(p_user_id uuid)` | renamed, param added |
| `can_see_task(...)` | `can_see_task(p_user_id uuid, ...)` | viewer now explicit |
| `can_see_deal(d_responsible)` | `can_see_deal(p_user_id uuid, d_responsible uuid)` | viewer now explicit |
| `close_kpi_month(emp, y, m)` | `close_kpi_month(p_actor_user_id uuid, emp, y, m)` | internal role check preserved |
| `log_deal_stage_change()` | unchanged signature (trigger) | reads `current_employee_id()` |

New helper `current_employee_id()` reads the transaction-local GUC
`app.current_employee_id`. Phase 2 must set it at the start of every request's
transaction:

```sql
SELECT set_config('app.current_employee_id', $1, true);
```

Forgetting it is not a security hole — it only means `deal_events.employee_id`
comes out NULL, i.e. "unattributed", the same as bot writes today. But it is a
silent audit-quality regression, so put it in the connection/transaction wrapper
rather than in call sites.

`handle_new_user()` (024) is **deleted, not ported** — it was a no-op trigger on
`auth.users`, which no longer exists.

---

## 5. Open questions for a human, before Phase 2 starts

1. **Session mechanism: accept the self-rolled-cookie recommendation, or
   overrule it in favour of NextAuth v5?** Everything downstream depends on this.
2. **Password migration: Path A or Path B (`db/MIGRATION_PLAN.md` §3)?**
   Recommendation is Path B — force a reset for everyone — but it needs a
   decision and a heads-up to staff.
3. **Which authorization axis survives, `role` or `permission_level`?**
   (See risk #2 above.) Keeping both reproduces today's ambiguity in a place
   where it is much harder to reason about.
4. **Does the `permissions` table become live?** It is currently unused seed
   data. Making it the source of truth is the difference between one filter
   function and a hand-written check per table.
5. **Closed-month immutability: application-only, or a database trigger too?**
   This guards payroll. Recommendation: both.
6. **Document access after S3.** Who issues signed URLs, with what TTL, and does
   the `mp`/`lmai` own-documents-only rule survive? Needs an owner.
7. **Transactional email provider** for password reset — an unbudgeted service
   Supabase was supplying.
8. **`audit_logs` CHECK vs. `impersonation_start`/`impersonation_end`.**
   `src/actions/auth.ts` writes those two actions; the CHECK constraint rejects
   them, so those audit rows are being silently lost today. Widen the CHECK or
   fix the caller — but decide, do not carry the bug forward unexamined.
