-- =============================================================================
-- 002_auth_phase2.sql — surface needed by the Phase 2 auth foundation.
--
-- Incremental migration on top of db/schema.sql (Phase 1). Both changes are
-- also folded into schema.sql so a fresh bootstrap gets them; this file exists
-- so the already-provisioned Railway instance can be moved forward in place.
--
-- Idempotent: safe to re-run.
-- =============================================================================


-- ─── 1. password_reset_tokens ────────────────────────────────────────────────
-- Supabase GoTrue owned the reset flow internally, so Phase 1 had no equivalent
-- table. Single-use, expiring tokens; only the SHA-256 hash of the token is
-- stored, so a database leak does not hand out working reset links.
--
-- SHA-256 rather than bcrypt on purpose: the token is 32 bytes of CSPRNG
-- output, so there is no low-entropy secret to stretch, and an unsalted digest
-- is what allows the indexed equality lookup the confirm step needs.

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON public.password_reset_tokens(user_id);

-- Supports both the "is this token still live?" lookup and periodic cleanup.
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
  ON public.password_reset_tokens(expires_at)
  WHERE used_at IS NULL;


-- ─── 2. audit_logs action CHECK — latent bug fix ─────────────────────────────
-- src/actions/auth.ts has always written 'impersonation_start' and
-- 'impersonation_end', but audit_logs_action_check did not list them. Under
-- Supabase those inserts were fire-and-forget (the result was never awaited or
-- checked), so every impersonation audit row has been silently discarded.
--
-- Fixed by widening the constraint rather than by renaming the actions:
-- impersonation is exactly the kind of privileged act the audit log exists to
-- record, and collapsing it into a generic 'view'/'update' would lose that.
-- See db/AUTH_DESIGN.md §5 open question 8.

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_action_check;

ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_action_check CHECK (
    action IN (
      'create','update','delete','login','logout','export','view',
      'impersonation_start','impersonation_end'
    )
  );
