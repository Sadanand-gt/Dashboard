-- =============================================================================
-- MTD FLOW — JLG half. CHUNKED by {chunk_pred} (mod loan_id) like trend_full_jlg
-- because the prev-month-end DPD over ~440k JLG loans is the heavy part. Runner
-- runs N chunks, concatenates with the IL half, and re-aggregates by dims (a
-- branch's loans span all chunks). See mtd_flow_il.sql.
-- =============================================================================
WITH
period AS (
    SELECT date_trunc('month', current_date - 1)::date                        AS mstart,
           (date_trunc('month', current_date - 1) - interval '1 day')::date   AS prev_meod
),
wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date
    FROM (VALUES {wo_pairs}) AS v(loan_id, wo_date)
),
hierarchy AS (
    SELECT bm.branch_id, bm.branch_name, a.area_name,
        reg.branch_name AS region_name, clus.area_name AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
),
jlg_loans AS (
    SELECT la.loan_id, cm.branch_id, cm.assigned_to::varchar AS lo_id
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    WHERE la.loan_id >= 10000000 AND la.status <> 'R' {chunk_pred}
),
jlg_rec AS (
    SELECT l.branch_id, l.lo_id, sum(rd.amount_collected) AS mtd_wo_recovery
    FROM public.repayment_detail rd
    JOIN wo_master w ON w.loan_id = rd.loan_id
    JOIN jlg_loans l ON l.loan_id = rd.loan_id
    WHERE rd.status = 'A'
      AND rd.collection_date::date >  w.wo_date
      AND rd.collection_date::date >= (SELECT mstart FROM period)
    GROUP BY 1, 2
),
jlg_coll_prev AS (
    SELECT rd.loan_id, sum(coalesce(rd.principal_collected,0)+coalesce(rd.interest_collected,0)) AS cum_coll
    FROM public.repayment_detail rd
    JOIN jlg_loans l ON l.loan_id = rd.loan_id
    WHERE rd.status = 'A' AND rd.collection_date::date <= (SELECT prev_meod FROM period)
    GROUP BY rd.loan_id
),
jlg_dpd AS (
    SELECT s.loan_id,
        (SELECT prev_meod FROM period) - min(s.demand_date::date)
            FILTER (WHERE (coalesce(s.cumulative_principal_due,0)+coalesce(s.cumulative_interest_due,0))
                          > coalesce(c.cum_coll, 0) + 0.005) + 1 AS dpd
    FROM public.repayment_schedule s
    JOIN jlg_loans l          ON l.loan_id = s.loan_id
    LEFT JOIN jlg_coll_prev c  ON c.loan_id = s.loan_id
    WHERE s.demand_date::date <= (SELECT prev_meod FROM period)
    GROUP BY s.loan_id, c.cum_coll
),
jlg_par60_coll AS (
    SELECT l.branch_id, l.lo_id, sum(rd.amount_collected) AS mtd_par60_collection
    FROM jlg_dpd d
    JOIN jlg_loans l ON l.loan_id = d.loan_id
    JOIN public.repayment_detail rd ON rd.loan_id = d.loan_id
    WHERE d.dpd > 60 AND rd.status = 'A'
      AND rd.collection_date::date >= (SELECT mstart FROM period)
    GROUP BY 1, 2
),
combined AS (
    SELECT branch_id, lo_id, mtd_wo_recovery, 0::numeric AS mtd_par60_collection FROM jlg_rec
    UNION ALL SELECT branch_id, lo_id, 0, mtd_par60_collection FROM jlg_par60_coll
)
SELECT
    'JLG'::text AS loan_source, 'JLG'::text AS business_segment,
    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    c.branch_id::text AS branch_id, coalesce(c.lo_id, 'N/A') AS lo_id,
    round(sum(c.mtd_wo_recovery)::numeric,      2) AS mtd_wo_recovery,
    round(sum(c.mtd_par60_collection)::numeric, 2) AS mtd_par60_collection
FROM combined c
LEFT JOIN hierarchy h ON h.branch_id = c.branch_id
GROUP BY h.cluster_name, h.region_name, h.area_name, h.branch_name, c.branch_id, c.lo_id;
