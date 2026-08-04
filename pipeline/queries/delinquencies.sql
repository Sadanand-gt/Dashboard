-- =============================================================================
-- Report  : Delinquencies
-- PBI File: DELIIQUENCIES ANANYA.pbit
-- Logic   : Tracks OD borrower movement between months using two DPD snapshots:
--           prev_month_dpd = EOM computed DPD (from repayment_schedule, same as aum_status)
--           current_dpd    = live la.dpd column from core banking
--
-- Key sections:
--   1. 0-30 OD Borrowers from previous month-end:
--        Regularized  = prev_dpd 1-30, current_dpd = 0 (or closed)
--        Partial Paid = prev_dpd 1-30, current_dpd > 0, had collection this month
--        Not Paid     = prev_dpd 1-30, current_dpd > 0, no collection this month
--        Fresh Slip   = prev_dpd = 0, current_dpd > 0 (slipped into OD this month)
--   2. PAR > 30 at previous month-end:
--        paid_1_inst  = prev_dpd > 30, had any collection in current month
--        regularized  = prev_dpd > 30, current_dpd = 0
--   3. PAR 0+ / 30+ counts & amounts (current live DPD)
--   4. Members with no payment yesterday
-- Tables  : loan_account_il, home_loan_account,
--           repayment_schedule_il, repayment_detail_il,
--           repayment_schedule, repayment_detail,
--           brnch_master, area_master, home_center_master
-- =============================================================================

WITH

-- Write-off MASTER (loan_id, wo_date). Overrides a loan's STATUS to 'W' when the
-- master applies (loan existed at write-off). Universe is unchanged — only the
-- displayed status changes, so the Excl-W/O view (loan_status <> 'Write-off')
-- matches Excel + Current Outstanding. PAR / movement math is untouched.
wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date
    FROM (VALUES {wo_pairs}) AS v(loan_id, wo_date)
),

ref AS (
    SELECT
        (date_trunc('month', current_date - 1) - interval '1 day')::date AS prev_month_end,
        date_trunc('month', current_date - 1)::date                       AS curr_month_start,
        (current_date - interval '1 day')::date                       AS yesterday
),

hierarchy AS (
    SELECT
        bm.branch_id,
        bm.branch_name,
        a.area_name,
        reg.branch_name  AS region_name,
        clus.area_name   AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON a.area_id    = bm.area_id
    LEFT JOIN public.brnch_master reg  ON reg.branch_id = a.region_id
    LEFT JOIN public.area_master  clus ON clus.area_id  = reg.area_id
    WHERE bm.active = 'Y'
      AND bm.is_region = 'N'
      AND bm.branch_name <> 'DEMO'
),

