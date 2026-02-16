-- Fix status constraint to include all valid statuses
ALTER TABLE bug_reports DROP CONSTRAINT IF EXISTS bug_reports_status_check;
ALTER TABLE bug_reports ADD CONSTRAINT bug_reports_status_check 
  CHECK (status IN ('open', 'investigating', 'fixed', 'unpaid', 'paid', 'wont_fix', 'duplicate', 'invalid'));
