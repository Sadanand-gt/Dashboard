-- =============================================================================
-- DBA: create rpt_ots  (One-Time Settlement report)
-- Run as the owner in database  ananya_mis_dashboard.
-- The pipeline user (mis_dashboard) has SELECT/INSERT/DELETE only, no DDL.
--
-- NOTE branch_id is TEXT, not bigint — branch ids look like 'B15' / 'B0049'.
-- (rpt_aml was created as bigint first and the pipeline failed with
--  "invalid input syntax for type bigint: B15". Same trap here.)
-- =============================================================================

CREATE TABLE IF NOT EXISTS rpt_ots (
    loan_source           text,
    business_segment      text,
    zone_name             text,
    cluster_name          text,
    region_name           text,
    area_name             text,
    branch_name           text,
    branch_id             text,
    lo_id                 text,
    state_id              text,
    district_id           text,
    product_id            text,
    settle_bucket         text,
    settle_year           text,
    settle_month          text,

    ots_count             bigint,
    ots_amount            numeric,
    principal_collected   numeric,
    interest_collected    numeric,
    principal_waiver      numeric,
    interest_waiver       numeric,
    total_waiver          numeric,
    net_amount_collected  numeric,
    net_principal         numeric,
    net_interest          numeric,
    last_settle_date      date,

    report_day            date
);

CREATE INDEX IF NOT EXISTS ix_rpt_ots_day    ON rpt_ots (report_day);
CREATE INDEX IF NOT EXISTS ix_rpt_ots_branch ON rpt_ots (branch_id);
CREATE INDEX IF NOT EXISTS ix_rpt_ots_bucket ON rpt_ots (settle_bucket);

GRANT SELECT, INSERT, DELETE ON rpt_ots TO mis_dashboard;

-- Sanity after the first pipeline run (expected on 2026-08-04: 445 rows,
-- 880 OTS loans, settled 2.023 Cr, waiver 1.504 Cr, net cash 0.520 Cr):
--   SELECT count(*) rows, sum(ots_count) loans,
--          round(sum(ots_amount)/1e7,3)           settled_cr,
--          round(sum(total_waiver)/1e7,3)         waiver_cr,
--          round(sum(net_amount_collected)/1e7,3) cash_cr
--   FROM rpt_ots WHERE report_day = (SELECT max(report_day) FROM rpt_ots);
