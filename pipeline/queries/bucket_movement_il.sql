-- bucket_movement_il.sql — IL loans (IEL + LAP) only
WITH
ref AS (
    SELECT
        (date_trunc('month', current_date - 1) - interval '1 day')::date AS prev_month_end,
        date_trunc('month', current_date - 1)::date                       AS curr_month_start
),
hierarchy AS (
    SELECT bm.branch_id, bm.branch_name, a.area_name,
           reg.branch_name AS region_name, clus.area_name AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON a.area_id    = bm.area_id
    LEFT JOIN public.brnch_master reg  ON reg.branch_id = a.region_id
    LEFT JOIN public.area_master  clus ON clus.area_id  = reg.area_id
    WHERE bm.active = 'Y' AND bm.is_region = 'N' AND bm.branch_name <> 'DEMO'
),
il_rd AS (
    SELECT loan_id, principal_collected, interest_collected
    FROM public.repayment_detail_il
    WHERE collection_date_time::date < (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
),
il_ars AS (
    SELECT rs.loan_id, rs.demand_date,
        CASE WHEN sum(rd.principal_collected) IS NULL THEN rs.cumulative_principal_due
             WHEN sum(rd.principal_collected) < rs.cumulative_principal_due
             THEN rs.cumulative_principal_due - sum(rd.principal_collected)
             ELSE 0 END AS od_principal,
        CASE WHEN sum(rd.interest_collected) IS NULL THEN rs.cumulative_interest_due
             WHEN sum(rd.interest_collected) < rs.cumulative_interest_due
             THEN rs.cumulative_interest_due - sum(rd.interest_collected)
             ELSE 0 END AS od_interest
    FROM public.loan_account_il la
    JOIN public.repayment_schedule_il rs ON rs.loan_id = la.loan_id
    LEFT JOIN il_rd rd ON rd.loan_id = rs.loan_id
    WHERE (
        (la.status = 'W' AND la.closure_date::date > DATE '2025-03-30')
        OR (la.closure_type = 'W' AND la.last_collection_date::date > (SELECT prev_month_end FROM ref))
        OR la.status IN ('D', 'I')
        OR ((la.closure_date IS NULL OR la.closure_date::date > (SELECT prev_month_end FROM ref))
            AND rs.demand_date::date <= (SELECT prev_month_end FROM ref))
    )
    GROUP BY rs.loan_id, rs.demand_date, rs.cumulative_principal_due, rs.cumulative_interest_due
),
il_dpd_eom AS (
    SELECT loan_id,
        CASE WHEN min(demand_date) IS NULL THEN 0
             WHEN min(demand_date)::date > (SELECT prev_month_end FROM ref) THEN 0
             ELSE ((SELECT prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS dpd_eom
    FROM il_ars WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),
il_loans AS (
    SELECT
        CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
               OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
             THEN 'LAP' ELSE 'IEL' END AS loan_source,
        la.loan_id, la.branch_id, la.loan_officer::varchar AS lo_id,
        la.product_id::text AS product_id,
        la.principal_outstanding AS pos,
        coalesce(la.dpd, 0)      AS current_dpd,
        coalesce(d.dpd_eom, 0)   AS prev_month_dpd,
        la.status
    FROM public.loan_account_il la
    LEFT JOIN il_dpd_eom d ON d.loan_id = la.loan_id
    WHERE la.status IN ('A', 'D', 'I', 'W')
       OR (la.closure_date IS NOT NULL
           AND la.closure_date::date >= (SELECT curr_month_start FROM ref))
),
bucketed AS (
    SELECT *,
        CASE WHEN current_dpd = 0 THEN 0 WHEN current_dpd BETWEEN 1 AND 30 THEN 1
             WHEN current_dpd BETWEEN 31 AND 60 THEN 2 WHEN current_dpd BETWEEN 61 AND 90 THEN 3
             ELSE 4 END AS curr_bucket,
        CASE WHEN prev_month_dpd = 0 THEN 0 WHEN prev_month_dpd BETWEEN 1 AND 30 THEN 1
             WHEN prev_month_dpd BETWEEN 31 AND 60 THEN 2 WHEN prev_month_dpd BETWEEN 61 AND 90 THEN 3
             ELSE 4 END AS prev_bucket
    FROM il_loans
)
SELECT b.loan_source,
    coalesce(h.cluster_name,'Unassigned') AS cluster_name,
    coalesce(h.region_name, 'Unassigned') AS region_name,
    coalesce(h.area_name,   'Unassigned') AS area_name,
    coalesce(h.branch_name, 'Unassigned') AS branch_name,
    b.branch_id, coalesce(b.lo_id,'N/A') AS lo_id, b.product_id,
    count(b.loan_id)                                                         AS total_loans,
    round(sum(b.pos)::numeric, 2)                                            AS total_pos,
    count(CASE WHEN b.curr_bucket = b.prev_bucket THEN 1 END)               AS sb_count,
    round(sum(CASE WHEN b.curr_bucket = b.prev_bucket THEN b.pos ELSE 0 END)::numeric,2) AS sb_pos,
    count(CASE WHEN b.curr_bucket < b.prev_bucket THEN 1 END)               AS rb_count,
    round(sum(CASE WHEN b.curr_bucket < b.prev_bucket THEN b.pos ELSE 0 END)::numeric,2) AS rb_pos,
    count(CASE WHEN b.curr_bucket > b.prev_bucket THEN 1 END)               AS rf_count,
    round(sum(CASE WHEN b.curr_bucket > b.prev_bucket THEN b.pos ELSE 0 END)::numeric,2) AS rf_pos,
    count(CASE WHEN b.prev_bucket=0 THEN 1 END) AS prev_standard_count,
    count(CASE WHEN b.prev_bucket=1 THEN 1 END) AS prev_sma0_count,
    count(CASE WHEN b.prev_bucket=2 THEN 1 END) AS prev_sma1_count,
    count(CASE WHEN b.prev_bucket=3 THEN 1 END) AS prev_sma2_count,
    count(CASE WHEN b.prev_bucket=4 THEN 1 END) AS prev_npa_count,
    count(CASE WHEN b.curr_bucket=0 THEN 1 END) AS curr_standard_count,
    count(CASE WHEN b.curr_bucket=1 THEN 1 END) AS curr_sma0_count,
    count(CASE WHEN b.curr_bucket=2 THEN 1 END) AS curr_sma1_count,
    count(CASE WHEN b.curr_bucket=3 THEN 1 END) AS curr_sma2_count,
    count(CASE WHEN b.curr_bucket=4 THEN 1 END) AS curr_npa_count,
    (SELECT prev_month_end FROM ref) AS dpd_eom_date,
    current_date                     AS report_date
FROM bucketed b
LEFT JOIN hierarchy h ON h.branch_id = b.branch_id
GROUP BY b.loan_source, h.cluster_name, h.region_name, h.area_name, h.branch_name,
         b.branch_id, b.lo_id, b.product_id
ORDER BY b.loan_source, h.cluster_name, h.region_name, h.area_name, h.branch_name;
