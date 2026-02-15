-- Enable RLS on bug_reports (if not already)
ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;

-- Public can INSERT (submit bugs) and SELECT (view bugs page)
CREATE POLICY "Anyone can submit bugs"
  ON bug_reports FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can view bugs"
  ON bug_reports FOR SELECT
  TO anon, authenticated
  USING (true);

-- Only authenticated users (admins) can UPDATE
CREATE POLICY "Admins can update bugs"
  ON bug_reports FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Only authenticated users (admins) can DELETE
CREATE POLICY "Admins can delete bugs"
  ON bug_reports FOR DELETE
  TO authenticated
  USING (true);
