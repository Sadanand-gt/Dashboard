-- =============================================================================
-- DBA: create the AML Risk Category report table in ananya_mis_dashboard.
-- The pipeline (pipeline/queries/aml_risk.sql via runner key "aml") writes here
-- with pg_write_report_day(), which day-stamps rows (report_day) and appends by
-- COLUMN NAME — so every column below must exist with a compatible type.
-- mis_dashboard has SELECT/INSERT/DELETE but NOT CREATE, hence this is DBA-owned.
-- Day-stamped exactly like every other rpt_* table.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.rpt_aml (
    report_day          text,          -- run-day stamp (pipeline reads MAX(report_day))
    as_of_date          date,          -- pipeline run date (T-1 shown in UI)
    loan_source         text,          -- JLG / IL
    business_segment    text,          -- JLG / IEL / LAP
    risk_category       text,          -- High / Low / Unclassified
    pep_flag            text,          -- PEP / Non-PEP / Unknown
    work_abroad_flag    text,          -- Works Abroad / Domestic / Unknown
    luc_flag            text,          -- LUC Done / LUC Pending / Unknown
    zone_name           text,          -- scope columns (core/scope.py filters on these)
    cluster_name        text,
    region_name         text,
    area_name           text,
    branch_name         text,
    branch_id           text,          -- branch CODE (e.g. "B15") — text, matches rpt_aum_status
    lo_id               text,
    lo_name             text,          -- "<lo_id> - <NAME>" (mapped in pandas)
    zone_label          text,          -- "<id> - <NAME>" display labels
    cluster_label       text,
    region_label        text,
    area_label          text,
    branch_label        text,
    prod_classification text,
    state_id            text,
    district_id         text,
    loan_count          bigint,        -- additive measures ↓
    total_pos           numeric(18,2),
    high_count          bigint,
    high_pos            numeric(18,2),
    low_count           bigint,
    pep_count           bigint,
    abroad_count        bigint,
    luc_pending_count   bigint,
    risk_unknown_count  bigint,
    pep_unknown_count   bigint
);
CREATE INDEX IF NOT EXISTS idx_rpt_aml_day ON public.rpt_aml(report_day);
GRANT SELECT, INSERT, DELETE ON public.rpt_aml TO mis_dashboard;
