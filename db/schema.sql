-- =============================================================================
-- CashflowCRM — consolidated plain-PostgreSQL schema (Railway target)
-- Phase 1 of the Supabase → self-hosted Postgres 16 migration.
--
-- Source of truth: supabase/migrations/001..042 + 20260810154527, replayed to
-- their FINAL state (renames of 026a applied, tables dropped in 025a / 029
-- omitted). This file is meant to be applied ONCE to an empty database:
--   psql "$DATABASE_URL" -f db/schema.sql
--
-- -----------------------------------------------------------------------------
-- DECISION 1 — Row Level Security is NOT reproduced here.
-- -----------------------------------------------------------------------------
-- The Supabase schema carries ~231 RLS policies, every one of which resolves
-- the current actor through `auth.uid()` — a GoTrue/PostgREST construct that
-- does not exist outside Supabase. Outside Supabase the app connects with ONE
-- pooled role, so per-row policies keyed to a session identity have nothing to
-- key on and would either be no-ops or lock everyone out.
--
-- Therefore: no ENABLE ROW LEVEL SECURITY, no CREATE POLICY, no GRANTs to
-- anon/authenticated/service_role (035_role_grants.sql is Supabase-only).
-- Authorization moves ENTIRELY to the application layer — see db/AUTH_DESIGN.md
-- for the requireRole()/requirePermission() pattern that replaces it.
--
-- CONSEQUENCE, stated plainly: until that application-layer enforcement is
-- written (Phase 2), this database has NO access control beyond the connection
-- credential. Do not point a partially-migrated app at production data.
--
-- -----------------------------------------------------------------------------
-- DECISION 2 — auth.users is replaced by public.users.
-- -----------------------------------------------------------------------------
-- employees.user_id used to reference auth.users(id). It now references
-- public.users(id), a plain table holding email + a bcrypt password_hash that
-- our own auth code manages. 024_fix_handle_new_user_trigger.sql (a no-op
-- trigger on auth.users) is dropped entirely — there is no auth.users to hook.
--
-- -----------------------------------------------------------------------------
-- DECISION 3 — auth.uid() removed from function bodies.
-- -----------------------------------------------------------------------------
-- Helper functions that used to read auth.uid() now take the caller's user id
-- as an explicit parameter. Trigger functions, which cannot take parameters,
-- read the optional session GUC `app.current_employee_id` instead; the app sets
-- it per transaction (SELECT set_config('app.current_employee_id', $1, true))
-- and it degrades to NULL when unset. Full list in db/AUTH_DESIGN.md.
--
-- -----------------------------------------------------------------------------
-- OUT OF SCOPE (deliberately absent)
-- -----------------------------------------------------------------------------
--   * 019_storage.sql — storage.buckets (avatars / logos / documents) and their
--     policies. File storage moves to an S3-compatible service in a later
--     phase; public.documents.storage_path stays and will hold the new key.
--   * 018_realtime.sql and every `ALTER PUBLICATION supabase_realtime ...`.
--     The six Realtime subscribers become polling in a later phase.
--   * SECURITY DEFINER on all functions. It exists in the original solely to
--     let functions bypass RLS; with no RLS it only adds risk.
--
-- -----------------------------------------------------------------------------
-- VERIFIED against the live Supabase project (2026-08-29)
-- -----------------------------------------------------------------------------
-- Introspected via the PostgREST OpenAPI document of the one and only Supabase
-- project backing this app (ref tmbynmssxviiowtxtxtg), captured verbatim in
-- db/live-schema-openapi.json. Result:
--
--   * The live public schema exposes exactly 41 tables. All 41 appear in this
--     file with identical column NAMES, TYPES, NULLABILITY and DEFAULTS. There
--     is no schema drift. (public.users below is a Phase 1 addition replacing
--     Supabase's auth.users — by design, not drift.)
--   * Migration numbers 034, 037, 038, 040, 041: RESOLVED. The live catalog
--     contains no table, column or default that the committed migrations do not
--     account for, so those numbers never produced public-schema DDL — they
--     were skipped, or were local/aborted work. deal_stages.description (039)
--     and deals.city/deals.address (20260810154527) are both present, which
--     brackets the gap on both sides.
--   * public.marketing_daily_data DOES NOT EXIST in the live database
--     (PostgREST 404). The app queries it anyway
--     (src/lib/data/adapters/marketing/SupabaseMarketingAdapter.ts,
--     src/app/dashboard/calendar/page.tsx). Phase 1 invented a definition from
--     the selected columns; that invention has been REMOVED — see §22.
--   * Note: PostgREST's OpenAPI output omits defaults for jsonb columns, so
--     kpi_templates.metrics DEFAULT '{}' and settings.extra DEFAULT '{}' were
--     confirmed from migrations 006/014 rather than from the live catalog.
--   * middleware.ts gates /inventory and /cashier and knows a 'cashier' role,
--     but no such routes or tables exist in this repo and no migration adds
--     them. Treated as dead/forward-looking; nothing added for them.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid(), used by every table
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- company_plans EXCLUDE constraint (030)


-- =============================================================================
-- 0. Shared trigger function (001)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


-- =============================================================================
-- 1. users — replaces auth.users
-- =============================================================================

CREATE TABLE public.users (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- 2. roles + permissions (002, 020, 025)
-- =============================================================================

CREATE TABLE public.roles (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(50)  NOT NULL,
  label            VARCHAR(100) NOT NULL,
  description      TEXT,
  is_system        BOOLEAN      NOT NULL DEFAULT false,
  -- 025: arbitrary role names allowed; access derives from permission_level.
  permission_level VARCHAR(20)  NOT NULL DEFAULT 'employee',
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT roles_name_unique UNIQUE (name),
  -- 025 dropped roles_name_check on purpose (custom roles).
  CONSTRAINT roles_permission_level_check CHECK (
    permission_level IN ('owner','department_head','employee','accountant')
  )
);

CREATE INDEX idx_roles_name ON public.roles(name);

CREATE TRIGGER set_roles_updated_at
  BEFORE UPDATE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.roles (name, label, description, is_system, permission_level) VALUES
  ('owner',      'Владелец',                   'Полный доступ ко всем данным системы',  true, 'owner'),
  ('rop',        'Руководитель отдела продаж', 'Управление командой МП, просмотр аналитики', true, 'department_head'),
  ('mp',         'Менеджер по продажам',       'Ведение записей и своей декомпозиции',  true, 'employee'),
  ('lmai',       'Менеджер по лидогенерации',  'Ведение своих показателей LMAI',        true, 'employee'),
  ('accountant', 'Бухгалтер',                  'Доступ к финансам и зарплатам',         true, 'accountant');

CREATE TABLE public.permissions (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id    UUID         NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  resource   VARCHAR(100) NOT NULL,
  can_view   BOOLEAN      NOT NULL DEFAULT false,
  can_create BOOLEAN      NOT NULL DEFAULT false,
  can_edit   BOOLEAN      NOT NULL DEFAULT false,
  can_delete BOOLEAN      NOT NULL DEFAULT false,
  scope      TEXT         NOT NULL DEFAULT 'own',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT permissions_role_resource_unique UNIQUE (role_id, resource),
  CONSTRAINT permissions_scope_check CHECK (scope IN ('own','team','all'))
);

CREATE INDEX idx_permissions_role_id  ON public.permissions(role_id);
CREATE INDEX idx_permissions_resource ON public.permissions(resource);

CREATE TRIGGER set_permissions_updated_at
  BEFORE UPDATE ON public.permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- 3. departments + employees (003, 004, 023)
-- =============================================================================

CREATE TABLE public.departments (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  manager_id  UUID,  -- FK added after employees exists
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_departments_manager_id ON public.departments(manager_id);

CREATE TRIGGER set_departments_updated_at
  BEFORE UPDATE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.employees (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- was: REFERENCES auth.users(id)
  user_id              UUID          UNIQUE REFERENCES public.users(id) ON DELETE SET NULL,
  department_id        UUID          REFERENCES public.departments(id) ON DELETE SET NULL,
  name                 VARCHAR(255)  NOT NULL,
  phone                VARCHAR(20),
  email                VARCHAR(255)  NOT NULL,
  role                 TEXT          NOT NULL DEFAULT 'mp',
  avatar_url           TEXT,
  hire_date            DATE,
  birth_date           DATE,
  base_salary          NUMERIC(12,2) NOT NULL DEFAULT 0,
  kpi_coefficient      NUMERIC(5,2)  NOT NULL DEFAULT 1.0,
  schedule_type        TEXT          NOT NULL DEFAULT '5/2',
  work_start_time      TIME          DEFAULT '09:00',
  work_end_time        TIME          DEFAULT '18:00',
  status               TEXT          NOT NULL DEFAULT 'active',
  notes                TEXT,
  must_change_password BOOLEAN       NOT NULL DEFAULT true,  -- 023
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT employees_email_unique UNIQUE (email),
  -- employees_role_check dropped in 025 (custom roles); role is validated
  -- against roles.name by the application.
  CONSTRAINT employees_status_check CHECK (status IN ('active','probation','archived')),
  CONSTRAINT employees_schedule_check CHECK (
    schedule_type IN ('5/2','2/2','1/1','3/3','weekends','custom')
  ),
  CONSTRAINT employees_base_salary_check CHECK (base_salary >= 0),
  CONSTRAINT employees_kpi_coefficient_check CHECK (kpi_coefficient >= 0)
);

CREATE INDEX idx_employees_user_id ON public.employees(user_id);
CREATE INDEX idx_employees_role    ON public.employees(role);
CREATE INDEX idx_employees_status  ON public.employees(status);
CREATE INDEX idx_employees_deleted ON public.employees(deleted_at) WHERE deleted_at IS NULL;

CREATE TRIGGER set_employees_updated_at
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.departments
  ADD CONSTRAINT departments_manager_id_fkey
  FOREIGN KEY (manager_id) REFERENCES public.employees(id) ON DELETE SET NULL;

INSERT INTO public.departments (name, description) VALUES
  ('Отдел продаж', 'Основной отдел продаж Demi Results');


-- =============================================================================
-- 4. Actor-resolution helpers — auth.uid() replaced by an explicit parameter
--    (001, 025). Kept as SQL functions so business logic can still call them.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_employee_id(p_user_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT id FROM public.employees WHERE user_id = p_user_id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_role(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT role FROM public.employees WHERE user_id = p_user_id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_department_id(p_user_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT department_id FROM public.employees WHERE user_id = p_user_id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_permission_level(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT r.permission_level
      FROM public.employees e
      JOIN public.roles r ON r.name = e.role AND r.deleted_at IS NULL
      WHERE e.user_id = p_user_id
      LIMIT 1
    ),
    'employee'
  );
$$;

-- Trigger-visible actor. Triggers take no parameters, so the app announces the
-- acting employee per transaction:
--     SELECT set_config('app.current_employee_id', $employee_id, true);
-- Unset (bot / cron / migration) yields NULL, which every consumer tolerates.
CREATE OR REPLACE FUNCTION public.current_employee_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_raw TEXT;
BEGIN
  v_raw := NULLIF(current_setting('app.current_employee_id', true), '');
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_raw::UUID;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;


-- =============================================================================
-- 5. schedules + attendance (005)
-- =============================================================================

CREATE TABLE public.schedules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date        DATE        NOT NULL,
  is_workday  BOOLEAN     NOT NULL DEFAULT true,
  work_start  TIME,
  work_end    TIME,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT schedules_emp_date_unique UNIQUE (employee_id, date)
);

CREATE INDEX idx_schedules_employee_id ON public.schedules(employee_id);
CREATE INDEX idx_schedules_date        ON public.schedules(date);
CREATE INDEX idx_schedules_emp_date    ON public.schedules(employee_id, date);

CREATE TRIGGER set_schedules_updated_at
  BEFORE UPDATE ON public.schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.attendance (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date        DATE        NOT NULL,
  status      TEXT        NOT NULL,
  comment     TEXT,
  marked_by   UUID        REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT attendance_emp_date_unique UNIQUE (employee_id, date),
  CONSTRAINT attendance_status_check CHECK (
    status IN ('worked','sick','day_off','vacation','absent','remote')
  )
);

CREATE INDEX idx_attendance_employee_id ON public.attendance(employee_id);
CREATE INDEX idx_attendance_date        ON public.attendance(date);
CREATE INDEX idx_attendance_emp_date    ON public.attendance(employee_id, date);
CREATE INDEX idx_attendance_status      ON public.attendance(status);

CREATE TRIGGER set_attendance_updated_at
  BEFORE UPDATE ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- 6. work_schedules (026)
-- =============================================================================

CREATE TABLE public.work_schedules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  is_system   BOOLEAN     NOT NULL DEFAULT false,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.work_schedules (name, description, is_system) VALUES
  ('5/2',       'Стандартная пятидневка (Пн–Пт)',        true),
  ('2/2',       '2 дня работы, 2 выходных (скользящий)', true),
  ('6/1',       '6 дней работы, 1 выходной',             true),
  ('3 через 1', '3 дня работы, 1 выходной (скользящий)', true);


-- =============================================================================
-- 7. kpi_templates + employee_kpi (006)
-- =============================================================================

CREATE TABLE public.kpi_templates (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  role                  TEXT          NOT NULL,
  name                  VARCHAR(100)  NOT NULL,
  is_default            BOOLEAN       NOT NULL DEFAULT false,
  metrics               JSONB         NOT NULL DEFAULT '{}',
  min_threshold_pct     NUMERIC(5,2)  NOT NULL DEFAULT 30.0,
  over_plan_coefficient NUMERIC(5,2)  NOT NULL DEFAULT 1.2,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT kpi_templates_role_check CHECK (role IN ('mp','lmai'))
);

CREATE UNIQUE INDEX idx_kpi_templates_one_default
  ON public.kpi_templates(role) WHERE is_default = true;
CREATE INDEX idx_kpi_templates_role ON public.kpi_templates(role);

CREATE TRIGGER set_kpi_templates_updated_at
  BEFORE UPDATE ON public.kpi_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.kpi_templates (role, name, is_default, metrics, min_threshold_pct, over_plan_coefficient) VALUES
  ('mp',   'Стандартный шаблон МП',   true,
   '{"fv":{"label":"ФВ","weight":40},"sales":{"label":"Продажи","weight":35},"revenue":{"label":"Выручка","weight":25}}',
   30.0, 1.2),
  ('lmai', 'Стандартный шаблон LMAI', true,
   '{"appeals":{"label":"Обращения","weight":40},"leads":{"label":"Лиды","weight":40},"nv":{"label":"НВ","weight":20}}',
   30.0, 1.2);

CREATE TABLE public.employee_kpi (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  period_year     SMALLINT      NOT NULL,
  period_month    SMALLINT      NOT NULL,
  kpi_template_id UUID          REFERENCES public.kpi_templates(id) ON DELETE SET NULL,
  plan_fv         INTEGER,
  plan_sales      INTEGER,
  plan_revenue    NUMERIC(12,2),
  plan_appeals    INTEGER,
  plan_leads      INTEGER,
  plan_nv         INTEGER,
  plan_work_days  SMALLINT,
  notes           TEXT,
  created_by      UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT employee_kpi_emp_period_unique UNIQUE (employee_id, period_year, period_month),
  CONSTRAINT employee_kpi_month_check   CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT employee_kpi_year_check    CHECK (period_year BETWEEN 2020 AND 2100),
  CONSTRAINT employee_kpi_fv_check      CHECK (plan_fv IS NULL OR plan_fv >= 0),
  CONSTRAINT employee_kpi_sales_check   CHECK (plan_sales IS NULL OR plan_sales >= 0),
  CONSTRAINT employee_kpi_revenue_check CHECK (plan_revenue IS NULL OR plan_revenue >= 0)
);

CREATE INDEX idx_employee_kpi_emp_id     ON public.employee_kpi(employee_id);
CREATE INDEX idx_employee_kpi_period     ON public.employee_kpi(period_year, period_month);
CREATE INDEX idx_employee_kpi_emp_period ON public.employee_kpi(employee_id, period_year, period_month);

CREATE TRIGGER set_employee_kpi_updated_at
  BEFORE UPDATE ON public.employee_kpi
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- 8. consultations (007, 022)
--    consultation_results was dropped in 025a and is not recreated.
-- =============================================================================

CREATE TABLE public.consultations (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id        UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  recorded_by_id    UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  date              DATE          NOT NULL,
  time              TIME,
  client_name       VARCHAR(255)  NOT NULL,
  phone             VARCHAR(20),
  deal_number       VARCHAR(20),
  format            TEXT,
  recorded_by       VARCHAR(255),
  status            TEXT,
  actual_status     TEXT,
  status_after_fv   TEXT,
  alb_status        TEXT,   -- 022
  consulting_doctor TEXT,   -- 022
  amount            NUMERIC(12,2) NOT NULL DEFAULT 0,
  delivery_cost     NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_nv             BOOLEAN       NOT NULL DEFAULT false,
  comment           TEXT,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT consultations_status_check CHECK (
    status IS NULL OR status IN ('Придёт','Не придёт','Перезапись','Отменил','Не отвечает')
  ),
  CONSTRAINT consultations_actual_status_check CHECK (
    actual_status IS NULL OR actual_status IN ('Пришла','Не пришла')
  ),
  CONSTRAINT consultations_status_after_fv_check CHECK (
    status_after_fv IS NULL OR status_after_fv IN ('Купила','Не купила','Предоплата','Дожать','Отказ')
  ),
  CONSTRAINT consultations_alb_status_check CHECK (
    alb_status IS NULL OR alb_status IN ('Не записан','Записан','Пришёл','Не пришёл','Купил')
  ),
  CONSTRAINT consultations_format_check CHECK (
    format IS NULL OR format IN ('Онлайн','Офлайн')
  ),
  CONSTRAINT consultations_amount_check CHECK (amount >= 0),
  CONSTRAINT consultations_delivery_cost_check CHECK (delivery_cost >= 0)
);

CREATE INDEX idx_consultations_manager_id   ON public.consultations(manager_id);
CREATE INDEX idx_consultations_date         ON public.consultations(date);
CREATE INDEX idx_consultations_status_after ON public.consultations(status_after_fv);
CREATE INDEX idx_consultations_is_nv        ON public.consultations(is_nv);
CREATE INDEX idx_consultations_deleted      ON public.consultations(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_consultations_date_manager ON public.consultations(date, manager_id);
CREATE INDEX idx_consultations_client_phone ON public.consultations(phone);

CREATE TRIGGER set_consultations_updated_at
  BEFORE UPDATE ON public.consultations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- 9. daily_activity + sales_plan_weekly (008, renamed by 026a)
--    Index/constraint names intentionally keep their original spelling, as they
--    did in production after the manual rename.
-- =============================================================================

CREATE TABLE public.daily_activity (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date            DATE          NOT NULL,
  fv_fact         INTEGER,
  sales_fact      INTEGER,
  revenue_fact    NUMERIC(12,2),
  nv_fact         INTEGER,
  nv_sales_fact   INTEGER,
  nv_revenue_fact NUMERIC(12,2),
  appeals_fact    INTEGER,
  leads_fact      INTEGER,
  notes           TEXT,
  created_by      UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT daily_facts_emp_date_unique UNIQUE (employee_id, date),
  CONSTRAINT daily_facts_fv_check      CHECK (fv_fact IS NULL OR fv_fact >= 0),
  CONSTRAINT daily_facts_sales_check   CHECK (sales_fact IS NULL OR sales_fact >= 0),
  CONSTRAINT daily_facts_revenue_check CHECK (revenue_fact IS NULL OR revenue_fact >= 0)
);

CREATE INDEX idx_daily_facts_emp_id   ON public.daily_activity(employee_id);
CREATE INDEX idx_daily_facts_date     ON public.daily_activity(date);
CREATE INDEX idx_daily_facts_emp_date ON public.daily_activity(employee_id, date);

CREATE TRIGGER set_daily_facts_updated_at
  BEFORE UPDATE ON public.daily_activity
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.sales_plan_weekly (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id          UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  period_year          SMALLINT      NOT NULL,
  period_month         SMALLINT      NOT NULL,
  total_fv_plan        INTEGER       NOT NULL DEFAULT 0,
  total_fv_fact        INTEGER       NOT NULL DEFAULT 0,
  total_sales_plan     INTEGER       NOT NULL DEFAULT 0,
  total_sales_fact     INTEGER       NOT NULL DEFAULT 0,
  total_revenue_plan   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_revenue_fact   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_work_days_plan SMALLINT      NOT NULL DEFAULT 0,
  total_work_days_fact SMALLINT      NOT NULL DEFAULT 0,
  kpi_pct              NUMERIC(5,2)  NOT NULL DEFAULT 0,
  last_calculated_at   TIMESTAMPTZ,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT decomposition_emp_period_unique UNIQUE (employee_id, period_year, period_month),
  CONSTRAINT decomposition_month_check CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT decomposition_kpi_check   CHECK (kpi_pct >= 0)
);

CREATE INDEX idx_decomposition_emp_id  ON public.sales_plan_weekly(employee_id);
CREATE INDEX idx_decomposition_period  ON public.sales_plan_weekly(period_year, period_month);
CREATE INDEX idx_decomposition_emp_per ON public.sales_plan_weekly(employee_id, period_year, period_month);

CREATE TRIGGER set_decomposition_updated_at
  BEFORE UPDATE ON public.sales_plan_weekly
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- 10. salaries + salary_calculations (009, 028 §8)
-- =============================================================================

CREATE TABLE public.salaries (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID          NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  period_year    SMALLINT      NOT NULL,
  period_month   SMALLINT      NOT NULL,
  base_salary    NUMERIC(12,2) NOT NULL DEFAULT 0,
  kpi_bonus      NUMERIC(12,2) NOT NULL DEFAULT 0,
  bonuses        NUMERIC(12,2) NOT NULL DEFAULT 0,
  deductions     NUMERIC(12,2) NOT NULL DEFAULT 0,
  advance_amount NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 028
  total_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  kpi_pct        NUMERIC(5,2)  NOT NULL DEFAULT 0,
  work_days_fact SMALLINT      NOT NULL DEFAULT 0,
  work_days_plan SMALLINT      NOT NULL DEFAULT 0,
  status         TEXT          NOT NULL DEFAULT 'draft',
  paid_at        TIMESTAMPTZ,
  paid_by        UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  notes          TEXT,
  calculated_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT salaries_emp_period_unique UNIQUE (employee_id, period_year, period_month),
  CONSTRAINT salaries_status_check CHECK (status IN ('draft','calculated','paid')),
  CONSTRAINT salaries_month_check  CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT salaries_amount_check CHECK (total_amount >= 0)
);

CREATE INDEX idx_salaries_emp_id ON public.salaries(employee_id);
CREATE INDEX idx_salaries_period ON public.salaries(period_year, period_month);
CREATE INDEX idx_salaries_status ON public.salaries(status);

CREATE TRIGGER set_salaries_updated_at
  BEFORE UPDATE ON public.salaries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.salary_calculations (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  salary_id   UUID          NOT NULL REFERENCES public.salaries(id) ON DELETE CASCADE,
  type        TEXT          NOT NULL,
  description VARCHAR(255)  NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  metric_name VARCHAR(100),
  metric_plan NUMERIC(10,2),
  metric_fact NUMERIC(10,2),
  metric_pct  NUMERIC(5,2),
  weight      NUMERIC(5,2),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT salary_calc_type_check CHECK (
    type IN ('base_salary','kpi_bonus','manual_bonus','deduction','day_adjustment')
  )
);

CREATE INDEX idx_salary_calc_salary_id ON public.salary_calculations(salary_id);


-- =============================================================================
-- 11. Finance (010, 013 FK, renamed by 026a)
-- =============================================================================

CREATE TABLE public.finance_categories (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(100) NOT NULL,
  type       TEXT         NOT NULL,
  color      VARCHAR(7)   DEFAULT '#6b7280',
  icon       VARCHAR(50),
  is_system  BOOLEAN      NOT NULL DEFAULT false,
  is_active  BOOLEAN      NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT finance_categories_type_check CHECK (type IN ('income','expense')),
  CONSTRAINT finance_categories_name_type_unique UNIQUE (name, type)
);

CREATE INDEX idx_finance_categories_type ON public.finance_categories(type);

CREATE TRIGGER set_finance_categories_updated_at
  BEFORE UPDATE ON public.finance_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.finance_categories (name, type, color, icon, is_system) VALUES
  ('Продажи',           'income',  '#16a34a', 'trending-up',     true),
  ('Инвестиции',        'income',  '#0c4d6c', 'landmark',        false),
  ('Прочие поступления','income',  '#6b7280', 'plus-circle',     false),
  ('Зарплата',          'expense', '#dc2626', 'users',           true),
  ('Выплата инвестору', 'expense', '#0c2136', 'banknote',        true),
  ('Аренда',            'expense', '#d97706', 'building',        false),
  ('Маркетинг',         'expense', '#7c3aed', 'megaphone',       false),
  ('Доставка',          'expense', '#059669', 'truck',           false),
  ('Коммунальные',      'expense', '#6b7280', 'zap',             false),
  ('Прочее',            'expense', '#9ca3af', 'more-horizontal', false);

CREATE TABLE public.finance_transactions (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID          NOT NULL REFERENCES public.finance_categories(id) ON DELETE RESTRICT,
  type        TEXT          NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  date        DATE          NOT NULL,
  description TEXT,
  source_type TEXT,
  source_id   UUID,
  created_by  UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  document_id UUID,  -- FK added after documents exists
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT fin_trans_type_check   CHECK (type IN ('income','expense')),
  CONSTRAINT fin_trans_amount_check CHECK (amount > 0),
  CONSTRAINT fin_trans_source_check CHECK (
    source_type IS NULL OR source_type IN ('manual','consultation','salary','investor_payout')
  )
);

CREATE INDEX idx_fin_trans_category_id ON public.finance_transactions(category_id);
CREATE INDEX idx_fin_trans_type        ON public.finance_transactions(type);
CREATE INDEX idx_fin_trans_date        ON public.finance_transactions(date);
CREATE INDEX idx_fin_trans_source      ON public.finance_transactions(source_type, source_id);
CREATE INDEX idx_fin_trans_deleted     ON public.finance_transactions(deleted_at) WHERE deleted_at IS NULL;

CREATE TRIGGER set_finance_transactions_updated_at
  BEFORE UPDATE ON public.finance_transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.finance_periods (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  period_year        SMALLINT      NOT NULL,
  period_month       SMALLINT      NOT NULL,
  total_income       NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_expense      NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_profit         NUMERIC(12,2) NOT NULL DEFAULT 0,
  margin_pct         NUMERIC(5,2)  NOT NULL DEFAULT 0,
  last_calculated_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT finances_period_unique UNIQUE (period_year, period_month)
);

CREATE INDEX idx_finances_period ON public.finance_periods(period_year, period_month);

CREATE TRIGGER set_finances_updated_at
  BEFORE UPDATE ON public.finance_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- 12. investors + investor_payouts (011)
-- =============================================================================

CREATE TABLE public.investors (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(255)  NOT NULL,
  phone             VARCHAR(20),
  email             VARCHAR(255),
  share_pct         NUMERIC(5,2)  NOT NULL DEFAULT 0,
  investment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  investment_date   DATE,
  is_active         BOOLEAN       NOT NULL DEFAULT true,
  notes             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT investors_share_check  CHECK (share_pct BETWEEN 0 AND 100),
  CONSTRAINT investors_amount_check CHECK (investment_amount >= 0)
);

CREATE INDEX idx_investors_is_active ON public.investors(is_active);

CREATE TRIGGER set_investors_updated_at
  BEFORE UPDATE ON public.investors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.investor_payouts (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id    UUID          NOT NULL REFERENCES public.investors(id) ON DELETE CASCADE,
  amount         NUMERIC(12,2) NOT NULL,
  date           DATE          NOT NULL,
  type           TEXT          NOT NULL DEFAULT 'dividend',
  description    TEXT,
  transaction_id UUID          REFERENCES public.finance_transactions(id) ON DELETE SET NULL,
  created_by     UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT investor_payouts_amount_check CHECK (amount > 0),
  CONSTRAINT investor_payouts_type_check   CHECK (type IN ('dividend','return','other'))
);

CREATE INDEX idx_investor_payouts_investor_id ON public.investor_payouts(investor_id);
CREATE INDEX idx_investor_payouts_date        ON public.investor_payouts(date);

CREATE TRIGGER set_investor_payouts_updated_at
  BEFORE UPDATE ON public.investor_payouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- 13. notifications (012, 031, 042)
-- =============================================================================

CREATE TABLE public.notifications (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID         NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  type         TEXT         NOT NULL,
  title        VARCHAR(255) NOT NULL,
  body         TEXT,
  action_url   TEXT,
  is_read      BOOLEAN      NOT NULL DEFAULT false,
  is_important BOOLEAN      NOT NULL DEFAULT false,
  source_type  TEXT,
  source_id    UUID,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT notifications_type_check CHECK (
    type IN (
      'kpi_alert','kpi_success','plan_100','absence',
      'salary_ready','finance_alert','system','sale',
      'consultation_booked','consultation_reminder','sale_lead',
      'server_load','deploy','security','audit','game_booking'
    )
  )
);

CREATE INDEX idx_notifications_emp_id  ON public.notifications(employee_id);
CREATE INDEX idx_notifications_is_read ON public.notifications(is_read) WHERE is_read = false;
CREATE INDEX idx_notifications_created ON public.notifications(created_at DESC);
CREATE INDEX idx_notifications_type    ON public.notifications(type);


-- =============================================================================
-- 14. documents + document_folders (013, 033)
--     Storage buckets themselves are out of scope (see header).
-- =============================================================================

CREATE TABLE public.document_folders (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(255) NOT NULL,
  parent_id  UUID         REFERENCES public.document_folders(id) ON DELETE CASCADE,
  created_by UUID         REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_document_folders_parent ON public.document_folders(parent_id);

CREATE TABLE public.documents (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  category      TEXT         NOT NULL DEFAULT 'other',
  storage_path  TEXT         NOT NULL,
  mime_type     VARCHAR(100),
  size_bytes    BIGINT,
  uploaded_by   UUID         REFERENCES public.employees(id) ON DELETE SET NULL,
  related_type  TEXT,
  related_id    UUID,
  folder_id     UUID         REFERENCES public.document_folders(id) ON DELETE SET NULL,  -- 033
  is_generated  BOOLEAN      NOT NULL DEFAULT false,
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT documents_category_check CHECK (
    category IN ('contract','regulation','financial','salary_sheet','template','other')
  ),
  CONSTRAINT documents_size_check CHECK (size_bytes IS NULL OR size_bytes > 0)
);

CREATE INDEX idx_documents_category    ON public.documents(category);
CREATE INDEX idx_documents_related     ON public.documents(related_type, related_id);
CREATE INDEX idx_documents_uploaded_by ON public.documents(uploaded_by);
CREATE INDEX idx_documents_deleted     ON public.documents(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_folder      ON public.documents(folder_id);

CREATE TRIGGER set_documents_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.finance_transactions
  ADD CONSTRAINT finance_transactions_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;


-- =============================================================================
-- 15. integrations + settings (014)
-- =============================================================================

CREATE TABLE public.integrations (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(100) NOT NULL,
  type             TEXT         NOT NULL,
  is_active        BOOLEAN      NOT NULL DEFAULT false,
  config           JSONB,
  last_sync_at     TIMESTAMPTZ,
  last_sync_status TEXT,
  last_sync_error  TEXT,
  webhook_url      TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT integrations_name_unique UNIQUE (name),
  CONSTRAINT integrations_type_check  CHECK (type IN ('crm','telegram','sheets','shop','other'))
);

CREATE INDEX idx_integrations_type      ON public.integrations(type);
CREATE INDEX idx_integrations_is_active ON public.integrations(is_active);

CREATE TRIGGER set_integrations_updated_at
  BEFORE UPDATE ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.integrations (name, type) VALUES
  ('amoCRM',        'crm'),
  ('Telegram',      'telegram'),
  ('Google Sheets', 'sheets');

CREATE TABLE public.settings (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name        VARCHAR(255)  NOT NULL DEFAULT 'Demi Results',
  logo_url            TEXT,
  timezone            VARCHAR(50)   NOT NULL DEFAULT 'Asia/Bishkek',
  currency            VARCHAR(10)   NOT NULL DEFAULT 'KGS',
  week_start_day      SMALLINT      NOT NULL DEFAULT 1,
  month_start_day     SMALLINT      NOT NULL DEFAULT 1,
  salary_close_day    SMALLINT      NOT NULL DEFAULT 25,
  salary_pay_day      SMALLINT      NOT NULL DEFAULT 5,
  default_work_start  TIME          NOT NULL DEFAULT '09:00',
  default_work_end    TIME          NOT NULL DEFAULT '18:00',
  absence_alert_time  TIME          NOT NULL DEFAULT '12:00',
  kpi_alert_threshold NUMERIC(5,2)  NOT NULL DEFAULT 30.0,
  theme               TEXT          NOT NULL DEFAULT 'light',
  language            VARCHAR(5)    NOT NULL DEFAULT 'ru',
  extra               JSONB         DEFAULT '{}',
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT settings_week_start_check   CHECK (week_start_day BETWEEN 1 AND 7),
  CONSTRAINT settings_month_start_check  CHECK (month_start_day BETWEEN 1 AND 28),
  CONSTRAINT settings_salary_close_check CHECK (salary_close_day BETWEEN 1 AND 31),
  CONSTRAINT settings_salary_pay_check   CHECK (salary_pay_day BETWEEN 1 AND 31),
  CONSTRAINT settings_theme_check        CHECK (theme IN ('light','dark','system'))
);

CREATE TRIGGER set_settings_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Singleton: exactly one row. RLS used to forbid INSERT/DELETE; the app must
-- now enforce it, so the invariant is pinned here instead.
CREATE UNIQUE INDEX settings_singleton ON public.settings((true));

INSERT INTO public.settings (company_name, timezone, currency) VALUES
  ('Demi Results', 'Asia/Bishkek', 'KGS');


-- =============================================================================
-- 16. audit_logs (015) — append-only by convention; enforce in the app layer.
-- =============================================================================

CREATE TABLE public.audit_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID        REFERENCES public.employees(id) ON DELETE SET NULL,
  action        TEXT        NOT NULL,
  resource_type TEXT        NOT NULL,
  resource_id   UUID,
  old_data      JSONB,
  new_data      JSONB,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT audit_logs_action_check CHECK (
    action IN ('create','update','delete','login','logout','export','view')
  )
);

CREATE INDEX idx_audit_employee_id ON public.audit_logs(employee_id);
CREATE INDEX idx_audit_action      ON public.audit_logs(action);
CREATE INDEX idx_audit_resource    ON public.audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_created_at  ON public.audit_logs(created_at DESC);

-- NOTE: src/actions/auth.ts writes audit rows with action = 'impersonation_start'
-- / 'impersonation_end', which the CHECK above rejects. That is a live bug in
-- the current app (those inserts silently fail), preserved here rather than
-- fixed, so the migrated schema matches production behaviour. Decide in Phase 2
-- whether to widen the CHECK or fix the caller.


-- =============================================================================
-- 17. KPI redesign — kpi_role_settings, bonus blocks/tiers, items, results (028, 029)
--     kpi_plan_tiers / kpi_daily_tiers were dropped by 029 and are not recreated.
-- =============================================================================

CREATE TABLE public.kpi_role_settings (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name      TEXT          NOT NULL,
  is_active      BOOLEAN       NOT NULL DEFAULT true,
  salary_type    TEXT          NOT NULL DEFAULT 'fixed',   -- 029
  salary_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,         -- 029
  rate_per_shift NUMERIC(12,2) NOT NULL DEFAULT 0,         -- 029
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT kpi_role_settings_role_unique UNIQUE (role_name),
  CONSTRAINT kpi_role_settings_salary_type_check CHECK (salary_type IN ('fixed','per_shift'))
);

-- role_name references roles.name softly (no hard FK): roles are created
-- dynamically and KPI history must survive a deleted role.
CREATE INDEX idx_kpi_role_settings_role ON public.kpi_role_settings(role_name);

CREATE TRIGGER trg_kpi_role_settings_updated_at
  BEFORE UPDATE ON public.kpi_role_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.kpi_items (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  role_setting_id UUID          NOT NULL REFERENCES public.kpi_role_settings(id) ON DELETE CASCADE,
  name            TEXT          NOT NULL,
  description     TEXT,
  bonus_amount    NUMERIC(12,2) NOT NULL,
  sort_order      SMALLINT      NOT NULL DEFAULT 0,
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT kpi_items_bonus_check CHECK (bonus_amount >= 0)
);

CREATE INDEX idx_kpi_items_setting ON public.kpi_items(role_setting_id);

CREATE TRIGGER trg_kpi_items_updated_at
  BEFORE UPDATE ON public.kpi_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.kpi_bonus_blocks (
  id               UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  role_setting_id  UUID     NOT NULL REFERENCES public.kpi_role_settings(id) ON DELETE CASCADE,
  name             TEXT     NOT NULL,
  block_type       TEXT     NOT NULL DEFAULT 'custom',
  value_label_from TEXT     NOT NULL DEFAULT '%',
  value_label_to   TEXT     NOT NULL DEFAULT '%',
  sort_order       SMALLINT NOT NULL DEFAULT 0,

  CONSTRAINT kpi_bonus_blocks_type_check CHECK (block_type IN ('plan','daily','custom'))
);

CREATE TABLE public.kpi_bonus_tiers (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id     UUID          NOT NULL REFERENCES public.kpi_bonus_blocks(id) ON DELETE CASCADE,
  tier_from    NUMERIC       NOT NULL DEFAULT 0,
  tier_to      NUMERIC,
  bonus_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  sort_order   SMALLINT      NOT NULL DEFAULT 0
);

CREATE TABLE public.employee_kpi_results (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID          NOT NULL REFERENCES public.employees(id),
  period_year         SMALLINT      NOT NULL,
  period_month        SMALLINT      NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  plan_completion_pct NUMERIC(5,2)  NOT NULL DEFAULT 0,
  plan_bonus          NUMERIC(12,2) NOT NULL DEFAULT 0,
  items_bonus         NUMERIC(12,2) NOT NULL DEFAULT 0,
  daily_bonus         NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_bonus         NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_closed           BOOLEAN       NOT NULL DEFAULT false,
  closed_at           TIMESTAMPTZ,
  closed_by           UUID          REFERENCES public.employees(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT employee_kpi_results_unique UNIQUE (employee_id, period_year, period_month)
);

CREATE INDEX idx_employee_kpi_results_emp    ON public.employee_kpi_results(employee_id);
CREATE INDEX idx_employee_kpi_results_period ON public.employee_kpi_results(period_year, period_month);

CREATE TRIGGER trg_employee_kpi_results_updated_at
  BEFORE UPDATE ON public.employee_kpi_results
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.employee_kpi_item_results (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID        NOT NULL REFERENCES public.employees(id),
  kpi_item_id  UUID        NOT NULL REFERENCES public.kpi_items(id) ON DELETE CASCADE,
  period_year  SMALLINT    NOT NULL,
  period_month SMALLINT    NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  is_completed BOOLEAN     NOT NULL DEFAULT false,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT employee_kpi_item_unique UNIQUE (employee_id, kpi_item_id, period_year, period_month)
);

CREATE INDEX idx_kpi_item_results_emp    ON public.employee_kpi_item_results(employee_id);
CREATE INDEX idx_kpi_item_results_period ON public.employee_kpi_item_results(period_year, period_month);

CREATE TRIGGER trg_kpi_item_results_updated_at
  BEFORE UPDATE ON public.employee_kpi_item_results
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.advance_payments (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID          NOT NULL REFERENCES public.employees(id),
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  date        DATE          NOT NULL,
  notes       TEXT,
  created_by  UUID          REFERENCES public.employees(id),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_advance_payments_emp  ON public.advance_payments(employee_id);
CREATE INDEX idx_advance_payments_date ON public.advance_payments(date);


-- =============================================================================
-- 18. company_plans (030)
-- =============================================================================

CREATE TABLE public.company_plans (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  date_start       DATE          NOT NULL,
  date_end         DATE          NOT NULL,
  target_revenue   NUMERIC(14,2) NOT NULL CHECK (target_revenue > 0),
  avg_check        NUMERIC(12,2) NOT NULL CHECK (avg_check > 0),
  conv_appeal_lead NUMERIC(5,2)  NOT NULL CHECK (conv_appeal_lead > 0 AND conv_appeal_lead <= 100),
  conv_lead_nv     NUMERIC(5,2)  NOT NULL CHECK (conv_lead_nv     > 0 AND conv_lead_nv     <= 100),
  conv_nv_fv       NUMERIC(5,2)  NOT NULL CHECK (conv_nv_fv       > 0 AND conv_nv_fv       <= 100),
  conv_fv_sale     NUMERIC(5,2)  NOT NULL CHECK (conv_fv_sale     > 0 AND conv_fv_sale     <= 100),
  created_by       UUID          REFERENCES public.employees(id),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT company_plans_dates_valid CHECK (date_end >= date_start),
  CONSTRAINT company_plans_no_overlap
    EXCLUDE USING gist (daterange(date_start, date_end, '[]') WITH &&)
);

CREATE TRIGGER trg_company_plans_updated_at
  BEFORE UPDATE ON public.company_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- 19. tasks + task_members (032)
-- =============================================================================

CREATE TABLE public.tasks (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  title         VARCHAR(300) NOT NULL,
  description   TEXT,
  status        TEXT         NOT NULL DEFAULT 'todo',
  priority      TEXT         NOT NULL DEFAULT 'medium',
  visibility    TEXT         NOT NULL DEFAULT 'all',
  assignee_id   UUID         REFERENCES public.employees(id)   ON DELETE SET NULL,
  created_by    UUID         NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  department_id UUID         REFERENCES public.departments(id) ON DELETE SET NULL,
  due_date      DATE,
  position      INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT tasks_status_check     CHECK (status     IN ('todo','in_progress','review','done')),
  CONSTRAINT tasks_priority_check   CHECK (priority   IN ('low','medium','high','urgent')),
  CONSTRAINT tasks_visibility_check CHECK (visibility IN ('all','department','private'))
);

CREATE INDEX idx_tasks_status     ON public.tasks(status);
CREATE INDEX idx_tasks_assignee   ON public.tasks(assignee_id);
CREATE INDEX idx_tasks_created_by ON public.tasks(created_by);
CREATE INDEX idx_tasks_department ON public.tasks(department_id);
CREATE INDEX idx_tasks_order      ON public.tasks(status, position);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.task_members (
  task_id     UUID        NOT NULL REFERENCES public.tasks(id)     ON DELETE CASCADE,
  employee_id UUID        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, employee_id)
);

CREATE INDEX idx_task_members_emp ON public.task_members(employee_id);

-- Task visibility rule, preserved as a queryable predicate so the app can reuse
-- it in WHERE clauses instead of reimplementing it. Was can_see_task(...) with
-- implicit auth.uid(); the viewer is now an explicit parameter.
CREATE OR REPLACE FUNCTION public.can_see_task(
  p_user_id    UUID,
  t_visibility TEXT,
  t_department UUID,
  t_created_by UUID,
  t_assignee   UUID,
  t_id         UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    public.get_role(p_user_id) = 'owner'
    OR t_created_by = public.get_employee_id(p_user_id)
    OR t_assignee   = public.get_employee_id(p_user_id)
    OR t_visibility = 'all'
    OR (t_visibility = 'department'
        AND t_department IS NOT NULL
        AND t_department = public.get_department_id(p_user_id))
    OR EXISTS (
      SELECT 1 FROM public.task_members m
      WHERE m.task_id = t_id
        AND m.employee_id = public.get_employee_id(p_user_id)
    );
$$;


-- =============================================================================
-- 20. deals funnel (036, 039, 20260810154527)
-- =============================================================================

CREATE TABLE public.deal_stages (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(120) NOT NULL,
  description TEXT,  -- 039
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  kind        TEXT         NOT NULL DEFAULT 'normal',
  color       TEXT         NOT NULL DEFAULT '#94a3b8',
  is_default  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT deal_stages_kind_check CHECK (kind IN ('normal','won','lost'))
);

CREATE INDEX idx_deal_stages_order ON public.deal_stages(sort_order);
CREATE UNIQUE INDEX idx_deal_stages_default ON public.deal_stages(is_default) WHERE is_default;

CREATE TRIGGER trg_deal_stages_updated_at
  BEFORE UPDATE ON public.deal_stages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.deals (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  title                   VARCHAR(300)  NOT NULL,
  stage_id                UUID          NOT NULL REFERENCES public.deal_stages(id) ON DELETE RESTRICT,
  amount                  NUMERIC(12,2),
  currency                TEXT          NOT NULL DEFAULT 'KGS',
  customer_name           VARCHAR(200),
  customer_phone          VARCHAR(32),
  customer_username       VARCHAR(120),
  city                    VARCHAR(120),  -- 20260810154527
  address                 VARCHAR(500),  -- 20260810154527
  source                  TEXT          NOT NULL DEFAULT 'manual',
  external_key            TEXT          UNIQUE,
  responsible_employee_id UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  note                    TEXT,
  status                  TEXT          NOT NULL DEFAULT 'open',
  stage_changed_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at              TIMESTAMPTZ,

  CONSTRAINT deals_currency_check CHECK (currency IN ('KGS','USD','RUB')),
  CONSTRAINT deals_source_check   CHECK (source   IN ('telegram','whatsapp','instagram','manual','site')),
  CONSTRAINT deals_status_check   CHECK (status   IN ('open','won','lost')),
  CONSTRAINT deals_title_check    CHECK (btrim(title) <> '')
);

COMMENT ON COLUMN public.deals.city    IS 'Город клиента';
COMMENT ON COLUMN public.deals.address IS 'Адрес клиента';

CREATE INDEX idx_deals_stage       ON public.deals(stage_id);
CREATE INDEX idx_deals_responsible ON public.deals(responsible_employee_id);
CREATE INDEX idx_deals_source      ON public.deals(source);
CREATE INDEX idx_deals_active      ON public.deals(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_deals_phone       ON public.deals(customer_phone);

CREATE TRIGGER trg_deals_updated_at
  BEFORE UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.deal_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       UUID        NOT NULL REFERENCES public.deals(id)       ON DELETE CASCADE,
  from_stage_id UUID        REFERENCES public.deal_stages(id)          ON DELETE SET NULL,
  to_stage_id   UUID        NOT NULL REFERENCES public.deal_stages(id) ON DELETE RESTRICT,
  employee_id   UUID        REFERENCES public.employees(id)            ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deal_events_deal ON public.deal_events(deal_id, created_at);

CREATE OR REPLACE FUNCTION public.sync_deal_stage_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  stage_kind TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
    RETURN NEW;
  END IF;

  SELECT kind INTO stage_kind FROM public.deal_stages WHERE id = NEW.stage_id;
  NEW.status := CASE stage_kind WHEN 'won' THEN 'won' WHEN 'lost' THEN 'lost' ELSE 'open' END;

  IF TG_OP = 'UPDATE' THEN
    NEW.stage_changed_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_sync_stage_state
  BEFORE INSERT OR UPDATE OF stage_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.sync_deal_stage_state();

-- REWRITTEN: used public.get_my_employee_id() (auth.uid()-backed). A trigger
-- cannot take parameters, so the actor comes from the transaction-local GUC.
-- When unset (bot writes, imports) employee_id is NULL, exactly as it was for
-- service_role writes under Supabase.
CREATE OR REPLACE FUNCTION public.log_deal_stage_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.deal_events (deal_id, from_stage_id, to_stage_id, employee_id)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage_id ELSE NULL END,
    NEW.stage_id,
    public.current_employee_id()
  );

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_deals_log_stage_change
  AFTER INSERT OR UPDATE OF stage_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.log_deal_stage_change();

-- Deal visibility predicate; viewer now explicit.
CREATE OR REPLACE FUNCTION public.can_see_deal(p_user_id UUID, d_responsible UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    public.get_role(p_user_id) IN ('owner','rop')
    OR (
      public.get_role(p_user_id) IN ('mp','lmai')
      AND (d_responsible IS NULL OR d_responsible = public.get_employee_id(p_user_id))
    );
$$;

INSERT INTO public.deal_stages (name, sort_order, kind, color, is_default) VALUES
  ('Неразобранное',      1, 'normal', '#94a3b8', TRUE),
  ('Начал запись',       2, 'normal', '#00aeef', FALSE),
  ('Оставил контакты',   3, 'normal', '#7b3fa0', FALSE),
  ('Записан на игру',    4, 'normal', '#f4a300', FALSE),
  ('Подтвердил участие', 5, 'normal', '#ffd42a', FALSE),
  ('Пришёл на игру',     6, 'won',    '#4f9b3a', FALSE),
  ('Не пришёл',          7, 'lost',   '#781a3e', FALSE);


-- =============================================================================
-- 21. games, game_bookings, bot_messages (042)
-- =============================================================================

CREATE TABLE public.games (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  title            VARCHAR(200)  NOT NULL DEFAULT 'Игра CASHFLOW',
  starts_at        TIMESTAMPTZ   NOT NULL,
  duration_min     INTEGER       NOT NULL DEFAULT 210,
  venue            VARCHAR(300)  NOT NULL DEFAULT 'Тоголок-Молдо 106, Бишкек',
  price            NUMERIC(10,2) NOT NULL DEFAULT 1500,
  currency         TEXT          NOT NULL DEFAULT 'KGS',
  seats_total      INTEGER       NOT NULL DEFAULT 8,
  host_employee_id UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  note             TEXT,
  is_published     BOOLEAN       NOT NULL DEFAULT FALSE,
  status           TEXT          NOT NULL DEFAULT 'planned',
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ,

  CONSTRAINT games_currency_check CHECK (currency IN ('KGS','USD','RUB')),
  CONSTRAINT games_status_check   CHECK (status IN ('planned','done','cancelled')),
  CONSTRAINT games_seats_check    CHECK (seats_total BETWEEN 1 AND 60),
  CONSTRAINT games_duration_check CHECK (duration_min BETWEEN 30 AND 600),
  CONSTRAINT games_price_check    CHECK (price >= 0),
  CONSTRAINT games_title_check    CHECK (btrim(title) <> '')
);

CREATE INDEX idx_games_starts    ON public.games(starts_at);
CREATE INDEX idx_games_published ON public.games(is_published, starts_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_games_host      ON public.games(host_employee_id);

CREATE TRIGGER trg_games_updated_at
  BEFORE UPDATE ON public.games
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.game_bookings (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id           UUID         NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  name              VARCHAR(200) NOT NULL,
  phone             VARCHAR(32),
  telegram_chat_id  BIGINT,
  telegram_username VARCHAR(120),
  seats             INTEGER      NOT NULL DEFAULT 1,
  source            TEXT         NOT NULL DEFAULT 'bot',
  status            TEXT         NOT NULL DEFAULT 'booked',
  deal_id           UUID         REFERENCES public.deals(id) ON DELETE SET NULL,
  note              TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT game_bookings_chat_unique  UNIQUE (game_id, telegram_chat_id),
  CONSTRAINT game_bookings_seats_check  CHECK (seats BETWEEN 1 AND 10),
  CONSTRAINT game_bookings_source_check CHECK (source IN ('bot','manual','site')),
  CONSTRAINT game_bookings_status_check CHECK (status IN ('booked','confirmed','attended','cancelled','no_show')),
  CONSTRAINT game_bookings_name_check   CHECK (btrim(name) <> '')
);

CREATE INDEX idx_game_bookings_game  ON public.game_bookings(game_id, created_at);
CREATE INDEX idx_game_bookings_phone ON public.game_bookings(phone);
CREATE INDEX idx_game_bookings_deal  ON public.game_bookings(deal_id);

CREATE TRIGGER trg_game_bookings_updated_at
  BEFORE UPDATE ON public.game_bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.game_seats_taken(g_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(seats), 0)::INTEGER
  FROM public.game_bookings
  WHERE game_id = g_id
    AND status IN ('booked','confirmed','attended');
$$;

CREATE OR REPLACE FUNCTION public.check_game_seats()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  total INTEGER;
  taken INTEGER;
BEGIN
  IF NEW.status NOT IN ('booked','confirmed','attended') THEN
    RETURN NEW;
  END IF;

  SELECT seats_total INTO total FROM public.games WHERE id = NEW.game_id;
  SELECT COALESCE(SUM(seats), 0)::INTEGER INTO taken
    FROM public.game_bookings
   WHERE game_id = NEW.game_id
     AND status IN ('booked','confirmed','attended')
     AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF taken + NEW.seats > total THEN
    RAISE EXCEPTION 'Свободных мест нет: занято %, всего %', taken, total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_game_bookings_seats
  BEFORE INSERT OR UPDATE OF seats, status, game_id ON public.game_bookings
  FOR EACH ROW EXECUTE FUNCTION public.check_game_seats();

CREATE TABLE public.bot_messages (
  id         BIGSERIAL   PRIMARY KEY,
  chat_id    TEXT        NOT NULL,
  direction  TEXT        NOT NULL,
  sender     TEXT        NOT NULL DEFAULT 'client',
  text       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT bot_messages_direction_check CHECK (direction IN ('in','out')),
  CONSTRAINT bot_messages_sender_check    CHECK (sender IN ('client','bot','operator'))
);

CREATE INDEX idx_bot_messages_chat ON public.bot_messages(chat_id, created_at);


-- =============================================================================
-- 22. marketing_daily_data — DELIBERATELY ABSENT.
--     Phase 1 reconstructed this table by guessing from the columns the app
--     selects. Phase 2 introspected the live Supabase project (see
--     db/live-schema-openapi.json): the table DOES NOT EXIST there. Every app
--     query against it (SupabaseMarketingAdapter.ts, calendar/page.tsx) is
--     already failing in production and being swallowed. Creating it here
--     would invent a table the system has never had, so it is not created.
--     Phase 2 app work must either delete the marketing adapter or add the
--     table as a deliberate new feature — not as a migration artefact.
-- =============================================================================


-- =============================================================================
-- 23. Business functions (016 as amended by 021 and 027; 028 as amended by 029)
-- =============================================================================

-- recalculate_decomposition — final form from 027 (daily_activity /
-- sales_plan_weekly names, NULL guards from 021). No auth.uid() involved.
CREATE OR REPLACE FUNCTION public.recalculate_decomposition(
  p_employee_id UUID,
  p_year        SMALLINT,
  p_month       SMALLINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_date_start   DATE;
  v_date_end     DATE;
  v_fv_fact      INTEGER := 0;
  v_sales_fact   INTEGER := 0;
  v_revenue_fact NUMERIC(12,2) := 0;
  v_work_days_f  SMALLINT := 0;
  v_plan_fv      INTEGER := 0;
  v_plan_sales   INTEGER := 0;
  v_plan_revenue NUMERIC(12,2) := 0;
  v_plan_days    SMALLINT := 0;
  v_kpi_pct      NUMERIC(5,2) := 0;
  v_template     RECORD;
BEGIN
  v_date_start := MAKE_DATE(p_year::INT, p_month::INT, 1);
  v_date_end   := (v_date_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;

  SELECT
    COALESCE(SUM(
      COALESCE(
        df.fv_fact,
        (SELECT COUNT(*) FROM public.consultations c
         WHERE c.manager_id = p_employee_id
           AND c.date = s.d
           AND c.actual_status = 'Пришла'
           AND c.deleted_at IS NULL)::INTEGER
      )
    ), 0)
  INTO v_fv_fact
  FROM (SELECT generate_series(v_date_start, v_date_end, '1 day'::INTERVAL)::DATE AS d) s
  LEFT JOIN public.daily_activity df
    ON df.employee_id = p_employee_id AND df.date = s.d;

  SELECT
    COALESCE(SUM(
      COALESCE(
        df.sales_fact,
        (SELECT COUNT(*) FROM public.consultations c
         WHERE c.manager_id = p_employee_id
           AND c.date = s.d
           AND c.status_after_fv IN ('Купила','Предоплата')
           AND c.deleted_at IS NULL)::INTEGER
      )
    ), 0)
  INTO v_sales_fact
  FROM (SELECT generate_series(v_date_start, v_date_end, '1 day'::INTERVAL)::DATE AS d) s
  LEFT JOIN public.daily_activity df
    ON df.employee_id = p_employee_id AND df.date = s.d;

  SELECT
    COALESCE(SUM(
      COALESCE(
        df.revenue_fact,
        (SELECT COALESCE(SUM(c.amount), 0) FROM public.consultations c
         WHERE c.manager_id = p_employee_id
           AND c.date = s.d
           AND c.status_after_fv IN ('Купила','Предоплата')
           AND c.deleted_at IS NULL)
      )
    ), 0)
  INTO v_revenue_fact
  FROM (SELECT generate_series(v_date_start, v_date_end, '1 day'::INTERVAL)::DATE AS d) s
  LEFT JOIN public.daily_activity df
    ON df.employee_id = p_employee_id AND df.date = s.d;

  SELECT COUNT(*)
  INTO v_work_days_f
  FROM public.attendance
  WHERE employee_id = p_employee_id
    AND date BETWEEN v_date_start AND v_date_end
    AND status = 'worked';

  SELECT
    COALESCE(plan_fv, 0),
    COALESCE(plan_sales, 0),
    COALESCE(plan_revenue, 0),
    COALESCE(plan_work_days, 0)
  INTO v_plan_fv, v_plan_sales, v_plan_revenue, v_plan_days
  FROM public.employee_kpi
  WHERE employee_id = p_employee_id
    AND period_year = p_year
    AND period_month = p_month;

  v_plan_fv      := COALESCE(v_plan_fv, 0);
  v_plan_sales   := COALESCE(v_plan_sales, 0);
  v_plan_revenue := COALESCE(v_plan_revenue, 0);
  v_plan_days    := COALESCE(v_plan_days, 0);

  SELECT kt.*
  INTO v_template
  FROM public.kpi_templates kt
  JOIN public.employees e ON e.role = kt.role
  WHERE e.id = p_employee_id
    AND kt.is_default = true
  LIMIT 1;

  IF v_template IS NOT NULL THEN
    DECLARE
      v_fv_pct  NUMERIC := CASE WHEN v_plan_fv > 0 THEN LEAST((v_fv_fact::NUMERIC / v_plan_fv) * 100, 200) ELSE 0 END;
      v_s_pct   NUMERIC := CASE WHEN v_plan_sales > 0 THEN LEAST((v_sales_fact::NUMERIC / v_plan_sales) * 100, 200) ELSE 0 END;
      v_r_pct   NUMERIC := CASE WHEN v_plan_revenue > 0 THEN LEAST((v_revenue_fact / v_plan_revenue) * 100, 200) ELSE 0 END;
      v_fv_w    NUMERIC := COALESCE((v_template.metrics->'fv'->>'weight')::NUMERIC, 0);
      v_s_w     NUMERIC := COALESCE((v_template.metrics->'sales'->>'weight')::NUMERIC, 0);
      v_r_w     NUMERIC := COALESCE((v_template.metrics->'revenue'->>'weight')::NUMERIC, 0);
      v_total_w NUMERIC := v_fv_w + v_s_w + v_r_w;
    BEGIN
      IF v_total_w > 0 THEN
        v_kpi_pct := ROUND((v_fv_pct * v_fv_w + v_s_pct * v_s_w + v_r_pct * v_r_w) / v_total_w, 2);
      END IF;
    END;
  END IF;

  INSERT INTO public.sales_plan_weekly (
    employee_id, period_year, period_month,
    total_fv_plan, total_fv_fact,
    total_sales_plan, total_sales_fact,
    total_revenue_plan, total_revenue_fact,
    total_work_days_plan, total_work_days_fact,
    kpi_pct, last_calculated_at
  )
  VALUES (
    p_employee_id, p_year, p_month,
    v_plan_fv, v_fv_fact,
    v_plan_sales, v_sales_fact,
    v_plan_revenue, v_revenue_fact,
    v_plan_days, v_work_days_f,
    v_kpi_pct, NOW()
  )
  ON CONFLICT (employee_id, period_year, period_month)
  DO UPDATE SET
    total_fv_plan        = EXCLUDED.total_fv_plan,
    total_fv_fact        = EXCLUDED.total_fv_fact,
    total_sales_plan     = EXCLUDED.total_sales_plan,
    total_sales_fact     = EXCLUDED.total_sales_fact,
    total_revenue_plan   = EXCLUDED.total_revenue_plan,
    total_revenue_fact   = EXCLUDED.total_revenue_fact,
    total_work_days_plan = EXCLUDED.total_work_days_plan,
    total_work_days_fact = EXCLUDED.total_work_days_fact,
    kpi_pct              = EXCLUDED.kpi_pct,
    last_calculated_at   = NOW(),
    updated_at           = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION public.recalculate_finances(
  p_year  SMALLINT,
  p_month SMALLINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_date_start DATE;
  v_date_end   DATE;
  v_income     NUMERIC(12,2) := 0;
  v_expense    NUMERIC(12,2) := 0;
  v_net        NUMERIC(12,2) := 0;
  v_margin     NUMERIC(5,2)  := 0;
BEGIN
  v_date_start := MAKE_DATE(p_year::INT, p_month::INT, 1);
  v_date_end   := (v_date_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;

  SELECT
    COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)
  INTO v_income, v_expense
  FROM public.finance_transactions
  WHERE date BETWEEN v_date_start AND v_date_end
    AND deleted_at IS NULL;

  v_net    := v_income - v_expense;
  v_margin := CASE WHEN v_income > 0 THEN ROUND((v_net / v_income) * 100, 2) ELSE 0 END;

  INSERT INTO public.finance_periods (
    period_year, period_month,
    total_income, total_expense, net_profit, margin_pct,
    last_calculated_at
  )
  VALUES (p_year, p_month, v_income, v_expense, v_net, v_margin, NOW())
  ON CONFLICT (period_year, period_month)
  DO UPDATE SET
    total_income       = EXCLUDED.total_income,
    total_expense      = EXCLUDED.total_expense,
    net_profit         = EXCLUDED.net_profit,
    margin_pct         = EXCLUDED.margin_pct,
    last_calculated_at = NOW(),
    updated_at         = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_monthly_schedule(
  p_employee_id UUID,
  p_year        SMALLINT,
  p_month       SMALLINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_date_start    DATE;
  v_date_end      DATE;
  v_current_date  DATE;
  v_schedule_type TEXT;
  v_work_start    TIME;
  v_work_end      TIME;
  v_is_workday    BOOLEAN;
  v_dow           INTEGER;
  v_day_num       INTEGER := 0;
BEGIN
  v_date_start := MAKE_DATE(p_year::INT, p_month::INT, 1);
  v_date_end   := (v_date_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;

  SELECT schedule_type, work_start_time, work_end_time
  INTO v_schedule_type, v_work_start, v_work_end
  FROM public.employees
  WHERE id = p_employee_id;

  v_current_date := v_date_start;

  WHILE v_current_date <= v_date_end LOOP
    v_dow     := EXTRACT(ISODOW FROM v_current_date)::INTEGER;
    v_day_num := v_day_num + 1;

    v_is_workday := CASE v_schedule_type
      WHEN '5/2'      THEN v_dow BETWEEN 1 AND 5
      WHEN 'weekends' THEN v_dow BETWEEN 6 AND 7
      WHEN '2/2'      THEN (v_day_num % 4) IN (1, 2)
      WHEN '1/1'      THEN (v_day_num % 2) = 1
      WHEN '3/3'      THEN (v_day_num % 6) IN (1, 2, 3)
      WHEN 'custom'   THEN true
      ELSE v_dow BETWEEN 1 AND 5
    END;

    INSERT INTO public.schedules (employee_id, date, is_workday, work_start, work_end)
    VALUES (p_employee_id, v_current_date, v_is_workday, v_work_start, v_work_end)
    ON CONFLICT (employee_id, date) DO NOTHING;

    v_current_date := v_current_date + 1;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_salary(
  p_employee_id UUID,
  p_year        SMALLINT,
  p_month       SMALLINT
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_emp            RECORD;
  v_decomp         RECORD;
  v_work_days_plan SMALLINT := 0;
  v_work_days_fact SMALLINT := 0;
  v_base           NUMERIC(12,2) := 0;
  v_day_rate       NUMERIC(12,2) := 0;
  v_base_adjusted  NUMERIC(12,2) := 0;
  v_kpi_bonus      NUMERIC(12,2) := 0;
  v_total          NUMERIC(12,2) := 0;
  v_salary_id      UUID;
BEGIN
  SELECT * INTO v_emp FROM public.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee % not found', p_employee_id;
  END IF;

  -- Renamed table (026a): decomposition → sales_plan_weekly.
  SELECT * INTO v_decomp
  FROM public.sales_plan_weekly
  WHERE employee_id = p_employee_id
    AND period_year = p_year AND period_month = p_month;

  SELECT COUNT(*) INTO v_work_days_plan
  FROM public.schedules
  WHERE employee_id = p_employee_id
    AND EXTRACT(YEAR FROM date) = p_year
    AND EXTRACT(MONTH FROM date) = p_month
    AND is_workday = true;

  SELECT COUNT(*) INTO v_work_days_fact
  FROM public.attendance
  WHERE employee_id = p_employee_id
    AND EXTRACT(YEAR FROM date) = p_year
    AND EXTRACT(MONTH FROM date) = p_month
    AND status = 'worked';

  v_base := v_emp.base_salary;
  IF v_work_days_plan > 0 THEN
    v_day_rate      := v_base / v_work_days_plan;
    v_base_adjusted := ROUND(v_day_rate * v_work_days_fact, 2);
  ELSE
    v_base_adjusted := v_base;
  END IF;

  IF v_decomp IS NOT NULL AND v_decomp.kpi_pct >= 30 THEN
    DECLARE
      v_coeff NUMERIC := 1.0;
    BEGIN
      SELECT kt.over_plan_coefficient INTO v_coeff
      FROM public.kpi_templates kt
      WHERE kt.role = v_emp.role AND kt.is_default = true
      LIMIT 1;

      v_kpi_bonus := ROUND(
        v_base * v_emp.kpi_coefficient *
        CASE
          WHEN v_decomp.kpi_pct >= 100 THEN COALESCE(v_coeff, 1.2)
          ELSE v_decomp.kpi_pct / 100
        END,
        2
      );
    END;
  END IF;

  v_total := v_base_adjusted + v_kpi_bonus;

  INSERT INTO public.salaries (
    employee_id, period_year, period_month,
    base_salary, kpi_bonus, bonuses, deductions, total_amount,
    kpi_pct, work_days_fact, work_days_plan,
    status, calculated_at
  )
  VALUES (
    p_employee_id, p_year, p_month,
    v_base_adjusted, v_kpi_bonus, 0, 0, v_total,
    COALESCE(v_decomp.kpi_pct, 0),
    v_work_days_fact, v_work_days_plan,
    'calculated', NOW()
  )
  ON CONFLICT (employee_id, period_year, period_month)
  DO UPDATE SET
    base_salary    = EXCLUDED.base_salary,
    kpi_bonus      = EXCLUDED.kpi_bonus,
    total_amount   = EXCLUDED.total_amount,
    kpi_pct        = EXCLUDED.kpi_pct,
    work_days_fact = EXCLUDED.work_days_fact,
    work_days_plan = EXCLUDED.work_days_plan,
    status         = 'calculated',
    calculated_at  = NOW(),
    updated_at     = NOW()
  RETURNING id INTO v_salary_id;

  DELETE FROM public.salary_calculations WHERE salary_id = v_salary_id;

  INSERT INTO public.salary_calculations (salary_id, type, description, amount, metric_name, metric_plan, metric_fact, metric_pct)
  VALUES
    (v_salary_id, 'base_salary',    'Базовый оклад', v_emp.base_salary, NULL, NULL, NULL, NULL),
    (v_salary_id, 'day_adjustment', 'Корректировка по дням (' || v_work_days_fact || '/' || v_work_days_plan || ')',
     v_base_adjusted - v_emp.base_salary, 'Рабочие дни', v_work_days_plan, v_work_days_fact, NULL),
    (v_salary_id, 'kpi_bonus',      'KPI бонус', v_kpi_bonus,
     'KPI%', NULL, COALESCE(v_decomp.kpi_pct, 0), COALESCE(v_decomp.kpi_pct, 0));

  RETURN v_salary_id;
END;
$$;

-- recalculate_kpi_results — final form from 029 (kpi_bonus_blocks/tiers).
CREATE OR REPLACE FUNCTION public.recalculate_kpi_results(
  p_employee_id UUID,
  p_year        SMALLINT,
  p_month       SMALLINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_setting_id UUID;
  v_plan_pct        NUMERIC(5,2)  := 0;
  v_plan_bonus      NUMERIC(12,2) := 0;
  v_items_bonus     NUMERIC(12,2) := 0;
  v_daily_bonus     NUMERIC(12,2) := 0;
  v_date_start      DATE;
  v_date_end        DATE;
  v_plan_block_id   UUID;
  v_daily_block_id  UUID;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.employee_kpi_results
    WHERE employee_id = p_employee_id
      AND period_year  = p_year
      AND period_month = p_month
      AND is_closed = true
  ) THEN
    RETURN;
  END IF;

  SELECT krs.id INTO v_role_setting_id
  FROM public.kpi_role_settings krs
  JOIN public.employees e ON e.role = krs.role_name
  WHERE e.id = p_employee_id
    AND krs.is_active = true
  LIMIT 1;

  IF v_role_setting_id IS NULL THEN
    RETURN;
  END IF;

  v_date_start := MAKE_DATE(p_year::INT, p_month::INT, 1);
  v_date_end   := (v_date_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;

  SELECT id INTO v_plan_block_id
  FROM public.kpi_bonus_blocks
  WHERE role_setting_id = v_role_setting_id AND block_type = 'plan'
  LIMIT 1;

  SELECT id INTO v_daily_block_id
  FROM public.kpi_bonus_blocks
  WHERE role_setting_id = v_role_setting_id AND block_type = 'daily'
  LIMIT 1;

  SELECT COALESCE(kpi_pct, 0)
  INTO v_plan_pct
  FROM public.sales_plan_weekly
  WHERE employee_id  = p_employee_id
    AND period_year  = p_year
    AND period_month = p_month;

  v_plan_pct := COALESCE(v_plan_pct, 0);

  IF v_plan_block_id IS NOT NULL THEN
    SELECT COALESCE(bt.bonus_amount, 0)
    INTO v_plan_bonus
    FROM public.kpi_bonus_tiers bt
    WHERE bt.block_id  = v_plan_block_id
      AND bt.tier_from <= v_plan_pct
      AND (bt.tier_to IS NULL OR v_plan_pct <= bt.tier_to)
    ORDER BY bt.tier_from DESC
    LIMIT 1;
  END IF;

  v_plan_bonus := COALESCE(v_plan_bonus, 0);

  SELECT COALESCE(SUM(ki.bonus_amount), 0)
  INTO v_items_bonus
  FROM public.employee_kpi_item_results ekir
  JOIN public.kpi_items ki ON ki.id = ekir.kpi_item_id
  WHERE ekir.employee_id  = p_employee_id
    AND ekir.period_year  = p_year
    AND ekir.period_month = p_month
    AND ekir.is_completed = true
    AND ki.is_active = true
    AND ki.role_setting_id = v_role_setting_id;

  v_items_bonus := COALESCE(v_items_bonus, 0);

  IF v_daily_block_id IS NOT NULL THEN
    SELECT COALESCE(SUM(
      (SELECT COALESCE(bt.bonus_amount, 0)
       FROM public.kpi_bonus_tiers bt
       WHERE bt.block_id  = v_daily_block_id
         AND bt.tier_from <= COALESCE(da.revenue_fact, 0)
         AND (bt.tier_to IS NULL OR COALESCE(da.revenue_fact, 0) < bt.tier_to)
       ORDER BY bt.tier_from DESC
       LIMIT 1)
    ), 0)
    INTO v_daily_bonus
    FROM public.daily_activity da
    WHERE da.employee_id = p_employee_id
      AND da.date BETWEEN v_date_start AND v_date_end;
  END IF;

  v_daily_bonus := COALESCE(v_daily_bonus, 0);

  INSERT INTO public.employee_kpi_results (
    employee_id, period_year, period_month,
    plan_completion_pct, plan_bonus, items_bonus, daily_bonus, total_bonus
  )
  VALUES (
    p_employee_id, p_year, p_month,
    v_plan_pct, v_plan_bonus, v_items_bonus, v_daily_bonus,
    v_plan_bonus + v_items_bonus + v_daily_bonus
  )
  ON CONFLICT (employee_id, period_year, period_month)
  DO UPDATE SET
    plan_completion_pct = EXCLUDED.plan_completion_pct,
    plan_bonus          = EXCLUDED.plan_bonus,
    items_bonus         = EXCLUDED.items_bonus,
    daily_bonus         = EXCLUDED.daily_bonus,
    total_bonus         = EXCLUDED.total_bonus,
    updated_at          = NOW()
  WHERE employee_kpi_results.is_closed = false;
END;
$$;

-- REWRITTEN: close_kpi_month used get_my_role() / get_my_employee_id(), both
-- auth.uid()-backed. The caller's user id is now an explicit first parameter;
-- the role check is preserved verbatim as a defence-in-depth layer behind the
-- application's own requireRole() gate.
CREATE OR REPLACE FUNCTION public.close_kpi_month(
  p_actor_user_id UUID,
  p_employee_id   UUID,
  p_year          SMALLINT,
  p_month         SMALLINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_caller_role TEXT;
  v_closer_id   UUID;
BEGIN
  v_caller_role := public.get_role(p_actor_user_id);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'accountant') THEN
    RAISE EXCEPTION 'close_kpi_month: недостаточно прав (требуется owner или accountant)';
  END IF;

  v_closer_id := public.get_employee_id(p_actor_user_id);

  PERFORM public.recalculate_kpi_results(p_employee_id, p_year, p_month);

  INSERT INTO public.employee_kpi_results (
    employee_id, period_year, period_month,
    plan_completion_pct, plan_bonus, items_bonus, daily_bonus, total_bonus,
    is_closed, closed_at, closed_by
  )
  VALUES (
    p_employee_id, p_year, p_month,
    0, 0, 0, 0, 0,
    true, NOW(), v_closer_id
  )
  ON CONFLICT (employee_id, period_year, period_month)
  DO UPDATE SET
    is_closed  = true,
    closed_at  = NOW(),
    closed_by  = v_closer_id,
    updated_at = NOW();
END;
$$;


-- =============================================================================
-- 24. Business triggers (017, 028 §11-12, 031)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trigger_recalc_decomposition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_employee_id UUID;
  v_date        DATE;
BEGIN
  IF TG_TABLE_NAME = 'consultations' THEN
    v_employee_id := COALESCE(NEW.manager_id, OLD.manager_id);
    v_date        := COALESCE(NEW.date, OLD.date);
  ELSIF TG_TABLE_NAME = 'daily_activity' THEN
    v_employee_id := COALESCE(NEW.employee_id, OLD.employee_id);
    v_date        := COALESCE(NEW.date, OLD.date);
  END IF;

  IF v_employee_id IS NOT NULL AND v_date IS NOT NULL THEN
    PERFORM public.recalculate_decomposition(
      v_employee_id,
      EXTRACT(YEAR FROM v_date)::SMALLINT,
      EXTRACT(MONTH FROM v_date)::SMALLINT
    );
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_consultations_recalc_decomposition
  AFTER INSERT OR UPDATE OF status_after_fv, actual_status, amount, deleted_at
  ON public.consultations
  FOR EACH ROW EXECUTE FUNCTION public.trigger_recalc_decomposition();

CREATE TRIGGER trg_daily_facts_recalc_decomposition
  AFTER INSERT OR UPDATE
  ON public.daily_activity
  FOR EACH ROW EXECUTE FUNCTION public.trigger_recalc_decomposition();

CREATE OR REPLACE FUNCTION public.trigger_recalc_finances()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_date DATE;
BEGIN
  v_date := COALESCE(NEW.date, OLD.date);

  IF v_date IS NOT NULL THEN
    PERFORM public.recalculate_finances(
      EXTRACT(YEAR FROM v_date)::SMALLINT,
      EXTRACT(MONTH FROM v_date)::SMALLINT
    );
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_finance_transactions_recalc
  AFTER INSERT OR UPDATE OR DELETE
  ON public.finance_transactions
  FOR EACH ROW EXECUTE FUNCTION public.trigger_recalc_finances();

CREATE OR REPLACE FUNCTION public.trigger_consultation_sale()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_category_id UUID;
BEGIN
  IF NEW.status_after_fv IN ('Купила','Предоплата')
     AND (OLD.status_after_fv IS DISTINCT FROM NEW.status_after_fv)
     AND NEW.amount > 0
     AND NEW.deleted_at IS NULL
  THEN
    SELECT id INTO v_category_id
    FROM public.finance_categories
    WHERE name = 'Продажи' AND type = 'income' AND is_system = true
    LIMIT 1;

    IF v_category_id IS NOT NULL THEN
      INSERT INTO public.finance_transactions (
        category_id, type, amount, date,
        description, source_type, source_id, created_by
      )
      VALUES (
        v_category_id, 'income', NEW.amount, NEW.date,
        'Продажа: ' || NEW.client_name,
        'consultation', NEW.id, NEW.manager_id
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  IF OLD.status_after_fv IN ('Купила','Предоплата')
     AND NEW.status_after_fv NOT IN ('Купила','Предоплата')
  THEN
    UPDATE public.finance_transactions
    SET deleted_at = NOW()
    WHERE source_type = 'consultation' AND source_id = NEW.id AND deleted_at IS NULL;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_consultation_sale_transaction
  AFTER UPDATE OF status_after_fv
  ON public.consultations
  FOR EACH ROW EXECUTE FUNCTION public.trigger_consultation_sale();

CREATE OR REPLACE FUNCTION public.trigger_salary_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_category_id UUID;
  v_emp_name    TEXT;
BEGIN
  IF NEW.status = 'paid' AND OLD.status != 'paid' THEN
    SELECT id INTO v_category_id
    FROM public.finance_categories
    WHERE name = 'Зарплата' AND type = 'expense' AND is_system = true
    LIMIT 1;

    SELECT name INTO v_emp_name
    FROM public.employees WHERE id = NEW.employee_id;

    IF v_category_id IS NOT NULL THEN
      INSERT INTO public.finance_transactions (
        category_id, type, amount, date,
        description, source_type, source_id
      )
      VALUES (
        v_category_id, 'expense', NEW.total_amount,
        MAKE_DATE(NEW.period_year::INT, NEW.period_month::INT, 1),
        'Зарплата: ' || COALESCE(v_emp_name,'') || ' (' || NEW.period_month || '/' || NEW.period_year || ')',
        'salary', NEW.id
      );
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_salary_paid_transaction
  AFTER UPDATE OF status
  ON public.salaries
  FOR EACH ROW EXECUTE FUNCTION public.trigger_salary_paid();

CREATE OR REPLACE FUNCTION public.trigger_investor_payout()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_category_id   UUID;
  v_investor_name TEXT;
  v_tx_id         UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT id INTO v_category_id
    FROM public.finance_categories
    WHERE name = 'Выплата инвестору' AND type = 'expense' AND is_system = true
    LIMIT 1;

    SELECT name INTO v_investor_name
    FROM public.investors WHERE id = NEW.investor_id;

    IF v_category_id IS NOT NULL THEN
      INSERT INTO public.finance_transactions (
        category_id, type, amount, date,
        description, source_type, source_id, created_by
      )
      VALUES (
        v_category_id, 'expense', NEW.amount, NEW.date,
        'Выплата инвестору: ' || COALESCE(v_investor_name,''),
        'investor_payout', NEW.id, NEW.created_by
      )
      RETURNING id INTO v_tx_id;

      UPDATE public.investor_payouts
      SET transaction_id = v_tx_id
      WHERE id = NEW.id;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_investor_payout_transaction
  AFTER INSERT
  ON public.investor_payouts
  FOR EACH ROW EXECUTE FUNCTION public.trigger_investor_payout();

-- KPI recalculation triggers (028 §11-12)

CREATE OR REPLACE FUNCTION public.trg_recalculate_kpi_results()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_employee_id UUID;
  v_year        SMALLINT;
  v_month       SMALLINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_employee_id := OLD.employee_id;
    v_year        := EXTRACT(YEAR  FROM OLD.date)::SMALLINT;
    v_month       := EXTRACT(MONTH FROM OLD.date)::SMALLINT;
  ELSE
    v_employee_id := NEW.employee_id;
    v_year        := EXTRACT(YEAR  FROM NEW.date)::SMALLINT;
    v_month       := EXTRACT(MONTH FROM NEW.date)::SMALLINT;
  END IF;

  PERFORM public.recalculate_kpi_results(v_employee_id, v_year, v_month);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_recalculate_kpi_results_period()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_employee_id UUID;
  v_year        SMALLINT;
  v_month       SMALLINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_employee_id := OLD.employee_id;
    v_year        := OLD.period_year;
    v_month       := OLD.period_month;
  ELSE
    v_employee_id := NEW.employee_id;
    v_year        := NEW.period_year;
    v_month       := NEW.period_month;
  END IF;

  PERFORM public.recalculate_kpi_results(v_employee_id, v_year, v_month);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_recalculate_kpi_results_item()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_employee_id UUID;
  v_year        SMALLINT;
  v_month       SMALLINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_employee_id := OLD.employee_id;
    v_year        := OLD.period_year;
    v_month       := OLD.period_month;
  ELSE
    v_employee_id := NEW.employee_id;
    v_year        := NEW.period_year;
    v_month       := NEW.period_month;
  END IF;

  PERFORM public.recalculate_kpi_results(v_employee_id, v_year, v_month);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER trg_daily_activity_kpi_results
  AFTER INSERT OR UPDATE OR DELETE ON public.daily_activity
  FOR EACH ROW EXECUTE FUNCTION public.trg_recalculate_kpi_results();

CREATE TRIGGER trg_sales_plan_weekly_kpi_results
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_plan_weekly
  FOR EACH ROW EXECUTE FUNCTION public.trg_recalculate_kpi_results_period();

CREATE TRIGGER trg_kpi_item_results_recalc
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_kpi_item_results
  FOR EACH ROW EXECUTE FUNCTION public.trg_recalculate_kpi_results_item();

-- audit_logs → notifications for every owner (031)
CREATE OR REPLACE FUNCTION public.notify_from_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  actor_name   TEXT;
  action_label TEXT;
BEGIN
  IF NEW.action NOT IN ('create', 'update', 'delete') THEN
    RETURN NEW;
  END IF;

  SELECT name INTO actor_name FROM public.employees WHERE id = NEW.employee_id;

  action_label := CASE NEW.action
    WHEN 'create' THEN 'Добавление'
    WHEN 'update' THEN 'Изменение'
    WHEN 'delete' THEN 'Удаление'
  END;

  INSERT INTO public.notifications (employee_id, type, title, body, source_type, source_id)
  SELECT
    e.id,
    'audit',
    action_label || ': ' || NEW.resource_type,
    COALESCE(actor_name, 'Система') || ' — ' || lower(action_label) || ' в разделе «' || NEW.resource_type || '»',
    NEW.resource_type,
    NEW.resource_id
  FROM public.employees e
  WHERE e.role = 'owner'
    AND e.id IS DISTINCT FROM NEW.employee_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_from_audit_log
  AFTER INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.notify_from_audit_log();

-- =============================================================================
-- End of schema.
-- =============================================================================
