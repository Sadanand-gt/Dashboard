-- =============================================================================
-- Report  : Cashless Collection %
-- PBI Page: "Cashless collection %"
-- Tables  : repayment_detail_il / repayment_detail (JLG)
--           loan_account_il / home_loan_account
--           brnch_master, area_master
-- Metrics (exact DAX):
--   Daily cashless    : SUM(amount_collected) WHERE coll_pay_mode='CL' AND date=yesterday
--   Daily Collection  : SUM(amount_collected) WHERE status='A' AND date=yesterday
--   Daily CL%         : Daily cashless / Daily Collection
--   MTD cashless      : SUM(amount_collected) WHERE coll_pay_mode='CL', this month up to yesterday
--   MTD Total Coll    : SUM(amount_collected) WHERE status='A', this month up to yesterday
--   MTD CL%           : MTD cashless / MTD Total Collection
-- NOTE: PBI uses coll_pay_mode='CL' for cashless (NOT 'CASH' or 'BANK')
-- Slicers: Cluster, Region, Area, Branch, Product
-- =============================================================================

WITH

-- Write-off master (loan_id + date). Overrides loan STATUS only — never the
-- collection figures — exactly as in every other write-off-aware report.
wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date
    FROM (VALUES {wo_pairs}) AS v(loan_id, wo_date)
),

params AS (
    SELECT
        current_date - 1                                               AS yesterday,
        date_trunc('month', current_date - 1)::date                        AS curr_month_start,
        (date_trunc('month', current_date - 1) - interval '1 day')::date   AS prev_month_end
),

hierarchy AS (
    SELECT
        bm.branch_id,
        bm.branch_name,
        a.area_name,
        reg.branch_name AS region_name,
        clus.area_name  AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON a.area_id    = bm.area_id
    LEFT JOIN public.brnch_master reg  ON reg.branch_id = a.region_id
    LEFT JOIN public.area_master  clus ON clus.area_id  = reg.area_id
    WHERE bm.active = 'Y'
      AND bm.is_region = 'N'
      AND bm.branch_name <> 'DEMO'
),

-- IL collections
il_coll AS (
    SELECT
        CASE
            WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
            THEN 'LAP'
            ELSE 'IEL'
        END                                    AS loan_source,
        la.branch_id,
        la.loan_officer::varchar            AS lo_id,
        la.product_id::text                 AS product_id,
        -- Canonical loan_status LABELS, identical to every other report. This
        -- table used to emit the raw core codes ('A','X'), which silently broke
        -- the With / Excl W/O toggle and the shared Loan Status slicer — both
        -- test for 'Write-off', which a raw 'W' never matched.
        CASE
            WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                 AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
                                            THEN 'Write-off'
            WHEN la.status = 'A'            THEN 'Active'
            WHEN la.status IN ('D','I')     THEN 'Death'
            WHEN la.status = 'X'            THEN 'Closed'
            ELSE la.status
        END                                 AS loan_status,
        rd.amount_collected,
        rd.coll_pay_mode,
        rd.collection_date_time::date       AS col_date
    FROM public.repayment_detail_il rd
    JOIN public.loan_account_il la ON la.loan_id = rd.loan_id
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    CROSS JOIN params p
    WHERE rd.status = 'A'
      AND rd.collection_date_time::date >= p.curr_month_start
      AND rd.collection_date_time::date <= p.yesterday
),

-- JLG: repayment_detail has no coll_pay_mode — cashless report is IL only (per PBI)

all_coll AS (
    SELECT * FROM il_coll
)

SELECT
    ac.loan_source,
    ac.loan_status,
    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    ac.branch_id,
    coalesce(ac.lo_id, 'N/A')              AS lo_id,
    ac.product_id,

    -- Daily (yesterday only)
    round(sum(CASE WHEN ac.col_date = (SELECT yesterday FROM params)
                    AND ac.coll_pay_mode = 'CL'
                   THEN ac.amount_collected ELSE 0 END)::numeric, 2) AS daily_cashless,

    round(sum(CASE WHEN ac.col_date = (SELECT yesterday FROM params)
                   THEN ac.amount_collected ELSE 0 END)::numeric, 2) AS daily_collection,

    CASE WHEN sum(CASE WHEN ac.col_date = (SELECT yesterday FROM params)
                       THEN ac.amount_collected ELSE 0 END) = 0 THEN NULL
         ELSE round((
             sum(CASE WHEN ac.col_date = (SELECT yesterday FROM params)
                       AND ac.coll_pay_mode = 'CL'
                      THEN ac.amount_collected ELSE 0 END) * 100.0
             / sum(CASE WHEN ac.col_date = (SELECT yesterday FROM params)
                        THEN ac.amount_collected ELSE 0 END)
         )::numeric, 2)
    END                                                               AS daily_cashless_pct,

    -- MTD (full current month up to yesterday)
    round(sum(CASE WHEN ac.coll_pay_mode = 'CL'
                   THEN ac.amount_collected ELSE 0 END)::numeric, 2) AS mtd_cashless,

    round(sum(ac.amount_collected)::numeric, 2)                      AS mtd_collection,

    CASE WHEN sum(ac.amount_collected) = 0 THEN NULL
         ELSE round((
             sum(CASE WHEN ac.coll_pay_mode = 'CL'
                      THEN ac.amount_collected ELSE 0 END) * 100.0
             / sum(ac.amount_collected)
         )::numeric, 2)
    END                                                               AS mtd_cashless_pct,

    (SELECT yesterday FROM params)                                    AS report_date

FROM all_coll ac
LEFT JOIN hierarchy h ON h.branch_id = ac.branch_id
GROUP BY
    ac.loan_source, ac.loan_status, h.cluster_name, h.region_name, h.area_name, h.branch_name,
    ac.branch_id, ac.lo_id, ac.product_id
ORDER BY
    ac.loan_source, ac.loan_status, h.cluster_name, h.region_name, h.area_name, h.branch_name;
