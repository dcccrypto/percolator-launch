-- Migration 028: Add fixed_unpaid status to bug_reports
-- 
-- Context: Adds 'fixed_unpaid' status to distinguish bugs that have been
-- verified fixed (code merged, deployed) but where the bounty payment has
-- not yet been sent to the reporter. Separate from 'paid' (payment confirmed sent).

ALTER TABLE bug_reports DROP CONSTRAINT IF EXISTS bug_reports_status_check;
ALTER TABLE bug_reports ADD CONSTRAINT bug_reports_status_check 
  CHECK (status IN ('open', 'investigating', 'fixed', 'unpaid', 'paid', 'wont_fix', 'duplicate', 'invalid', 'fixed_unpaid'));
