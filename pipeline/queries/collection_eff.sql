-- =============================================================================
-- Report  : MTD Collection Efficiency (CE%) with PMSD Comparison
-- Tables   : repayment_schedule_il / repayment_schedule (JLG)
--            repayment_detail_il   / repayment_detail   (JLG)
--            loan_account_il       / home_loan_account  (JLG)
--            brnch_master, area_master
-- Period   : Current month MTD (up to yesterday) vs PMSD (Previous Month Same Date)
-- PMSD     : PBI measure "Collection PMSD" — same day-range in previous month
-- Logic    : Opening advance = excess collected over demand up to previous month end
--            MTD demand      = EMIs due from curr_month_start to yesterday
--            MTD collection  = this month's collections + opening advance, capped at demand
-- Key cols : repayment_detail_il.AMOUNT_COLLECTED     (total receipt per transaction)
--            repayment_schedule_il.TOTAL_AMT_COLLECTED (collected against each installment)
--            repayment_schedule_il.TOTAL_AMT_DUE       (installment demand)
-- =============================================================================

WITH

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PARAMS
-- ─────────────────────────────────────────────────────────────────────────────
params AS (
    SELECT
        (date_trunc('month', current_date) - interval '1 day')::date   AS period_end,
        (current_date - interval '1 day')::date                         AS mtd_cutoff,
        date_trunc('month', current_date)::date                         AS curr_month_start,
        date_trunc('month', current_date - interval '1 month')::date    AS prev_month_start,
        LEAST(
            (date_trunc('month', current_date - interval '1 month')
             + (extract(day from current_date)::int - 1) * interval '1 day')::date,
            (date_trunc('month', current_date) - interval '1 day')::date
        )                                                               AS pmsd_cutoff
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. HIERARCHY
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

-- ═════════════════════════════════════════════════════════════════════════════
-- IL SECTION
-- ═════════════════════════════════════════════════════════════════════════════

-- Opening advance using TOTAL_AMT_COLLECTED (collected) vs TOTAL_AMT_DUE (demand)
il_opening_advance AS (
    SELECT
        loan_id,
        greatest(
            sum(CASE WHEN demand_date <= (SELECT period_end FROM params)
                     THEN total_amt_collected ELSE 0 END)
            - sum(CASE WHEN demand_date <= (SELECT period_end FROM params)
                       THEN total_amt_due ELSE 0 END),
            0
        ) AS opening_advance
    FROM public.repayment_schedule_il
    GROUP BY loan_id
),

-- MTD demand: installments due this month up to yesterday
il_mtd_demand AS (
    SELECT loan_id, sum(total_amt_due) AS demand_mtd
    FROM public.repayment_schedule_il, params p
    WHERE demand_date > p.period_end
      AND demand_date <= p.mtd_cutoff
    GROUP BY loan_id
),

-- MTD collection: amount_collected this month
il_mtd_collection AS (
    SELECT loan_id, sum(amount_collected) AS collection_mtd
    FROM public.repayment_detail_il, params p
    WHERE status = 'A'
      AND collection_date_time::date > p.period_end
      AND collection_date_time::date <= p.mtd_cutoff
    GROUP BY loan_id
),

-- PMSD demand: demand for same period last month
il_pmsd_demand AS (
    SELECT loan_id, sum(total_amt_due) AS demand_pmsd
    FROM public.repayment_schedule_il, params p
    WHERE demand_date >= p.prev_month_start
      AND demand_date <= p.pmsd_cutoff
    GROUP BY loan_id
),

-- PMSD collection: collection for same period last month (PBI "Collection for PMSD")
il_pmsd_collection AS (
    SELECT loan_id, sum(amount_collected) AS collection_pmsd
    FROM public.repayment_detail_il, params p
    WHERE status = 'A'
      AND collection_date_time::date >= p.prev_month_start
      AND collection_date_time::date <= p.pmsd_cutoff
    GROUP BY loan_id
),

il_loan_ce AS (
    SELECT
        'IL' AS loan_source,
        la.loan_id,
        la.branch_id,
        la.loan_officer AS lo_id,
        coalesce(md.demand_mtd, 0)                                  AS demand_mtd,
        least(
            coalesce(mc.collection_mtd, 0) + coalesce(oa.opening_advance, 0),
            coalesce(md.demand_mtd, 0)
        )                                                           AS collection_mtd,
        coalesce(pd.demand_pmsd, 0)                                 AS demand_pmsd,
        coalesce(pc.collection_pmsd, 0)                             AS collection_pmsd
    FROM public.loan_account_il la
    LEFT JOIN il_opening_advance oa ON oa.loan_id = la.loan_id
    LEFT JOIN il_mtd_demand      md ON md.loan_id = la.loan_id
    LEFT JOIN il_mtd_collection  mc ON mc.loan_id = la.loan_id
    LEFT JOIN il_pmsd_demand     pd ON pd.loan_id = la.loan_id
    LEFT JOIN il_pmsd_collection pc ON pc.loan_id = la.loan_id
    WHERE la.status NOT IN ('X', 'R')
),

-- ═════════════════════════════════════════════════════════════════════════════
-- JLG SECTION
-- ═════════════════════════════════════════════════════════════════════════════

jlg_opening_advance AS (
    SELECT
        loan_id,
        greatest(
            sum(CASE WHEN demand_date <= (SELECT period_end FROM params)
                     THEN total_amt_collected ELSE 0 END)
            - sum(CASE WHEN demand_date <= (SELECT period_end FROM params)
                       THEN total_amt_due ELSE 0 END),
            0
        ) AS opening_advance
    FROM public.repayment_schedule
    GROUP BY loan_id
),

jlg_mtd_demand AS (
    SELECT loan_id, sum(total_amt_due) AS demand_mtd
    FROM public.repayment_schedule, params p
    WHERE demand_date > p.period_end
      AND demand_date <= p.mtd_cutoff
    GROUP BY loan_id
),

jlg_mtd_collection AS (
    SELECT loan_id, sum(amount_collected) AS collection_mtd
    FROM public.repayment_detail, params p
    WHERE status = 'A'
      AND collection_date_time::date > p.period_end
      AND collection_date_time::date <= p.mtd_cutoff
    GROUP BY loan_id
),

jlg_pmsd_demand AS (
    SELECT loan_id, sum(total_amt_due) AS demand_pmsd
    FROM public.repayment_schedule, params p
    WHERE demand_date >= p.prev_month_start
      AND demand_date <= p.pmsd_cutoff
    GROUP BY loan_id
),

jlg_pmsd_collection AS (
    SELECT loan_id, sum(amount_collected) AS collection_pmsd
    FROM public.repayment_detail, params p
    WHERE status = 'A'
      AND collection_date_time::date >= p.prev_month_start
      AND collection_date_time::date <= p.pmsd_cutoff
    GROUP BY loan_id
),

jlg_loan_ce AS (
    SELECT
        'JLG' AS loan_source,
        la.loan_id,
        cm.branch_id,
        cm.assigned_to::varchar AS lo_id,
        coalesce(md.demand_mtd, 0)                                  AS demand_mtd,
        least(
            coalesce(mc.collection_mtd, 0) + coalesce(oa.opening_advance, 0),
            coalesce(md.demand_mtd, 0)
        )                                                           AS collection_mtd,
        coalesce(pd.demand_pmsd, 0)                                 AS demand_pmsd,
        coalesce(pc.collection_pmsd, 0)                             AS collection_pmsd
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN jlg_opening_advance oa ON oa.loan_id = la.loan_id
    LEFT JOIN jlg_mtd_demand      md ON md.loan_id = la.loan_id
    LEFT JOIN jlg_mtd_collection  mc ON mc.loan_id = la.loan_id
    LEFT JOIN jlg_pmsd_demand     pd ON pd.loan_id = la.loan_id
    LEFT JOIN jlg_pmsd_collection pc ON pc.loan_id = la.loan_id
    WHERE la.status NOT IN ('X', 'R')
),

all_ce AS (
    SELECT * FROM il_loan_ce
    UNION ALL
    SELECT * FROM jlg_loan_ce
)

-- ─────────────────────────────────────────────────────────────────────────────
-- FINAL
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    ac.loan_source,
    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    ac.branch_id,
    coalesce(ac.lo_id, 'N/A')             AS lo_id,

    count(distinct ac.loan_id)             AS total_loans,

    -- MTD metrics
    round(sum(ac.demand_mtd)::numeric,      2) AS total_demand,
    round(sum(ac.collection_mtd)::numeric,  2) AS total_collection,
    CASE WHEN sum(ac.demand_mtd) = 0 THEN null
         ELSE round((sum(ac.collection_mtd)*100.0/sum(ac.demand_mtd))::numeric,2)
    END                                        AS ce_pct,
    round((sum(ac.demand_mtd)-sum(ac.collection_mtd))::numeric,2) AS shortfall,

    -- PMSD metrics (PBI "Collection PMSD" / "Demand calc")
    round(sum(ac.demand_pmsd)::numeric,     2) AS demand_pmsd,
    round(sum(ac.collection_pmsd)::numeric, 2) AS collection_pmsd,
    CASE WHEN sum(ac.demand_pmsd) = 0 THEN null
         ELSE round((sum(ac.collection_pmsd)*100.0/sum(ac.demand_pmsd))::numeric,2)
    END                                        AS ce_pct_pmsd,

    -- Context
    (SELECT period_end  FROM params) AS period_end,
    (SELECT mtd_cutoff  FROM params) AS mtd_cutoff,
    (SELECT pmsd_cutoff FROM params) AS pmsd_cutoff

FROM all_ce ac
LEFT JOIN hierarchy h ON ac.branch_id = h.branch_id
GROUP BY
    ac.loan_source,
    h.cluster_name, h.region_name, h.area_name, h.branch_name,
    ac.branch_id, ac.lo_id
ORDER BY
    ac.loan_source,
    h.cluster_name, h.region_name, h.area_name, h.branch_name, ac.lo_id;
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  