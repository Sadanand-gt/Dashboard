-- =============================================================================
-- Report  : DQ Category (Delinquency Category) — Excel "DQ Category" sheet
-- Logic   : Power Pivot DAX (Early DQ / Infant DQ measures):
--   asof         = current_date - 1  (= MAX(Dates[MTD To]))
--   Early cutoff  = EOMONTH(asof, -8) = date_trunc('month',now) - 7 mo - 1 day
--   Infant cutoff = EOMONTH(asof, -3) = date_trunc('month',now) - 2 mo - 1 day
--   Early eligible  : FIRST_DEMAND_DATE >= Early cutoff   (first came due <= 8 mo ago)
--   Infant eligible : FIRST_DEMAND_DATE >= Infant cutoff  (first came due <= 3 mo ago)
--   *_od           : eligible AND OD_DAYS > 0
--   DQ %           : POS-weighted = SUM(OUTSTANDING_PRINCIPAL of *_od)
--                                   / SUM(OUTSTANDING_PRINCIPAL of eligible)
-- Grain   : aggregated over all analysis-parameter dimensions (both pages read it).
-- Universe: loan_account_il + home_loan_account, status IN ('A','D','W).
-- Write-off: {wo_ids} overrides loan STATUS only (Portfolio toggle excludes them).
-- =============================================================================

WITH
ref AS (
    SELECT
        (current_date - interval '1 day')::date                                            AS asof,
        (date_trunc('month', current_date) - interval '7 month' - interval '1 day')::date  AS early_cut,   -- EOMONTH(asof,-8)
        (date_trunc('month', current_date) - interval '2 month' - interval '1 day')::date  AS infant_cut   -- EOMONTH(asof,-3)
),

hierarchy AS (
    SELECT bm.branch_id, bm.branch_name, a.area_name,
        reg.branch_name AS region_name, clus.area_name AS cluster_name,
        z.area_name AS zone_name, bm.state_id, bm.district_id
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
    LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id
    WHERE bm.active='Y' AND bm.is_region='N' AND bm.branch_name<>'DEMO' AND bm.closing_date IS NULL
),

il_prod_class AS (
    SELECT lp.product_id, coalesce(pc.product_classification,'Other') AS prod_classification
    FROM public.loan_product_il lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),
jlg_prod_class AS (
    SELECT lp.product_id, coalesce(pc.product_classification,'Other') AS prod_classification
    FROM public.loan_product lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),

il_extra AS (
    SELECT DISTINCT ON (la.loan_id) la.loan_id,
        coalesce(la.purpose_id::text,'N/A')  AS purpose_id,
        coalesce(la.facility_id::text,'N/A') AS facility_id,
        coalesce(la.lender_id::text,'N/A')   AS lender_id,
        coalesce(cci.caste,'N/A')            AS caste,
        coalesce(cci.religion,'N/A')         AS religion
    FROM public.loan_account_il la
    LEFT JOIN public.customer_contacts_il cci ON cci.loan_id = la.loan_id
    WHERE la.status IN ('A','D','I','W') ORDER BY la.loan_id
),
jlg_extra AS (
    SELECT DISTINCT ON (hla.loan_id) hla.loan_id,
        coalesce(hla.purpose_id::text,'N/A')  AS purpose_id,
        coalesce(hla.facility_id::text,'N/A') AS facility_id,
        'N/A'::text                            AS lender_id,
        coalesce(hbm.caste,'N/A')             AS caste,
        coalesce(hbm.religion,'N/A')          AS religion
    FROM public.home_loan_account hla
    LEFT JOIN public.home_brrwr_misc hbm ON hbm.cust_id = hla.cust_id
    WHERE hla.status IN ('A','D','I','W') ORDER BY hla.loan_id
),

-- ── Per-loan rows (IL + JLG): first_demand_date, live dpd, POS, dims ──────────
il_loans AS (
    SELECT
        'IL'                                                    AS loan_source,
        CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
              OR upper(trim(la.product_id::text)) LIKE '%SECURED%' THEN 'LAP' ELSE 'IEL' END AS business_segment,
        la.loan_id, la.branch_id,
        la.loan_officer::varchar                                AS lo_id,
        la.first_demand_date,
        coalesce(la.dpd, 0)                                     AS dpd,
        coalesce(la.principal_outstanding, 0)                  AS pos,
        CASE WHEN la.loan_id IN ({wo_ids}) OR la.status='W' THEN 'W' ELSE la.status END AS raw_status,
        extract(year FROM la.disbursement_date)::text           AS disb_year,
        coalesce(la.cycle::text,'N/A')                          AS cycle_no,
        coalesce(ipc.prod_classification,'Other')               AS prod_classification,
        ex.purpose_id, ex.facility_id, ex.lender_id, ex.caste, ex.religion
    FROM public.loan_account_il la
    LEFT JOIN il_prod_class ipc ON ipc.product_id = la.product_id::text
    LEFT JOIN il_extra ex ON ex.loan_id = la.loan_id
    WHERE la.status IN ('A','D','I','W')
),
jlg_loans AS (
    SELECT
        'JLG'                                                   AS loan_source,
        'JLG'                                                   AS business_segment,
        la.loan_id, cm.branch_id,
        cm.assigned_to::varchar                                 AS lo_id,
        la.first_demand_date,
        coalesce(la.dpd, 0)                                     AS dpd,
        coalesce(la.prin_os, 0)                                AS pos,
        CASE WHEN la.loan_id IN ({wo_ids}) OR la.status='W' THEN 'W' ELSE la.status END AS raw_status,
        extract(year FROM la.disbursement_date)::text           AS disb_year,
        coalesce(la.cycle::text,'N/A')                          AS cycle_no,
        coalesce(jpc.prod_classification,'Other')               AS prod_classification,
        ex.purpose_id, ex.facility_id, ex.lender_id, ex.caste, ex.religion
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN jlg_prod_class jpc ON jpc.product_id = la.product_id::text
    LEFT JOIN jlg_extra ex ON ex.loan_id = la.loan_id
    WHERE la.status IN ('A','D','I','W')
      AND (la.status <> 'W' OR la.prin_os > 0)
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id = la.loan_id AND il.status IN ('A','D','I','W')
            AND il.disbursement_date > la.disbursement_date)
),
all_loans AS (SELECT * FROM il_loans UNION ALL SELECT * FROM jlg_loans),