-- =========================================================
-- EOM COMPUTED DPD -- IL
-- =========================================================
il_rd_eom AS (
    SELECT loan_id, principal_collected, interest_collected
    FROM public.repayment_detail_il
    WHERE collection_date_time < (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
),

il_ars AS (
    SELECT
        rs.loan_id,
        rs.demand_date,
        CASE
            WHEN sum(rd.principal_collected) IS NULL
                THEN rs.cumulative_principal_due
            WHEN sum(rd.principal_collected) < rs.cumulative_principal_due
                THEN rs.cumulative_principal_due - sum(rd.principal_collected)
            ELSE 0
        END AS od_principal,
        CASE
            WHEN sum(rd.interest_collected) IS NULL
                THEN rs.cumulative_interest_due
            WHEN sum(rd.interest_collected) < rs.cumulative_interest_due
                THEN rs.cumulative_interest_due - sum(rd.interest_collected)
            ELSE 0
        END AS od_interest
    FROM public.loan_account_il la
    JOIN public.repayment_schedule_il rs ON rs.loan_id = la.loan_id
    LEFT JOIN il_rd_eom rd ON rd.loan_id = rs.loan_id
    WHERE (
        (la.status = 'W' AND la.closure_date > DATE '2025-03-30')
        -- ::date on the anchor compares: IL closure/collection dates are TIMESTAMPs
        -- with a real time-of-day, prev_month_end is a DATE. Uncast, a loan closed at
        -- 17:14 ON the month-end is wrongly held open. (JLG is always 00:00:00.)
        OR (la.closure_type = 'W' AND la.last_collection_date::date > (SELECT prev_month_end FROM ref))
        OR la.status IN ('D', 'I')
        OR (
            (la.closure_date IS NULL OR la.closure_date::date > (SELECT prev_month_end FROM ref))
            AND rs.demand_date::date <= (SELECT prev_month_end FROM ref)
        )
    )
    GROUP BY rs.loan_id, rs.demand_date, rs.cumulative_principal_due, rs.cumulative_interest_due
),

il_dpd_eom AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL THEN 0
            WHEN min(demand_date) > (SELECT prev_month_end FROM ref) THEN 0
            ELSE ((SELECT prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS dpd_eom
    FROM il_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- =========================================================
-- EOM COMPUTED DPD -- JLG
-- =========================================================
jlg_rd_eom AS (
    SELECT loan_id, principal_collected, interest_collected
    FROM public.repayment_detail
    WHERE collection_date < (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
),

-- repayment_schedule (JLG) has no cumulative columns; compute via window function
jlg_sched_cum AS (
    SELECT loan_id, demand_date,
           SUM(principal_due) OVER (PARTITION BY loan_id ORDER BY demand_date
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_principal_due,
           SUM(interest_due)  OVER (PARTITION BY loan_id ORDER BY demand_date
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_interest_due
    FROM public.repayment_schedule
    WHERE demand_date::date <= (SELECT prev_month_end FROM ref)
),

jlg_ars AS (
    SELECT
        rs.loan_id,
        rs.demand_date,
        CASE
            WHEN sum(rd.principal_collected) IS NULL
                THEN rs.cumulative_principal_due
            WHEN sum(rd.principal_collected) < rs.cumulative_principal_due
                THEN rs.cumulative_principal_due - sum(rd.principal_collected)
            ELSE 0
        END AS od_principal,
        CASE
            WHEN sum(rd.interest_collected) IS NULL
                THEN rs.cumulative_interest_due
            WHEN sum(rd.interest_collected) < rs.cumulative_interest_due
                THEN rs.cumulative_interest_due - sum(rd.interest_collected)
            ELSE 0
        END AS od_interest
    FROM public.home_loan_account la
    JOIN jlg_sched_cum rs ON rs.loan_id = la.loan_id
    LEFT JOIN jlg_rd_eom rd ON rd.loan_id = rs.loan_id
    WHERE (
        (la.status = 'W' AND la.closure_date > DATE '2025-03-30')
        -- ::date on the anchor compares — see the IL block above.
        OR (la.closure_type = 'W' AND la.last_collection_date::date > (SELECT prev_month_end FROM ref))
        OR la.status IN ('D', 'I')
        OR (la.closure_date IS NULL OR la.closure_date::date > (SELECT prev_month_end FROM ref))
    )
    GROUP BY rs.loan_id, rs.demand_date, rs.cumulative_principal_due, rs.cumulative_interest_due
),

jlg_dpd_eom AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL THEN 0
            WHEN min(demand_date) > (SELECT prev_month_end FROM ref) THEN 0
            ELSE ((SELECT prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS dpd_eom
    FROM jlg_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- =========================================================
-- CURRENT MONTH COLLECTIONS (to determine "paid this month")
-- =========================================================
il_coll_this_month AS (
    SELECT DISTINCT loan_id
    FROM public.repayment_detail_il
    WHERE collection_date_time >= (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
),

jlg_coll_this_month AS (
    SELECT DISTINCT loan_id
    FROM public.repayment_detail
    WHERE collection_date >= (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
),

-- =========================================================
-- YESTERDAY DEMAND (for members_no_pay)
-- Loans with demand_date = yesterday in repayment_schedule
-- =========================================================
il_demand_yesterday AS (
    SELECT DISTINCT loan_id
    FROM public.repayment_schedule_il
    WHERE demand_date = (SELECT yesterday FROM ref)
),

jlg_demand_yesterday AS (
    SELECT DISTINCT loan_id
    FROM public.repayment_schedule
    WHERE demand_date = (SELECT yesterday FROM ref)
),

-- Yesterday collections
il_coll_yesterday AS (
    SELECT DISTINCT loan_id
    FROM public.repayment_detail_il
    WHERE collection_date_time::date = (SELECT yesterday FROM ref)
      AND status IN ('A', 'V')
),

jlg_coll_yesterday AS (
    SELECT DISTINCT loan_id
    FROM public.repayment_detail
    WHERE collection_date = (SELECT yesterday FROM ref)
      AND status IN ('A', 'V')
),

-- =========================================================
-- IL LOAN UNIVERSE with all flags
-- =========================================================
il_loans AS (
    SELECT
        CASE
            WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
            THEN 'LAP'
            ELSE 'IEL'
        END                                    AS loan_source,
        la.loan_id,
        la.branch_id,
        la.loan_officer::varchar                                          AS lo_id,
        la.principal_outstanding                                          AS pos,
        coalesce(la.dpd, 0)                                               AS current_dpd,
        coalesce(d.dpd_eom, 0)                                            AS prev_month_dpd,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END                                  AS status,
        CASE WHEN la.status = 'D' THEN 1 ELSE 0 END                      AS is_death,
        -- PAR flags (live DPD)
        CASE WHEN coalesce(la.dpd,0) > 0  THEN 1 ELSE 0 END              AS is_par0,
        CASE WHEN coalesce(la.dpd,0) > 30 THEN 1 ELSE 0 END              AS is_par30,
        -- 0-30 OD movement flags
        CASE WHEN coalesce(d.dpd_eom,0) BETWEEN 1 AND 30 THEN 1 ELSE 0 END  AS was_od030,
        CASE WHEN coalesce(d.dpd_eom,0) > 30             THEN 1 ELSE 0 END  AS was_par30,
        CASE WHEN coalesce(d.dpd_eom,0) = 0
              AND coalesce(la.dpd,0) > 0                 THEN 1 ELSE 0 END  AS fresh_slip,
        -- had collection this month?
        CASE WHEN cm.loan_id IS NOT NULL                 THEN 1 ELSE 0 END  AS paid_this_month,
        -- no pay yesterday?
        CASE WHEN dy.loan_id IS NOT NULL
              AND cy.loan_id IS NULL                      THEN 1 ELSE 0 END  AS no_pay_yesterday
    FROM public.loan_account_il la
    LEFT JOIN wo_master w            ON w.loan_id  = la.loan_id
    LEFT JOIN il_dpd_eom d           ON d.loan_id  = la.loan_id
    LEFT JOIN il_coll_this_month cm  ON cm.loan_id = la.loan_id
    LEFT JOIN il_demand_yesterday dy ON dy.loan_id = la.loan_id
    LEFT JOIN il_coll_yesterday cy   ON cy.loan_id = la.loan_id
    WHERE la.status IN ('A', 'D', 'I', 'W')
),

-- =========================================================
-- JLG LOAN UNIVERSE with all flags
-- =========================================================
jlg_loans AS (
    SELECT
        'JLG'                                                             AS loan_source,
        la.loan_id,
        cm_br.branch_id,
        cm_br.assigned_to::varchar                                        AS lo_id,
        la.prin_os                                                        AS pos,
        coalesce(la.dpd, 0)                                               AS current_dpd,
        coalesce(d.dpd_eom, 0)                                            AS prev_month_dpd,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END                                  AS status,
        CASE WHEN la.status = 'D' THEN 1 ELSE 0 END                      AS is_death,
        CASE WHEN coalesce(la.dpd,0) > 0  THEN 1 ELSE 0 END              AS is_par0,
        CASE WHEN coalesce(la.dpd,0) > 30 THEN 1 ELSE 0 END              AS is_par30,
        CASE WHEN coalesce(d.dpd_eom,0) BETWEEN 1 AND 30 THEN 1 ELSE 0 END  AS was_od030,
        CASE WHEN coalesce(d.dpd_eom,0) > 30             THEN 1 ELSE 0 END  AS was_par30,
        CASE WHEN coalesce(d.dpd_eom,0) = 0
              AND coalesce(la.dpd,0) > 0                 THEN 1 ELSE 0 END  AS fresh_slip,
        CASE WHEN cm2.loan_id IS NOT NULL                THEN 1 ELSE 0 END  AS paid_this_month,
        CASE WHEN dy.loan_id IS NOT NULL
              AND cy.loan_id IS NULL                      THEN 1 ELSE 0 END  AS no_pay_yesterday
    FROM public.home_loan_account la
    JOIN public.home_center_master cm_br ON cm_br.center_id = la.center_id
    LEFT JOIN wo_master w                 ON w.loan_id   = la.loan_id
    LEFT JOIN jlg_dpd_eom d               ON d.loan_id   = la.loan_id
    LEFT JOIN jlg_coll_this_month cm2     ON cm2.loan_id = la.loan_id
    LEFT JOIN jlg_demand_yesterday dy     ON dy.loan_id  = la.loan_id
    LEFT JOIN jlg_coll_yesterday cy       ON cy.loan_id  = la.loan_id
    WHERE la.status IN ('A', 'D', 'I', 'W')
      AND la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND (la.status != 'W' OR la.prin_os > 0)
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id           = la.loan_id
            AND il.status            IN ('A','D','I','W')
            AND il.disbursement_date > la.disbursement_date
      )
),

all_loans AS (
    SELECT * FROM il_loans
    UNION ALL
    SELECT * FROM jlg_loans
)

-- =========================================================
-- FINAL AGGREGATION
-- =========================================================
SELECT
    al.loan_source,
    -- Canonical labels (match rpt_aum_status + the loan_status slicer options).
    CASE al.status
        WHEN 'A' THEN 'Active'
        WHEN 'W' THEN 'Write-off'
        WHEN 'D' THEN 'Death'
        WHEN 'I' THEN 'Death'
        ELSE al.status
    END                                                                    AS loan_status,
    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    al.branch_id,
    coalesce(al.lo_id, 'N/A')              AS lo_id,

    count(al.loan_id)                                                      AS total_loans,
    round(sum(al.pos)::numeric, 2)                                         AS total_pos,
    sum(al.is_death)                                                        AS death_cases,

    -- PAR (live DPD)
    sum(al.is_par0)                                                         AS par0_count,
    round(sum(CASE WHEN al.is_par0 = 1 THEN al.pos ELSE 0 END)::numeric,2) AS par0_pos,
    sum(al.is_par30)                                                        AS par30_count,
    round(sum(CASE WHEN al.is_par30 = 1 THEN al.pos ELSE 0 END)::numeric,2) AS par30_pos,

    -- 0-30 OD Borrower Movement (prev month 1-30 DPD)
    sum(al.was_od030)                                                       AS od030_prev_count,
    -- Regularized: was 0-30 OD, now DPD=0
    sum(CASE WHEN al.was_od030 = 1 AND al.current_dpd = 0 THEN 1 ELSE 0 END)
                                                                            AS od030_regularized,
    -- Partial paid: was 0-30 OD, still OD, had collection this month
    sum(CASE WHEN al.was_od030 = 1 AND al.current_dpd > 0
              AND al.paid_this_month = 1 THEN 1 ELSE 0 END)                AS od030_partial_paid,
    -- Not paid: was 0-30 OD, still OD, no collection this month
    sum(CASE WHEN al.was_od030 = 1 AND al.current_dpd > 0
              AND al.paid_this_month = 0 THEN 1 ELSE 0 END)                AS od030_not_paid,

    -- Fresh Slippage: was standard (DPD=0), now overdue
    sum(al.fresh_slip)                                                      AS fresh_slippage,

    -- PAR > 30 Recovery Tracking
    sum(al.was_par30)                                                       AS par30_prev_count,
    -- Regularized: was PAR>30, now DPD=0
    sum(CASE WHEN al.was_par30 = 1 AND al.current_dpd = 0 THEN 1 ELSE 0 END)
                                                                            AS par30_regularized,
    -- Paid at least 1 installment this month
    sum(CASE WHEN al.was_par30 = 1 AND al.paid_this_month = 1 THEN 1 ELSE 0 END)
                                                                            AS par30_paid_1_inst,

    -- Members with no payment yesterday (had demand, no collection)
    sum(al.no_pay_yesterday)                                                AS members_no_pay,

    (SELECT prev_month_end FROM ref)                                        AS dpd_eom_date,
    current_date                                                            AS report_date

FROM all_loans al
LEFT JOIN hierarchy h ON h.branch_id = al.branch_id
GROUP BY
    al.loan_source, al.status, h.cluster_name, h.region_name, h.area_name,
    h.branch_name, al.branch_id, al.lo_id
ORDER BY
    al.loan_source, al.status, h.cluster_name, h.region_name, h.area_name, h.branch_name;
