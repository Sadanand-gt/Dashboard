-- DBA: two columns on rpt_aum_status for the OD Status / Bucket Movement fixes.
-- mis_dashboard has SELECT/INSERT/DELETE but not ALTER, so this is DBA-owned.
-- Both nullable, no default — the pipeline populates them on the next run.
--
-- 1) open_now  : TRUE = loan is in the LIVE active book (open as of the data date).
--    Needed because loan_status now classifies a written-off loan that closed this
--    month as 'Write-off' (correct: it is a deep-NPA settlement, not a healthy
--    "Regularised" move). Live-book reports (Current Outstanding / Ageing / exec
--    summary) filter open_now IS TRUE so their numbers stay byte-identical, while
--    the movement reports keep current-month closures in the month-end portfolio.
--
-- 2) prev_pos  : POS at the PREVIOUS month-end. Bucket Movement / OD Status are
--    denominated in previous-month POS (the Excel sheet header is literally
--    "POS [Previous Month]"), NOT the live POS. Using live POS understated the
--    30-Jun figure as Rs 318.24 Cr; prev_pos gives Rs 341.86 Cr, matching Excel
--    (341.71 Cr) and our own trend engine's pos_eom (341.92 Cr).
ALTER TABLE public.rpt_aum_status ADD COLUMN IF NOT EXISTS open_now boolean;
ALTER TABLE public.rpt_aum_status ADD COLUMN IF NOT EXISTS prev_pos numeric(18,2);
