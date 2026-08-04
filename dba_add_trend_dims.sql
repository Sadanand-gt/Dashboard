-- ============================================================================
-- Ananya MIS — Tier 1+2 slicer dimensions for the Trend report
-- Database: ananya_mis_dashboard   Schema: public   Run as the table owner.
--
-- Why: the trend now supports grouping/filtering by state, district,
-- disbursement year, cycle and product classification (matching the Analysis
-- Parameters on the report pages). These five columns widen rpt_trend_full's
-- grain from month × segment × branch × LO to also include them.
--
-- After running this, the pipeline must do a ONE-TIME FULL REBUILD so the
-- history is re-materialised at the new grain:
--     python -m pipeline.runner --report trend_full
-- The table grows from ~29k to ~1.3M rows. The backend already aggregates the
-- trend in SQL (reads only the needed slice per request), so the size is fine;
-- the two indexes below keep those grouped reads fast.
--
-- Safe to re-run (IF NOT EXISTS). No data is moved or deleted.
-- ============================================================================

ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS state_id            TEXT;
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS district_id         TEXT;
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS disb_year           TEXT;
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS cycle_no            TEXT;
ALTER TABLE rpt_trend_full ADD COLUMN IF NOT EXISTS prod_classification TEXT;

-- The trend endpoint filters/groups by month_end plus these dims; a couple of
-- covering-ish indexes keep the per-request GROUP BY quick at ~1.3M rows.
CREATE INDEX IF NOT EXISTS idx_rpt_trend_full_month      ON rpt_trend_full (month_end);
CREATE INDEX IF NOT EXISTS idx_rpt_trend_full_seg_month  ON rpt_trend_full (business_segment, month_end);

-- Verify (expect 5 rows):
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name = 'rpt_trend_full'
--    AND column_name IN ('state_id','district_id','disb_year','cycle_no','prod_classification')
--  ORDER BY column_name;
