-- Admin users table — whitelist of emails allowed admin access
CREATE TABLE IF NOT EXISTS admin_users (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

-- RLS on admin_users: only service role can modify
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read admin_users"
  ON admin_users FOR SELECT
  TO authenticated
  USING (true);

-- Drop old overly-permissive policies
DROP POLICY IF EXISTS "Admins can update bugs" ON bug_reports;
DROP POLICY IF EXISTS "Admins can delete bugs" ON bug_reports;

-- New policies: only admin-whitelisted users can update/delete
CREATE POLICY "Admins can update bugs"
  ON bug_reports FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.jwt() ->> 'email') IN (SELECT email FROM admin_users)
  )
  WITH CHECK (
    (SELECT auth.jwt() ->> 'email') IN (SELECT email FROM admin_users)
  );

CREATE POLICY "Admins can delete bugs"
  ON bug_reports FOR DELETE
  TO authenticated
  USING (
    (SELECT auth.jwt() ->> 'email') IN (SELECT email FROM admin_users)
  );