enriched AS (
    SELECT al.*,
        CASE WHEN al.dpd = 0                     THEN 'Regular'
             WHEN al.dpd BETWEEN 1 AND 30        THEN '1 - 30'
             WHEN al.dpd BETWEEN 31 AND 60       THEN '31 - 60'
             WHEN al.dpd BETWEEN 61 AND 90       THEN '61 - 90'
             WHEN al.dpd BETWEEN 91 AND 180      THEN '91 - 180'
             WHEN al.dpd BETWEEN 181 AND 360     THEN '181 - 360'
             ELSE                                     '360 +' END AS dpd_bucket,
        CASE al.raw_status WHEN 'A' THEN 'Active' WHEN 'D' THEN 'Death' WHEN 'I' THEN 'Death'
             WHEN 'W' THEN 'Write-off' ELSE al.raw_status END       AS loan_status,
        CASE WHEN al.first_demand_date IS NOT NULL
              AND al.first_demand_date::date >= (SELECT early_cut  FROM ref) THEN 1 ELSE 0 END AS early_elig,
        CASE WHEN al.first_demand_date IS NOT NULL
              AND al.first_demand_date::date >= (SELECT infant_cut FROM ref) THEN 1 ELSE 0 END AS infant_elig,
        CASE WHEN al.dpd > 0 THEN 1 ELSE 0 END AS is_od
    FROM all_loans al
)

SELECT
    e.loan_source, e.business_segment,
    coalesce(h.zone_name,'Unassigned')    AS zone_name,
    coalesce(h.cluster_name,'Unassigned') AS cluster_name,
    coalesce(h.region_name,'Unassigned')  AS region_name,
    coalesce(h.area_name,'Unassigned')    AS area_name,
    coalesce(h.branch_name,'Unassigned')  AS branch_name,
    e.branch_id,
    coalesce(e.lo_id,'N/A')               AS lo_id,
    coalesce(h.state_id::text,'N/A')      AS state_id,
    coalesce(h.district_id::text,'N/A')   AS district_id,
    e.prod_classification, e.dpd_bucket, e.loan_status,
    coalesce(e.cycle_no,'N/A')  AS cycle_no,
    coalesce(e.disb_year,'N/A') AS disb_year,
    coalesce(e.purpose_id,'N/A')  AS purpose_id,
    coalesce(e.facility_id,'N/A') AS facility_id,
    coalesce(e.lender_id,'N/A')   AS lender_id,
    coalesce(e.caste,'N/A')     AS caste,
    coalesce(e.religion,'N/A')  AS religion,

    -- Early DQ (first demand within ~8 months)
    sum(e.early_elig)                             AS early_elig_cnt,
    round(sum(e.early_elig * e.pos)::numeric,2)   AS early_elig_pos,
    sum(e.early_elig * e.is_od)                   AS early_od_cnt,
    round(sum(e.early_elig * e.is_od * e.pos)::numeric,2) AS early_od_pos,
    -- Infant DQ (first demand within ~3 months)
    sum(e.infant_elig)                            AS infant_elig_cnt,
    round(sum(e.infant_elig * e.pos)::numeric,2)  AS infant_elig_pos,
    sum(e.infant_elig * e.is_od)                  AS infant_od_cnt,
    round(sum(e.infant_elig * e.is_od * e.pos)::numeric,2) AS infant_od_pos
FROM enriched e
LEFT JOIN hierarchy h ON e.branch_id = h.branch_id
GROUP BY
    e.loan_source, e.business_segment, h.zone_name, h.cluster_name, h.region_name,
    h.area_name, h.branch_name, e.branch_id, e.lo_id, h.state_id, h.district_id,
    e.prod_classification, e.dpd_bucket, e.loan_status, e.cycle_no, e.disb_year,
    e.purpose_id, e.facility_id, e.lender_id, e.caste, e.religion;
