-- ============================================================================
-- Ananya MIS — table for the 13 Trend reports (full monthly history engine)
-- Database: ananya_mis_dashboard   Schema: public   Run as table owner.
--
-- Grain: one row per month_end × loan_source/segment × branch × loan officer.
-- Load: whole-table refresh by the pipeline (DELETE + INSERT). NO report_day
-- column — the table already carries every month of history.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rpt_trend_full (
    month_end        DATE,
    loan_source      TEXT,
    business_segment TEXT,
    zone_name        TEXT,
    cluster_name     TEXT,
    region_name      TEXT,
    area_name        TEXT,
    branch_name      TEXT,
    branch_id        TEXT,
    lo_id            TEXT,
    loans_eom        BIGINT,
    pos_eom          NUMERIC(18,2),
    par0_pos         NUMERIC(18,2),
    par30_pos        NUMERIC(18,2),
    par60_pos        NUMERIC(18,2),
    par90_pos        NUMERIC(18,2),
    disb_count       BIGINT,
    disb_amount      NUMERIC(18,2),
    demand           NUMERIC(18,2),
    collection       NUMERIC(18,2),
    collection_capped NUMERIC(18,2),
    slip_count       BIGINT,
    slip_pos         NUMERIC(18,2),
    prev_regular_pos NUMERIC(18,2),
    reg_demand       NUMERIC(18,2),
    reg_collection   NUMERIC(18,2),
    par60_collection NUMERIC(18,2),
    wo_recovery      NUMERIC(18,2)
);

CREATE INDEX IF NOT EXISTS idx_rpt_trend_full_month  ON rpt_trend_full(month_end);
CREATE INDEX IF NOT EXISTS idx_rpt_trend_full_branch ON rpt_trend_full(branch_id);

GRANT SELECT, INSERT, DELETE ON rpt_trend_full TO mis_dashboard;
