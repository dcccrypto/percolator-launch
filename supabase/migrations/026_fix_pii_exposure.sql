-- Migration 024: Fix PII Exposure via Anon Key
-- Security: GitHub issue #260 / PERC-031
--
-- Problem: bug_reports, job_applications, and ideas tables have
-- USING(true) SELECT policies that expose sensitive columns
-- (IP addresses, admin notes, emails, CV files) to anyone with
-- the public anon key, bypassing the API's column filtering.
--
-- Fix: Use column-level GRANTs to restrict which columns the
-- anon role can read. RLS row-level policies remain USING(true)
-- but the column-level grants prevent reading sensitive fields.
-- Service role (used by API routes) retains full access.

-- ═══════════════════════════════════════════════════════════════
-- 1. BUG_REPORTS — hide ip and admin_notes from anon
-- ═══════════════════════════════════════════════════════════════

-- Revoke blanket SELECT, then grant only safe columns
REVOKE SELECT ON bug_reports FROM anon;

GRANT SELECT (
  id, twitter_handle, title, description, severity, page, page_url,
  bounty_wallet, transaction_wallet, browser, status, created_at
) ON bug_reports TO anon;

-- Ensure service_role retains full access
GRANT ALL ON bug_reports TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- 2. JOB_APPLICATIONS — hide email, ip, admin_notes, cv_data
-- ═══════════════════════════════════════════════════════════════

REVOKE SELECT ON job_applications FROM anon;

GRANT SELECT (
  id, name, twitter_handle, desired_role, experience_level,
  about, portfolio_links, cv_filename, availability, solana_wallet,
  status, created_at
) ON job_applications TO anon;

-- Ensure service_role retains full access
GRANT ALL ON job_applications TO service_role;

-- ═══════════════════════════════════════════════════════════════
-- 3. IDEAS — hide ip, admin_notes, contact from anon
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ideas') THEN
    REVOKE SELECT ON ideas FROM anon;
    GRANT SELECT (id, handle, idea, status, created_at) ON ideas TO anon;
    GRANT ALL ON ideas TO service_role;
    RAISE NOTICE 'ideas: PII column grants applied';
  ELSE
    RAISE NOTICE 'ideas: table does not exist, skipping';
  END IF;
END
$$;

-- ═══════════════════════════════════════════════════════════════
-- 4. LOCK DOWN exec_sql RPC FUNCTION
-- ═══════════════════════════════════════════════════════════════
-- The exec_sql function (if it exists) should only be callable
-- by service_role. If callable by anon, it's a SQL injection vector.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'exec_sql'
  ) THEN
    -- Revoke execute from anon and authenticated
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.exec_sql FROM anon';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.exec_sql FROM authenticated';
    -- Only service_role should call this
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.exec_sql TO service_role';
    RAISE NOTICE 'exec_sql: locked down to service_role only';
  ELSE
    RAISE NOTICE 'exec_sql: function does not exist, skipping';
  END IF;
END
$$;

-- ═══════════════════════════════════════════════════════════════
-- 5. ENSURE AUTHENTICATED (ADMIN) ROLE RETAINS FULL ACCESS
-- ═══════════════════════════════════════════════════════════════
-- Admin users authenticate via Supabase auth and use the
-- authenticated role. They need full column access for the
-- admin dashboard.

GRANT SELECT ON bug_reports TO authenticated;
GRANT SELECT ON job_applications TO authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ideas') THEN
    GRANT SELECT ON ideas TO authenticated;
  END IF;
END
$$;

-- Policy comments skipped — policy names vary by environment
