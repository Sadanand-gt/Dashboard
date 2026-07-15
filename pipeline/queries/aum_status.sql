-- =============================================================================
-- Report  : Current Status (AUM)
-- DPD     : Computed EOM DPD (end of previous month)
--           cumulative_principal_due / cumulative_interest_due from stored cols.
--           pre_dpd = DPD as of prev_prev_month_end (for OD movement direction).
-- Dedup   : Cross-listed loan_id → IL is primary if IL disburse > JLG disburse
-- LAP     : product_id LIKE '%SUGAM%' OR '%UDYOGINI%' OR '%SECURED%'
-- prod_class: uses product_classification.product_class_id
-- =============================================================================

WITH

ref AS (
    SELECT
        (date_trunc('month', current_date) - interval '1 day')::date                        AS prev_month_end,
        date_trunc('month', current_date)::date                                              AS curr_month_start,
        (date_trunc('month', current_date - interval '1 month') - interval '1 day')::date   AS prev_prev_month_end,
        date_trunc('month', current_date - interval '1 month')::date                        AS prev_month_start
),

-- ─────────────────────────────────────────────────────────────────────────────
-- BRANCH HIERARCHY — Zone → Cluster → Region → Unit → Branch
-- ─────────────────────────────────────────────────────────────────────────────
hierarchy AS (
    SELECT
        bm.branch_id,
        bm.branch_name,
        a.area_id,
        a.area_name,
        reg.branch_id   AS region_id,
        reg.branch_name AS region_name,
        clus.area_id    AS cluster_id,
        clus.area_name  AS cluster_name,
        z.area_id       AS zone_id,
        z.area_name     AS zone_name,
        bm.state_id,
        bm.district_id
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
    LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id
    WHERE bm.active       = 'Y'
      AND bm.is_region    = 'N'
      AND bm.branch_name <> 'DEMO'
      AND bm.closing_date IS NULL
),

-- ═════════════════════════════════════════════════════════════════════════════
-- CURRENT DPD — EOM as of prev_month_end
-- ═════════════════════════════════════════════════════════════════════════════

-- IL — collections before current month start
il_rd AS (
    SELECT loan_id, principal_collected, interest_collected
    FROM public.repayment_detail_il
    WHERE collection_date_time < (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
),

-- IL — OD per demand_date
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
    LEFT JOIN il_rd rd ON rd.loan_id = rs.loan_id
    WHERE (
        (la.status = 'W' AND la.closure_date::date > DATE '2025-03-30')
        OR (la.closure_type = 'W'
            AND la.last_collection_date::date > (SELECT prev_month_end FROM ref))
        OR la.status IN ('D', 'I')
        OR (
            (la.closure_date IS NULL
             OR la.closure_date::date > (SELECT prev_month_end FROM ref))
            AND rs.demand_date::date <= (SELECT prev_month_end FROM ref)
        )
    )
    GROUP BY rs.loan_id, rs.demand_date, rs.cumulative_principal_due, rs.cumulative_interest_due
),

