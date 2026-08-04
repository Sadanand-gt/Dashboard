-- =============================================================================
-- Report  : Daily Collection Efficiency
-- Tables   : repayment_schedule_il / repayment_schedule (JLG)
--            repayment_detail_il   / repayment_detail   (JLG)
--            loan_account_il       / home_loan_account  (JLG)
--            brnch_master, area_master (hierarchy)
-- Period   : Previous month (full) + Current month up to yesterday
-- PMSD     : Previous Month Same Date — mirrors the PBI "PMSD" measures
--            e.g. today = 22-Jun → PMSD cutoff = 22-May
-- Metrics  : daily_demand, daily_collection, daily_ce_pct
--            cumul_demand (MTD), cumul_collection (MTD), cumul_ce_pct
--            pmsd_collection (same date in prev month), pmsd_ce_pct
-- Key cols : repayment_detail_il.AMOUNT_COLLECTED   (total per receipt)
--            repayment_detail_il.COLL_PAY_MODE       (payment mode)
--            repayment_schedule_il.TOTAL_AMT_DUE     (demand per EMI)
-- =============================================================================

WITH

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DATE PARAMS
-- ─────────────────────────────────────────────────────────────────────────────
params AS (
    SELECT
        current_date - 1                                                  AS yesterday,
        date_trunc('month', current_date - 1)::date                           AS curr_month_start,
        (date_trunc('month', current_date - 1) - interval '1 day')::date      AS prev_month_end,
        date_trunc('month', current_date - 1 - interval '1 month')::date      AS prev_month_start,
        -- PMSD cutoff: same day-of-month in previous month
        -- e.g. June 22 → May 22; capped at prev month end
        LEAST(
            (date_trunc('month', current_date - 1 - interval '1 month')
             + (extract(day from current_date - 1)::int - 1) * interval '1 day')::date,
            (date_trunc('month', current_date - 1) - interval '1 day')::date
        )                                                                 AS pmsd_cutoff
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DATE SERIES (prev month + current month to yesterday)
-- ─────────────────────────────────────────────────────────────────────────────
date_series AS (
    SELECT
        d::date                             AS col_date,
        date_trunc('month', d)::date        AS month_start,
        to_char(d, 'YYYY-MM')               AS month_label,
        CASE WHEN d::date >= (SELECT curr_month_start FROM params)
             THEN 'CURRENT' ELSE 'PREVIOUS' END AS month_type
    FROM generate_series(
        (SELECT prev_month_start FROM params),
        (SELECT yesterday FROM params),
        interval '1 day'
    ) d
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. BRANCH HIERARCHY
-- ─────────────────────────────────────────────────────────────────────────────
hierarchy AS (
    SELECT
        bm.branch_id,
        bm.branch_name,
        a.area_name,
        reg.branch_name AS region_name,
        clus.area_name  AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
    WHERE bm.active = 'Y' AND bm.is_region = 'N'
      AND bm.branch_name <> 'DEMO' AND bm.closing_date IS NULL
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 4a. IL — DAILY DEMAND
--     "Net Demand of the Day" in PBI = total_amt_due per demand_date per branch
-- ─────────────────────────────────────────────────────────────────────────────
il_demand AS (
    SELECT
        rs.demand_date            AS col_date,
        la.branch_id,
        coalesce(la.loan_officer::varchar, 'N/A') AS lo_id,
        'IL'                      AS loan_source,
        sum(rs.total_amt_due)     AS daily_demand,
        sum(rs.principal_due)     AS principal_demand,
        sum(rs.interest_due)      AS interest_demand,
        count(distinct rs.loan_id) AS loans_due
    FROM public.repayment_schedule_il rs
    JOIN public.loan_account_il la ON la.loan_id = rs.loan_id
    WHERE rs.demand_date BETWEEN
          (SELECT prev_month_start FROM params) AND (SELECT yesterday FROM params)
      AND la.status NOT IN ('X', 'R')
    GROUP BY rs.demand_date, la.branch_id, coalesce(la.loan_officer::varchar, 'N/A')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 4b. IL — DAILY COLLECTION
--     Uses AMOUNT_COLLECTED (total per receipt) and COLL_PAY_MODE (PBI column)
--     "Collection on the same day" = collections where collection_date = demand_date
--     "mtd collection_date" = collection_date_time::date
-- ─────────────────────────────────────────────────────────────────────────────
il_collection AS (
    SELECT
        rd.collection_date_time::date   AS col_date,
        la.branch_id,
        coalesce(la.loan_officer::varchar, 'N/A') AS lo_id,
        'IL'                            AS loan_source,
        sum(rd.amount_collected)        AS daily_collection,
        sum(rd.principal_collected)     AS principal_collected,
        sum(rd.interest_collected)      AS interest_collected,
        count(distinct rd.loan_id)      AS loans_collected,
        -- Payment mode breakdown (codes: CH=cash, CL=cashless/bank, LR/NF/other)
        sum(CASE WHEN rd.coll_pay_mode = 'CH' THEN rd.amount_collected ELSE 0 END) AS cash_collection,
        sum(CASE WHEN rd.coll_pay_mode = 'CL' THEN rd.amount_collected ELSE 0 END) AS bank_collection,
        sum(CASE WHEN coalesce(rd.coll_pay_mode,'') NOT IN ('CH','CL')
                 THEN rd.amount_collected ELSE 0 END)                                  AS other_collection
    FROM public.repayment_detail_il rd
    JOIN public.loan_account_il la ON la.loan_id = rd.loan_id
    WHERE rd.collection_date_time::date BETWEEN
          (SELECT prev_month_start FROM params) AND (SELECT yesterday FROM params)
      AND rd.status = 'A'
    GROUP BY rd.collection_date_time::date, la.branch_id, coalesce(la.loan_officer::varchar, 'N/A')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 5a. JLG — DAILY DEMAND  (repayment_schedule_JLG = repayment_schedule in PG)
-- ─────────────────────────────────────────────────────────────────────────────
jlg_demand AS (
    SELECT
        rs.demand_date             AS col_date,
        cm.branch_id,
        coalesce(cm.assigned_to::varchar, 'N/A') AS lo_id,
        'JLG'                      AS loan_source,
        sum(rs.total_amt_due)      AS daily_demand,
        sum(rs.principal_due)      AS principal_demand,
        sum(rs.interest_due)       AS interest_demand,
        count(distinct rs.loan_id) AS loans_due
    FROM public.repayment_schedule rs
    JOIN public.home_loan_account la  ON la.loan_id   = rs.loan_id
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    WHERE rs.demand_date BETWEEN
          (SELECT prev_month_start FROM params) AND (SELECT yesterday FROM params)
      AND la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND la.status NOT IN ('X', 'R')
    GROUP BY rs.demand_date, cm.branch_id, coalesce(cm.assigned_to::varchar, 'N/A')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 5b. JLG — DAILY COLLECTION  (repayment_detail_JLG = repayment_detail in PG)
-- ─────────────────────────────────────────────────────────────────────────────
jlg_collection AS (
    SELECT
        rd.collection_date_time::date   AS col_date,
        cm.branch_id,
        coalesce(cm.assigned_to::varchar, 'N/A') AS lo_id,
        'JLG'                           AS loan_source,
        sum(rd.amount_collected)        AS daily_collection,
        sum(rd.principal_collected)     AS principal_collected,
        sum(rd.interest_collected)      AS interest_collected,
        count(distinct rd.loan_id)      AS loans_collected,
        -- JLG uses payment_mode (codes: CH=cash, CL=cashless/bank, LR/NF/other)
        sum(CASE WHEN rd.payment_mode = 'CH' THEN rd.amount_collected ELSE 0 END) AS cash_collection,
        sum(CASE WHEN rd.payment_mode = 'CL' THEN rd.amount_collected ELSE 0 END) AS bank_collection,
        sum(CASE WHEN coalesce(rd.payment_mode,'') NOT IN ('CH','CL')
                 THEN rd.amount_collected ELSE 0 END)                                  AS other_collection
    FROM public.repayment_detail rd
    JOIN public.home_loan_account la  ON la.loan_id   = rd.loan_id
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    WHERE rd.collection_date_time::date BETWEEN
          (SELECT prev_month_start FROM params) AND (SELECT yesterday FROM params)
      AND la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND rd.status = 'A'
    GROUP BY rd.collection_date_time::date, cm.branch_id, coalesce(cm.assigned_to::varchar, 'N/A')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. UNION DEMAND AND COLLECTION
-- ─────────────────────────────────────────────────────────────────────────────
combined AS (
    -- IL rows
    SELECT
        coalesce(d.loan_source, c.loan_source)  AS loan_source,
        coalesce(d.col_date,    c.col_date)     AS col_date,
        coalesce(d.branch_id,   c.branch_id)    AS branch_id,
        coalesce(d.lo_id,       c.lo_id)        AS lo_id,
        coalesce(d.daily_demand,       0)        AS daily_demand,
        coalesce(d.principal_demand,   0)        AS principal_demand,
        coalesce(d.interest_demand,    0)        AS interest_demand,
        coalesce(d.loans_due,          0)        AS loans_due,
        coalesce(c.daily_collection,   0)        AS daily_collection,
        coalesce(c.principal_collected,0)        AS principal_collected,
        coalesce(c.interest_collected, 0)        AS interest_collected,
        coalesce(c.loans_collected,    0)        AS loans_collected,
        coalesce(c.cash_collection,    0)        AS cash_collection,
        coalesce(c.bank_collection,    0)        AS bank_collection,
        coalesce(c.other_collection,   0)        AS other_collection
    FROM il_demand d
    FULL OUTER JOIN il_collection c
        ON c.col_date = d.col_date AND c.branch_id = d.branch_id AND c.lo_id = d.lo_id

    UNION ALL

    -- JLG rows
    SELECT
        coalesce(d.loan_source, c.loan_source),
        coalesce(d.col_date,    c.col_date),
        coalesce(d.branch_id,   c.branch_id),
        coalesce(d.lo_id,       c.lo_id),
        coalesce(d.daily_demand,       0),
        coalesce(d.principal_demand,   0),
        coalesce(d.interest_demand,    0),
        coalesce(d.loans_due,          0),
        coalesce(c.daily_collection,   0),
        coalesce(c.principal_collected,0),
        coalesce(c.interest_collected, 0),
        coalesce(c.loans_collected,    0),
        coalesce(c.cash_collection,    0),
        coalesce(c.bank_collection,    0),
        coalesce(c.other_collection,   0)
    FROM jlg_demand d
    FULL OUTER JOIN jlg_collection c
        ON c.col_date = d.col_date AND c.branch_id = d.branch_id AND c.lo_id = d.lo_id
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ATTACH HIERARCHY + DATE LABELS
-- ─────────────────────────────────────────────────────────────────────────────
with_hier AS (
    SELECT
        cb.loan_source,
        cb.col_date::date                       AS col_date,
        ds.month_label,
        ds.month_type,
        coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
        coalesce(h.region_name,  'Unassigned') AS region_name,
        coalesce(h.area_name,    'Unassigned') AS area_name,
        coalesce(h.branch_name,  'Unassigned') AS branch_name,
        cb.branch_id,
        cb.lo_id,
        cb.daily_demand,
        cb.principal_demand,
        cb.interest_demand,
        cb.loans_due,
        cb.daily_collection,
        cb.principal_collected,
        cb.interest_collected,
        cb.loans_collected,
        cb.cash_collection,
        cb.bank_collection,
        cb.other_collection
    FROM combined cb
    JOIN date_series ds        ON ds.col_date = cb.col_date::date
    LEFT JOIN hierarchy h      ON h.branch_id = cb.branch_id
)

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. FINAL OUTPUT — daily metrics + MTD cumulative (running within each month)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    loan_source,
    col_date,
    month_label,
    month_type,
    cluster_name,
    region_name,
    area_name,
    branch_name,
    branch_id,
    lo_id,

    round(daily_demand::numeric,      2)  AS daily_demand,
    round(principal_demand::numeric,  2)  AS principal_demand,
    round(interest_demand::numeric,   2)  AS interest_demand,
    loans_due,
    round(daily_collection::numeric,  2)  AS daily_collection,
    round(principal_collected::numeric, 2) AS principal_collected,
    round(interest_collected::numeric,  2) AS interest_collected,
    loans_collected,
    round(cash_collection::numeric,   2)  AS cash_collection,
    round(bank_collection::numeric,   2)  AS bank_collection,
    round(other_collection::numeric,  2)  AS other_collection,

    -- Daily CE%
    CASE WHEN daily_demand > 0
         THEN round((daily_collection / daily_demand * 100)::numeric, 2)
         ELSE 0 END                       AS daily_ce_pct,

    -- MTD cumulative (running total within loan_source + branch + month)
    round(sum(daily_demand) OVER w::numeric,     2) AS cumul_demand,
    round(sum(daily_collection) OVER w::numeric, 2) AS cumul_collection,
    CASE WHEN sum(daily_demand) OVER w > 0
         THEN round((sum(daily_collection) OVER w
                     / sum(daily_demand) OVER w * 100)::numeric, 2)
         ELSE 0 END                       AS cumul_ce_pct

FROM with_hier
WINDOW w AS (
    PARTITION BY loan_source, branch_id, lo_id, month_label
    ORDER BY col_date
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
)
ORDER BY loan_source, branch_name, col_date;