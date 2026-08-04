-- =============================================================================
-- DBA: add loan_status to rpt_pos_par
-- Why : pos_par.sql now emits a loan_status split ('Active' / 'Write-off') so the
--       POS & PAR report can offer a With / Excl-W/O portfolio view and its PAR
--       matches Excel + Current Outstanding (write-off master applied). The
--       pipeline user (mis_dashboard) cannot ALTER, so the DBA must add the column
--       before the next pos_par run (report_store.ensure_columns otherwise fails
--       with "must be owner of table").
-- Run as the table owner (postgres) on ananya_mis_dashboard.
-- =============================================================================

ALTER TABLE rpt_pos_par ADD COLUMN IF NOT EXISTS loan_status TEXT;
