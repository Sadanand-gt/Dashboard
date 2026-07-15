-- ============================================================================
-- Ananya MIS — add the run-day column for day-by-day report storage
-- Database: ananya_mis_dashboard   Schema: public
-- Run as the table owner (the mis_dashboard user has DML but not DDL rights).
--
-- report_day = the date the pipeline produced the rows. Each daily run
-- appends its rows stamped with that day (re-runs replace only that day).
-- The dashboard reads WHERE report_day = MAX(report_day).
--
-- Only the 17 report tables need it. NOT needed on: writeoff_master,
-- pipeline_log, rpt_dpd_snapshot (they have their own keys).
-- ============================================================================

ALTER TABLE rpt_pos_par             ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_aum_status          ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_aum_live            ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_disbursement        ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_disb_daily          ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_collection          ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_daily_collection    ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_mtd_collection      ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_cashless_collection ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_delinquencies       ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_od_list             ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_od_slippage         ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_dq_category         ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_bucket_movement     ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_case_movement       ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_writeoff            ADD COLUMN IF NOT EXISTS report_day DATE;
ALTER TABLE rpt_trend_monthly       ADD COLUMN IF NOT EXISTS report_day DATE;

-- Index so "latest day" reads and per-day replaces stay fast as days accrue
CREATE INDEX IF NOT EXISTS idx_rpt_pos_par_day             ON rpt_pos_par(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_aum_status_day          ON rpt_aum_status(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_aum_live_day            ON rpt_aum_live(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_disbursement_day        ON rpt_disbursement(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_disb_daily_day          ON rpt_disb_daily(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_collection_day          ON rpt_collection(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_daily_collection_day    ON rpt_daily_collection(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_mtd_collection_day      ON rpt_mtd_collection(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_cashless_collection_day ON rpt_cashless_collection(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_delinquencies_day       ON rpt_delinquencies(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_od_list_day             ON rpt_od_list(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_od_slippage_day         ON rpt_od_slippage(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_dq_category_day         ON rpt_dq_category(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_bucket_movement_day     ON rpt_bucket_movement(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_case_movement_day       ON rpt_case_movement(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_writeoff_day            ON rpt_writeoff(report_day);
CREATE INDEX IF NOT EXISTS idx_rpt_trend_monthly_day       ON rpt_trend_monthly(report_day);
