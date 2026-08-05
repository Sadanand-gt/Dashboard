-- =============================================================================
-- MTD FLOW — IL half (run WHOLE, once). Current partial-month flow measures the
-- live report tables don't carry, for the trend's July (MTD, partial) point:
--   mtd_wo_recovery      = post-write-off collections THIS month
--   mtd_par60_collection = collections THIS month from loans PAR>60 at prev EOM
-- Grain: loan_source × business_segment × hierarchy × lo_id. See mtd_flow_jlg.sql
-- for the JLG half (chunked). Runner concatenates + re-aggregates.
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
il_loans AS (
    SELECT la.loan_id, la.branch_id, la.loan_officer::varchar AS lo_id,
        CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
              OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
             THEN 'LAP' ELSE 'IEL' END AS business_segment
    FROM public.loan_account_il la
    WHERE la.loan_id >= 10000000 AND la.status <> 'R'
),
il_rec AS (
    SELECT l.business_segment, l.branch_id, l.lo_id,
           sum(rd.amount_collected) AS mtd_wo_recovery
    FROM public.repayment_detail_il rd
    JOIN wo_master w ON w.loan_id = rd.loan_id
    JOIN il_loans  l ON l.loan_id = rd.loan_id
    WHERE rd.status = 'A'
      AND rd.collection_date_time::date >  w.wo_date
      AND rd.collection_date_time::date >= (SELECT mstart FROM period)
    GROUP BY 1, 2, 3
),
il_coll_prev AS (
    SELECT rd.loan_id, sum(coalesce(rd.principal_collected,0)+coalesce(rd.interest_collected,0)) AS cum_coll
    FROM public.repayment_detail_il rd
    JOIN il_loans l ON l.loan_id = rd.loan_id
    WHERE rd.status = 'A' AND rd.collection_date_time::date <= (SELECT prev_meod FROM period)
    GROUP BY rd.loan_id
),
il_dpd AS (
    SELECT s.loan_id,
        (SELECT prev_meod FROM period) - min(s.demand_date::date)
            FILTER (WHERE (coalesce(s.cumulative_principal_due,0)+coalesce(s.cumulative_interest_due,0))
                          > coalesce(c.cum_coll, 0) + 0.005) + 1 AS dpd
    FROM public.repayment_schedule_il s
    JOIN il_loans l          ON l.loan_id = s.loan_id
    LEFT JOIN il_coll_prev c  ON c.loan_id = s.loan_id
    WHERE s.demand_date::date <= (SELECT prev_meod FROM period)
    GROUP BY s.loan_id, c.cum_coll
),
il_par60_coll AS (
    SELECT l.business_segment, l.branch_id, l.lo_id,
           sum(rd.amount_collected) AS mtd_par60_collection
    FROM il_dpd d
    JOIN il_loans l ON l.loan_id = d.loan_id
    JOIN public.repayment_detail_il rd ON rd.loan_id = d.loan_id
    WHERE d.dpd > 60 AND rd.status = 'A'
      AND rd.collection_date_time::date >= (SELECT mstart FROM period)
    GROUP BY 1, 2, 3
),
combined AS (
    SELECT business_segment, branch_id, lo_id, mtd_wo_recovery, 0::numeric AS mtd_par60_collection FROM il_rec
    UNION ALL SELECT business_segment, branch_id, lo_id, 0, mtd_par60_collection FROM il_par60_coll
)
SELECT
    'IL'::text AS loan_source, c.business_segment,
    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    c.branch_id::text AS branch_id, coalesce(c.lo_id, 'N/A') AS lo_id,
    round(sum(c.mtd_wo_recovery)::numeric,      2) AS mtd_wo_recovery,
    round(sum(c.mtd_par60_collection)::numeric, 2) AS mtd_par60_collection
FROM combined c
LEFT JOIN hierarchy h ON h.branch_id = c.branch_id
GROUP BY c.business_segment, h.cluster_name, h.region_name, h.area_name, h.branch_name, c.branch_id, c.lo_id;
