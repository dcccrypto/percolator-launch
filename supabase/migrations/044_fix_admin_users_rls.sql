-- Migration 044: Tighten admin_users RLS and job_applications UPDATE policy
-- Fixes: GH#1211 — admin email enumeration via PostgREST (authenticated role)
--
-- PROBLEM:
--   Migration 016 grants SELECT on admin_users TO authenticated WITH USING (true).
--   Any Supabase user can enumerate all admin emails via PostgREST.
--
-- FIX (Option B — self-check only):
--   Replace the open SELECT policy with a self-check policy:
--   authenticated users can only see their own row (email = their JWT email).
--   This preserves the admin/page.tsx "am I an admin?" check while
--   closing the enumeration vector. Service_role retains full access (bypasses RLS).
--
-- ALSO:
--   Tighten job_applications UPDATE policy to TO service_role (missing from 020).

-- ── admin_users: replace open SELECT with self-check ─────────────────────────

DROP POLICY IF EXISTS "Authenticated can read admin_users" ON admin_users;

CREATE POLICY "admin_users_self_check"
  ON admin_users FOR SELECT
  TO authenticated
  USING (email = (auth.jwt() ->> 'email'));

-- ── job_applications: restrict UPDATE to service_role ────────────────────────

DROP POLICY IF EXISTS "Service can update applications" ON job_applications;

CREATE POLICY "Service can update applications"
  ON job_applications FOR UPDATE
  TO service_role
  USING (true);
