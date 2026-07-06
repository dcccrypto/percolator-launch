-- Migration: 20260617000000_fix_pii_authenticated_role_ideas_jobs.sql
-- Completes audit finding N7 (Medium) for the two tables migration 034 missed.
--
-- 026_fix_pii_exposure.sql column-restricted the 'anon' role on bug_reports,
-- job_applications and ideas, but then re-granted UNRESTRICTED `SELECT` on all
-- three to the 'authenticated' role (lines 93-101) on the assumption that
-- "admin users authenticate via Supabase auth and use the authenticated role".
--
-- That assumption no longer holds: the app moved its admin auth to Privy
-- (see app/lib/admin-session.ts), so the Supabase 'authenticated' role is no
-- longer the admin — it is any user who can obtain an 'authenticated' JWT from
-- the project (e.g. via anon/email self-signup with the public anon key).
-- With the SELECT policies still USING(true), such a user can read every
-- column directly via PostgREST, bypassing the API routes' column allow-lists.
--
-- 034_fix_pii_authenticated_role.sql fixed exactly this — but ONLY for
-- bug_reports. job_applications (email, ip, admin_notes, cv_data) and ideas
-- (ip, contact, admin_notes) were left with the unrestricted authenticated
-- grant. This migration applies the same REVOKE + column-restricted GRANT to
-- both, using the identical safe-column lists 026 already chose for 'anon'.
--
-- service_role (used by the API routes) is unaffected and retains full access.

-- ── job_applications: hide email, ip, admin_notes, cv_data ──────────────────
REVOKE SELECT ON job_applications FROM authenticated;

GRANT SELECT (
  id, name, twitter_handle, desired_role, experience_level,
  about, portfolio_links, cv_filename, availability, solana_wallet,
  status, created_at
) ON job_applications TO authenticated;

-- ── ideas: hide ip, contact, admin_notes ───────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ideas'
  ) THEN
    REVOKE SELECT ON ideas FROM authenticated;
    GRANT SELECT (id, handle, idea, status, created_at) ON ideas TO authenticated;
    RAISE NOTICE 'ideas: authenticated-role PII column grants applied';
  ELSE
    RAISE NOTICE 'ideas: table does not exist, skipping';
  END IF;
END
$$;
