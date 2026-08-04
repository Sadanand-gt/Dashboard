-- =============================================================================
-- DBA: create rpt_mtd_flow — the trend's current-month (MTD, partial) point for
-- wo_recovery + par60_collection. No live report table carries these, so the
-- pipeline computes them (post-write-off recovery + collections from prev-EOM
-- PAR>60 loans) keyed like the trend so backend/api/trend.py can append the July
-- point per group. Whole-table replace (single snapshot; NO report_day column,
-- like rpt_trend_full). Owned by postgres; grant DML so the pipeline's
-- pg_write_df (DELETE + INSERT, mode='replace') can populate it.
--
-- After running this, populate with:   python -m pipeline.runner --report mtd_flow
-- (the daily batch runs it automatically once the table exists).
-- =============================================================================
DROP TABLE IF EXISTS public.rpt_mtd_flow;
CREATE TABLE public.rpt_mtd_flow (
    loan_source          text,
    business_segment     text,
    cluster_name         text,
    region_name          text,
    area_name            text,
    branch_name          text,
    branch_id            text,
    lo_id                text,
    mtd_wo_recovery      numeric,
    mtd_par60_collection numeric
);
GRANT SELECT, INSERT, DELETE ON public.rpt_mtd_flow TO mis_dashboard;
