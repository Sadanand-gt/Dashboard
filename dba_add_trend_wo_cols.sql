-- ============================================================================
-- Ananya MIS — Write-off-portion companions for the Trend flow measures
-- Database: ananya_mis_dashboard   Schema: public   Run as the table OWNER (postgres).
--
-- Why: the trend's flow measures (Collection Efficiency, Regular-bucket CE,
-- Roll Rate, OD Slippage) are stored EXCLUDING written-off loans. To offer the
-- same "With W/O" / "Excl. W/O" toggle the live reports have, each of these
-- needs its write-off portion stored alongside. The backend folds base + *_wo
-- for the "With W/O" view (exactly like pos_eom + wo_pos_eom); "Excl. W/O" uses
-- the base as-is. Write-off is applied CHRONOLOGICALLY (a loan stays in the live
-- book until its write-off month, then moves to the *_wo side).
--
-- Types mirror the existing base columns: numeric(18,2), except the count (bigint).
--
-- After running this, the pipeline does a ONE-TIME FULL REBUILD to populate them:
--     python -m pipeline.runner --report trend_full
-- (mis_dashboard already has DELETE/INSERT; it only lacked ownership to ALTER.)
--
-- Safe to re-run (IF NOT EXISTS). No data is moved or deleted.
-- ============================================================================

ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS demand_wo             numeric(18,2);
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS collection_capped_wo  numeric(18,2);
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS slip_count_wo         bigint;
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS slip_pos_wo           numeric(18,2);
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS prev_regular_pos_wo   numeric(18,2);
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS reg_demand_wo         numeric(18,2);
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS reg_collection_wo     numeric(18,2);

-- Verify (expect 7 rows):
-- SELECT column_name, data_type, numeric_precision, numeric_scale
--   FROM information_schema.columns
--  WHERE table_name = 'rpt_trend_full'
--    AND column_name IN ('demand_wo','collection_capped_wo','slip_count_wo',
--                        'slip_pos_wo','prev_regular_pos_wo','reg_demand_wo',
--                        'reg_collection_wo')
--  ORDER BY column_name;