-- IL — DPD per loan (EOM)
il_dpd AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL                                         THEN 0
            WHEN min(demand_date)::date > (SELECT prev_month_end FROM ref)        THEN 0
            ELSE ((SELECT prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS dpd
    FROM il_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- JLG — collections before current month start (use collection_date for JLG)
jlg_rd AS (
    SELECT loan_id, principal_collected, interest_collected
    FROM public.repayment_detail
    WHERE collection_date::date < (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
),

-- JLG — OD per demand_date (repayment_schedule has stored cumulative columns)
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
    JOIN public.repayment_schedule rs ON rs.loan_id = la.loan_id
    LEFT JOIN jlg_rd rd ON rd.loan_id = rs.loan_id
    WHERE (
        (la.status = 'W' AND la.closure_date::date > DATE '2025-03-30')
        OR (la.closure_type = 'W'
            AND la.last_collection_date::date > (SELECT prev_month_end FROM ref))
        OR la.status IN ('D', 'I')
        OR (
            (la.closure_date IS NULL
             OR la.closure_date::date > (SELECT prev_month_end FROM ref))
            AND rs.demand_date::date <= (SELECT prev_month_end FROM ref)
        )
    )
    GROUP BY rs.loan_id, rs.demand_date, rs.cumulative_principal_due, rs.cumulative_interest_due
),

-- JLG — DPD per loan (EOM)
jlg_dpd AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL                                         THEN 0
            WHEN min(demand_date)::date > (SELECT prev_month_end FROM ref)        THEN 0
            ELSE ((SELECT prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS dpd
    FROM jlg_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PRE-PERIOD DPD — as of prev_prev_month_end (for bucket movement direction)
-- ═════════════════════════════════════════════════════════════════════════════

-- IL pre-period collections (before 2 months ago start)
il_pre_rd AS (
    SELECT loan_id,
           sum(principal_collected) AS cum_collected,
           sum(interest_collected)  AS cum_interest_collected
    FROM public.repayment_detail_il
    WHERE collection_date_time < (SELECT prev_month_start FROM ref)
      AND status IN ('A', 'V')
    GROUP BY loan_id
),

-- IL — OD per demand_date as of prev_prev_month_end
il_pre_ars AS (
    SELECT
        rs.loan_id,
        rs.demand_date,
        CASE
            WHEN rd.cum_collected IS NULL
                THEN rs.cumulative_principal_due
            WHEN rd.cum_collected < rs.cumulative_principal_due
                THEN rs.cumulative_principal_due - rd.cum_collected
            ELSE 0
        END AS od_principal,
        CASE
            WHEN rd.cum_interest_collected IS NULL
                THEN rs.cumulative_interest_due
            WHEN rd.cum_interest_collected < rs.cumulative_interest_due
                THEN rs.cumulative_interest_due - rd.cum_interest_collected
            ELSE 0
        END AS od_interest
    FROM public.repayment_schedule_il rs
    LEFT JOIN il_pre_rd rd ON rd.loan_id = rs.loan_id
    WHERE rs.demand_date::date <= (SELECT prev_prev_month_end FROM ref)
),

-- IL — pre_dpd per loan
il_pre AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL                                              THEN 0
            WHEN min(demand_date)::date > (SELECT prev_prev_month_end FROM ref)        THEN 0
            ELSE ((SELECT prev_prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS pre_dpd
    FROM il_pre_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- JLG pre-period collections (before 2 months ago start)
jlg_pre_rd AS (
    SELECT loan_id,
           sum(principal_collected) AS cum_collected,
           sum(interest_collected)  AS cum_interest_collected
    FROM public.repayment_detail
    WHERE collection_date::date < (SELECT prev_month_start FROM ref)
      AND status IN ('A', 'V')
    GROUP BY loan_id
),

-- JLG — OD per demand_date as of prev_prev_month_end
jlg_pre_ars AS (
    SELECT
        rs.loan_id,
        rs.demand_date,
        CASE
            WHEN rd.cum_collected IS NULL
                THEN rs.cumulative_principal_due
            WHEN rd.cum_collected < rs.cumulative_principal_due
                THEN rs.cumulative_principal_due - rd.cum_collected
            ELSE 0
        END AS od_principal,
        CASE
            WHEN rd.cum_interest_collected IS NULL
                THEN rs.cumulative_interest_due
            WHEN rd.cum_interest_collected < rs.cumulative_interest_due
                THEN rs.cumulative_interest_due - rd.cum_interest_collected
            ELSE 0
        END AS od_interest
    FROM public.repayment_schedule rs
    LEFT JOIN jlg_pre_rd rd ON rd.loan_id = rs.loan_id
    WHERE rs.demand_date::date <= (SELECT prev_prev_month_end FROM ref)
),

-- JLG — pre_dpd per loan
jlg_pre AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL                                              THEN 0
            WHEN min(demand_date)::date > (SELECT prev_prev_month_end FROM ref)        THEN 0
            ELSE ((SELECT prev_prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS pre_dpd
    FROM jlg_pre_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- ─────────────────────────────────────────────────────────────────────────────
-- PRODUCT CLASSIFICATION LOOKUP (for AP filter / group-by)
-- ─────────────────────────────────────────────────────────────────────────────
il_prod_class AS (
    SELECT lp.product_id,
           coalesce(pc.product_classification, 'Other') AS prod_classification
    FROM public.loan_product_il lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),

jlg_prod_class AS (
    SELECT lp.product_id,
           coalesce(pc.product_classification, 'Other') AS prod_classification
    FROM public.loan_product lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),

-- ─────────────────────────────────────────────────────────────────────────────
-- DEMOGRAPHIC & FACILITY MAPPING — purpose_id, facility_id, lender_id, caste, religion
-- One row per loan (DISTINCT ON guards against multi-row joins)
-- ─────────────────────────────────────────────────────────────────────────────
il_extra AS (
    SELECT DISTINCT ON (la.loan_id)
        la.loan_id,
        coalesce(la.purpose_id::text,  'N/A') AS purpose_id,
        coalesce(la.facility_id::text, 'N/A') AS facility_id,
        coalesce(la.lender_id::text,   'N/A') AS lender_id,
        coalesce(cci.caste,            'N/A') AS caste,
        coalesce(cci.religion,         'N/A') AS religion
    FROM public.loan_account_il la
    LEFT JOIN public.customer_contacts_il cci ON cci.loan_id = la.loan_id
    WHERE la.status IN ('A','D','I','W')
    ORDER BY la.loan_id
),

jlg_extra AS (
    SELECT DISTINCT ON (hla.loan_id)
        hla.loan_id,
        coalesce(hla.purpose_id::text,  'N/A') AS purpose_id,
        coalesce(hla.facility_id::text, 'N/A') AS facility_id,
        'N/A'::text                             AS lender_id,
        coalesce(hbm.caste,             'N/A') AS caste,
        coalesce(hbm.religion,          'N/A') AS religion
    FROM public.home_loan_account hla
    LEFT JOIN public.home_brrwr_misc hbm ON hbm.cust_id = hla.cust_id
    WHERE hla.status IN ('A','D','I','W')
    ORDER BY hla.loan_id
),

-- ═════════════════════════════════════════════════════════════════════════════
-- LOAN LISTS — status IN ('A','D','I','W') only 
-- dpd     = live la.dpd column (for dpd_bucket, PAR amounts)
-- eom_dpd = computed EOM DPD (for od_movement_status / bucket_movement only)
-- pre_dpd = computed M-2 EOM DPD (movement direction)
-- raw_status = 'W' if loan_id in writeoff_master OR db status = 'W' (no extra loans added)
-- ═════════════════════════════════════════════════════════════════════════════

il_loans AS (
    SELECT
        'IL'                                                    AS loan_source,
        CASE
            WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
              OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
            THEN 'LAP'
            ELSE 'IEL'
        END                                                     AS business_segment,
        la.loan_id,
        la.branch_id,
        la.loan_officer                                         AS lo_id,
        la.product_id::text                                     AS product_id,
        la.principal_outstanding                                AS pos,
        la.total_loan_amount                                    AS sanctioned_amount,
        la.disbursement_date,
        la.first_demand_date,
        la.last_demand_date,
        la.last_collection_date,
        coalesce(la.dpd, 0)                                     AS dpd,
        coalesce(d.dpd, 0)                                      AS eom_dpd,
        coalesce(p.pre_dpd, 0)                                  AS pre_dpd,
        coalesce(la.principal_arrear, 0) + coalesce(la.interest_arrear, 0) AS total_arrear,
        CASE WHEN la.loan_id IN ({wo_ids}) OR la.status = 'W'
             THEN 'W' ELSE la.status END                        AS raw_status,
        coalesce(la.cycle::text, 'N/A')                         AS cycle_no,
        extract(year FROM la.disbursement_date)::text           AS disb_year,
        coalesce(ipc.prod_classification, 'Other')              AS prod_classification,
        coalesce(ex.purpose_id,          'N/A')               AS purpose_id,
        coalesce(ex.facility_id,         'N/A')               AS facility_id,
        coalesce(ex.lender_id,           'N/A')               AS lender_id,
        coalesce(ex.caste,               'N/A')               AS caste,
        coalesce(ex.religion,            'N/A')               AS religion
    FROM public.loan_account_il la
    LEFT JOIN il_dpd        d   ON d.loan_id      = la.loan_id
    LEFT JOIN il_pre        p   ON p.loan_id      = la.loan_id
    LEFT JOIN il_prod_class ipc ON ipc.product_id = la.product_id::text
    LEFT JOIN il_extra      ex  ON ex.loan_id     = la.loan_id
    WHERE la.status IN ('A', 'D', 'I', 'W')
),

jlg_loans AS (
    SELECT
        'JLG'                                                   AS loan_source,
        'JLG'                                                   AS business_segment,
        la.loan_id,
        cm.branch_id,
        cm.assigned_to::varchar                                 AS lo_id,
        la.product_id::text                                     AS product_id,
        la.prin_os                                              AS pos,
        la.total_loan_amount                                    AS sanctioned_amount,
        la.disbursement_date,
        la.first_demand_date,
        la.last_demand_date,
        la.last_collection_date,
        coalesce(la.dpd, 0)                                     AS dpd,
        coalesce(d.dpd, 0)                                      AS eom_dpd,
        coalesce(p.pre_dpd, 0)                                  AS pre_dpd,
        coalesce(la.principal_arrear, 0) + coalesce(la.interest_arrear, 0) AS total_arrear,
        CASE WHEN la.loan_id IN ({wo_ids}) OR la.status = 'W'
             THEN 'W' ELSE la.status END                        AS raw_status,
        coalesce(la.cycle::text, 'N/A')                         AS cycle_no,
        extract(year FROM la.disbursement_date)::text           AS disb_year,
        coalesce(jpc.prod_classification, 'Other')              AS prod_classification,
        coalesce(ex.purpose_id,           'N/A')              AS purpose_id,
        coalesce(ex.facility_id,          'N/A')              AS facility_id,
        coalesce(ex.lender_id,            'N/A')              AS lender_id,
        coalesce(ex.caste,                'N/A')              AS caste,
        coalesce(ex.religion,             'N/A')              AS religion
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN jlg_dpd        d   ON d.loan_id      = la.loan_id
    LEFT JOIN jlg_pre        p   ON p.loan_id      = la.loan_id
    LEFT JOIN jlg_prod_class jpc ON jpc.product_id = la.product_id::text
    LEFT JOIN jlg_extra      ex  ON ex.loan_id     = la.loan_id
    WHERE la.status IN ('A', 'D', 'I', 'W')
      AND (la.status != 'W' OR la.prin_os > 0)
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id           = la.loan_id
            AND il.status            IN ('A', 'D', 'I', 'W')
            AND il.disbursement_date > la.disbursement_date
      )
),

all_loans AS (
    SELECT * FROM il_loans
    UNION ALL
    SELECT * FROM jlg_loans
),

-- ─────────────────────────────────────────────────────────────────────────────
-- BUCKET ASSIGNMENT + OD STATUS
-- ─────────────────────────────────────────────────────────────────────────────
bucketed AS (
    SELECT al.*,
        CASE
            WHEN al.raw_status = 'W'                THEN 'Write-off'
            WHEN al.dpd = 0                         THEN 'Regular'
            WHEN al.dpd <= 90                       THEN 'Overdue'
            ELSE                                         'NPA'
        END AS curr_od_status,
        CASE
            WHEN al.raw_status = 'W'                THEN 'Write-Off'
            WHEN al.dpd = 0                         THEN 'Regular'
            WHEN al.dpd BETWEEN   1 AND  30         THEN '1 - 30'
            WHEN al.dpd BETWEEN  31 AND  60         THEN '31 - 60'
            WHEN al.dpd BETWEEN  61 AND  90         THEN '61 - 90'
            WHEN al.dpd BETWEEN  91 AND 180         THEN '91 - 180'
            WHEN al.dpd BETWEEN 181 AND 360         THEN '181 - 360'
            ELSE                                         '360 +'
        END AS dpd_bucket,
        -- Previous-month bucket (pure EOM DPD, no W override) — for Bucket Movement
        CASE
            WHEN al.eom_dpd = 0                     THEN 'Regular'
            WHEN al.eom_dpd BETWEEN   1 AND  30     THEN '1 - 30'
            WHEN al.eom_dpd BETWEEN  31 AND  60     THEN '31 - 60'
            WHEN al.eom_dpd BETWEEN  61 AND  90     THEN '61 - 90'
            WHEN al.eom_dpd BETWEEN  91 AND 180     THEN '91 - 180'
            WHEN al.eom_dpd BETWEEN 181 AND 360     THEN '181 - 360'
            ELSE                                         '360 +'
        END AS prev_dpd_bucket,
        -- Current bucket by LIVE DPD, pure (no W override) — Bucket Movement puts
        -- write-off loans in their real DPD bucket (e.g. 181-360, 360+)
        CASE
            WHEN al.dpd = 0                         THEN 'Regular'
            WHEN al.dpd BETWEEN   1 AND  30         THEN '1 - 30'
            WHEN al.dpd BETWEEN  31 AND  60         THEN '31 - 60'
            WHEN al.dpd BETWEEN  61 AND  90         THEN '61 - 90'
            WHEN al.dpd BETWEEN  91 AND 180         THEN '91 - 180'
            WHEN al.dpd BETWEEN 181 AND 360         THEN '181 - 360'
            ELSE                                         '360 +'
        END AS curr_dpd_bucket,
        CASE
            WHEN al.raw_status = 'W'                     THEN 'Write-Off'
            WHEN al.eom_dpd = 0 AND al.pre_dpd = 0      THEN 'Not OD'
            WHEN al.eom_dpd > 0 AND al.pre_dpd = 0      THEN 'OD Slippage'
            WHEN al.eom_dpd = 0 AND al.pre_dpd > 0      THEN 'Regularised'
            ELSE                                              'Continuing'
        END AS od_movement_status,
        CASE
            WHEN al.raw_status = 'W'                     THEN 'N/A'
            WHEN al.eom_dpd = al.pre_dpd                THEN 'Static'
            WHEN al.eom_dpd < al.pre_dpd                THEN 'Improved'
            ELSE                                              'Worsened'
        END AS bucket_movement,
        CASE WHEN al.dpd >= 1                       THEN al.pos ELSE 0 END AS par0_pos,
        CASE WHEN al.dpd > 30                       THEN al.pos ELSE 0 END AS par30_pos,
        CASE WHEN al.dpd > 60                       THEN al.pos ELSE 0 END AS par60_pos,
        CASE WHEN al.dpd > 90                       THEN al.pos ELSE 0 END AS par90_pos,
        CASE WHEN al.raw_status = 'W'               THEN al.pos ELSE 0 END AS writeoff_pos
    FROM all_loans al
)

-- ─────────────────────────────────────────────────────────────────────────────
-- FINAL AGGREGATION
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    current_date                                    AS as_of_date,
    b.loan_source,
    b.business_segment,
    b.curr_od_status,
    CASE b.raw_status
        WHEN 'A' THEN 'Active'
        WHEN 'D' THEN 'Death' WHEN 'I' THEN 'Death'
        WHEN 'W' THEN 'Write-off'
        ELSE b.raw_status
    END                                             AS loan_status,
    b.dpd_bucket,
    b.prev_dpd_bucket,
    b.curr_dpd_bucket,
    b.od_movement_status,
    b.bucket_movement,
    coalesce(h.zone_name,    'Unassigned')          AS zone_name,
    coalesce(h.cluster_name, 'Unassigned')          AS cluster_name,
    coalesce(h.region_name,  'Unassigned')          AS region_name,
    coalesce(h.area_name,    'Unassigned')          AS area_name,
    coalesce(h.branch_name,  'Unassigned')          AS branch_name,
    b.branch_id,
    coalesce(b.lo_id,              'N/A')            AS lo_id,
    coalesce(b.prod_classification,'Other')         AS prod_classification,
    coalesce(h.state_id::text,   'N/A')             AS state_id,
    coalesce(h.district_id::text,'N/A')             AS district_id,
    coalesce(b.cycle_no,         'N/A')             AS cycle_no,
    coalesce(b.disb_year,        'N/A')             AS disb_year,
    coalesce(b.purpose_id,       'N/A')             AS purpose_id,
    coalesce(b.facility_id,      'N/A')             AS facility_id,
    coalesce(b.lender_id,        'N/A')             AS lender_id,
    coalesce(b.caste,            'N/A')             AS caste,
    coalesce(b.religion,         'N/A')             AS religion,
    (SELECT prev_month_end FROM ref)                AS dpd_as_of,

    count(b.loan_id)                                AS loan_count,
    round(sum(b.pos)::numeric,              2)      AS total_pos,
    round(sum(b.sanctioned_amount)::numeric, 2)     AS total_sanctioned,
    round(sum(b.total_arrear)::numeric,     2)      AS total_arrear,
    round(sum(b.par0_pos)::numeric,  2)             AS par0_pos,
    round(sum(b.par30_pos)::numeric, 2)             AS par30_pos,
    round(sum(b.par60_pos)::numeric, 2)             AS par60_pos,
    round(sum(b.par90_pos)::numeric, 2)             AS par90_pos,
    round(sum(b.writeoff_pos)::numeric, 2)          AS writeoff_pos

FROM bucketed b
LEFT JOIN hierarchy h ON b.branch_id = h.branch_id
GROUP BY
    b.loan_source, b.business_segment, b.curr_od_status,
    b.raw_status, b.dpd_bucket, b.prev_dpd_bucket, b.curr_dpd_bucket, b.od_movement_status, b.bucket_movement,
    h.zone_name, h.cluster_name, h.region_name, h.area_name, h.branch_name,
    b.branch_id, b.lo_id, b.prod_classification,
    h.state_id, h.district_id,
    b.cycle_no, b.disb_year,
    b.purpose_id, b.facility_id, b.lender_id, b.caste, b.religion
ORDER BY
    b.business_segment, b.dpd_bucket,
    h.zone_name, h.cluster_name, h.region_name, h.area_name, h.branch_name;
