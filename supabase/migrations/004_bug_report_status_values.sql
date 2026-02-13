-- Add 'unpaid', 'paid', and 'invalid' status values to bug_reports
ALTER TABLE bug_reports DROP CONSTRAINT bug_reports_status_check;
ALTER TABLE bug_reports ADD CONSTRAINT bug_reports_status_check 
  CHECK (status IN ('open', 'investigating', 'fixed', 'unpaid', 'paid', 'wont_fix', 'duplicate', 'invalid'));
