-- ============================================================================
-- Ananya MIS — "ID & Name" display columns for the Current Outstanding report
-- Database: ananya_mis_dashboard   Schema: public   Run as the table owner.
--
-- STATUS: ALREADY APPLIED on 2026-07-23 — the pipeline's own ensure_columns()
-- added all six columns and rpt_aum_status is populated. NO DBA ACTION NEEDED.
-- Kept as the record of the change, and for rebuilding the table elsewhere.
--
-- Why: the reference workbook shows hierarchy values as "<id> - <NAME>" (the
-- Excel slicer is literally "BRANCH ID & NAME", and the S.Incentive notebook
-- builds branch/area/region/cluster/zone the same way). These six columns carry
-- that display form, plus the loan-officer name.
--
-- IMPORTANT — these are ADDITIVE, display-only columns. The existing
-- zone_name / cluster_name / region_name / area_name / branch_name / lo_id
-- columns are NOT touched: they carry the access-control scope values
-- (backend/core/scope.py) and the shared slicer values every other report
-- filters on, so their format must stay exactly as it is.
--
-- Safe to re-run (IF NOT EXISTS). No data is moved or deleted.
-- ============================================================================

ALTER TABLE rpt_aum_status ADD COLUMN IF NOT EXISTS zone_label    TEXT;
ALTER TABLE rpt_aum_status ADD COLUMN IF NOT EXISTS cluster_label TEXT;
ALTER TABLE rpt_aum_status ADD COLUMN IF NOT EXISTS region_label  TEXT;
ALTER TABLE rpt_aum_status ADD COLUMN IF NOT EXISTS area_label    TEXT;
ALTER TABLE rpt_aum_status ADD COLUMN IF NOT EXISTS branch_label  TEXT;
ALTER TABLE rpt_aum_status ADD COLUMN IF NOT EXISTS lo_name       TEXT;

-- Verify (expect 6 rows):
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_name = 'rpt_aum_status'
--    AND column_name IN ('zone_label','cluster_label','region_label',
--                        'area_label','branch_label','lo_name')
--  ORDER BY column_name;
