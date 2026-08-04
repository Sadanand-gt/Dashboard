-- DBA: add the "in the previous month-end portfolio" flag to rpt_aum_status.
-- aum_status.sql now emits onbook_prev_eom (boolean = disbursed on/before prev
-- month-end). OD Status + Bucket Movement filter onbook_prev_eom = TRUE so the
-- movement universe is the month-end portfolio (excludes current-month disbursals,
-- keeps current-month closures). mis_dashboard lacks ALTER, so this is DBA-owned.
-- Nullable, no default — the pipeline sets it on every row on the next run.
ALTER TABLE public.rpt_aum_status ADD COLUMN IF NOT EXISTS onbook_prev_eom boolean;
