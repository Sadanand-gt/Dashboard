-- =============================================================================
-- Report  : AML Risk Category (compliance monitoring)
-- Universe: ACTIVE book only — status IN ('A','D','I') and open as of today
--           (matches the pre-worked AML SQLs; write-offs are off-book, excluded).
-- Source  : borrower AML attributes joined to the loan by cust_id —
--             JLG: home_brrwr_misc  ⋈ home_loan_account
--             IL : brrwroth_il      ⋈ loan_account_il   (empty until DBA sync)
-- Grain   : one row per (segment × risk/PEP/abroad/LUC flags × hierarchy × dims).
-- Measures are ADDITIVE components (loan_count, POS, and FILTER counts for the
-- High/PEP/abroad/LUC-pending/data-quality cuts) so the backend can compute
-- High-risk %, PEP %, etc. under ANY grouping / user scope, without re-querying.
-- POS: JLG prin_os, IL principal_outstanding (live active book).
-- =============================================================================
WITH
hierarchy AS (
    SELECT bm.branch_id, bm.branch_name,
        a.area_id,  a.area_name,
        reg.branch_id AS region_id,  reg.branch_name AS region_name,
        clus.area_id  AS cluster_id, clus.area_name  AS cluster_name,
        z.area_id     AS zone_id,    z.area_name     AS zone_name,
        bm.state_id, bm.district_id
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
    LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id
    WHERE bm.active = 'Y' AND bm.is_region = 'N'
      AND bm.branch_name <> 'DEMO' AND bm.closing_date IS NULL
),

-- product classification (standard slicer, mirrors aum_status)
il_prod_class AS (
    SELECT lp.product_id, coalesce(pc.product_classification, 'Other') AS prod_classification
    FROM public.loan_product_il lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),
jlg_prod_class AS (
    SELECT lp.product_id, coalesce(pc.product_classification, 'Other') AS prod_classification
    FROM public.loan_product lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),

-- ── IL active loans + borrower AML attributes ────────────────────────────────
il_loans AS (
    SELECT
        'IL'::text                                              AS loan_source,
        CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
              OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
             THEN 'LAP' ELSE 'IEL' END                          AS business_segment,
        la.loan_id, la.branch_id,
        la.loan_officer::varchar                                AS lo_id,
        coalesce(la.principal_outstanding, 0)                   AS pos,
        upper(nullif(btrim(bo.aml_risk::text), ''))             AS aml_risk,
        upper(nullif(btrim(bo.political_exposure_flag::text),'')) AS pep,
        upper(nullif(btrim(bo.work_abroad_flag::text), ''))     AS abroad,
        upper(nullif(btrim(bo.luc_india::text), ''))            AS luc,
        upper(nullif(btrim(bo.citizenship::text), ''))          AS citizenship,
        coalesce(ipc.prod_classification, 'Other')              AS prod_classification
    FROM public.loan_account_il la
    LEFT JOIN public.brrwroth_il bo ON bo.cust_id = la.cust_id
    LEFT JOIN il_prod_class ipc ON ipc.product_id = la.product_id::text
    WHERE la.status IN ('A','D','I')
      AND la.loan_id >= 10000000
      -- T-1 anchor, matching aum_status: the warehouse holds through yesterday.
      AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1)
),

-- ── JLG active loans + borrower AML attributes ───────────────────────────────
-- Dedup graduated customers (JLG loan whose id was re-disbursed later as IL) the
-- same way aum_status does, so a borrower is screened once on their live loan.
jlg_loans AS (
    SELECT
        'JLG'::text                                             AS loan_source,
        'JLG'::text                                             AS business_segment,
        la.loan_id, cm.branch_id,
        cm.assigned_to::varchar                                 AS lo_id,
        coalesce(la.prin_os, 0)                                 AS pos,
        upper(nullif(btrim(bm.aml_risk::text), ''))             AS aml_risk,
        upper(nullif(btrim(bm.political_exposure_flag::text),'')) AS pep,
        upper(nullif(btrim(bm.work_abroad_flag::text), ''))     AS abroad,
        upper(nullif(btrim(bm.luc_india::text), ''))            AS luc,
        upper(nullif(btrim(bm.citizenship::text), ''))          AS citizenship,
        coalesce(jpc.prod_classification, 'Other')              AS prod_classification
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    -- LEFT, not INNER (fixed 2026-08-12). An inner join dropped 5,048 loans
    -- (5,045 JLG + 3 IL) whose customer has no AML attribute row, so the report
    -- silently excluded exactly the borrowers who have never been screened —
    -- and left AML 5,048 loans short of Current Outstanding. They now surface as
    -- Unclassified / Unknown, which is what they are.
    LEFT JOIN public.home_brrwr_misc bm ON bm.cust_id = la.cust_id
    LEFT JOIN jlg_prod_class jpc ON jpc.product_id = la.product_id::text
    WHERE la.status IN ('A','D','I')
      AND la.loan_id >= 10000000
      -- T-1 anchor, matching aum_status: the warehouse holds through yesterday.
      AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1)
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id = la.loan_id
            AND il.status IN ('A','D','I','W')
            AND il.disbursement_date > la.disbursement_date
      )
),

all_loans AS (
    SELECT * FROM il_loans
    UNION ALL
    SELECT * FROM jlg_loans
),

-- normalize the raw codes into readable, filterable categories
enriched AS (
    SELECT al.*,
        CASE aml_risk WHEN 'H' THEN 'High' WHEN 'L' THEN 'Low'
             ELSE 'Unclassified' END                            AS risk_category,
        CASE pep    WHEN 'Y' THEN 'PEP' WHEN 'N' THEN 'Non-PEP'
             ELSE 'Unknown' END                                 AS pep_flag,
        CASE abroad WHEN 'Y' THEN 'Works Abroad' WHEN 'N' THEN 'Domestic'
             ELSE 'Unknown' END                                 AS work_abroad_flag,
        CASE luc    WHEN 'Y' THEN 'LUC Done' WHEN 'N' THEN 'LUC Pending'
             ELSE 'Unknown' END                                 AS luc_flag,
        -- Question 4 of Client Risk Categorization. Raw declared value, not a
        -- Y/N: a non-Indian nationality is the whole point of asking.
        coalesce(citizenship, 'Unknown')                        AS nationality
    FROM all_loans al
)

SELECT
    current_date                                    AS as_of_date,
    e.loan_source,
    e.business_segment,
    e.risk_category,
    e.pep_flag,
    e.work_abroad_flag,
    e.luc_flag,
    e.nationality,
    coalesce(h.zone_name,    'Unassigned')          AS zone_name,
    coalesce(h.cluster_name, 'Unassigned')          AS cluster_name,
    coalesce(h.region_name,  'Unassigned')          AS region_name,
    coalesce(h.area_name,    'Unassigned')          AS area_name,
    coalesce(h.branch_name,  'Unassigned')          AS branch_name,
    e.branch_id,
    coalesce(e.lo_id,        'N/A')                 AS lo_id,
    -- display labels "<id> - <NAME>" (display-only; plain *_name carry scope)
    coalesce(h.zone_id::text   || ' - ' || h.zone_name,    'Unassigned') AS zone_label,
    coalesce(h.cluster_id::text|| ' - ' || h.cluster_name, 'Unassigned') AS cluster_label,
    coalesce(h.region_id::text || ' - ' || h.region_name,  'Unassigned') AS region_label,
    coalesce(h.area_id::text   || ' - ' || h.area_name,    'Unassigned') AS area_label,
    coalesce(e.branch_id::text || ' - ' || h.branch_name,  'Unassigned') AS branch_label,
    coalesce(e.prod_classification, 'Other')        AS prod_classification,
    coalesce(h.state_id::text,   'N/A')             AS state_id,
    coalesce(h.district_id::text,'N/A')             AS district_id,

    count(e.loan_id)                                                       AS loan_count,
    round(sum(e.pos)::numeric, 2)                                          AS total_pos,
    count(*) FILTER (WHERE e.risk_category = 'High')                       AS high_count,
    round(sum(e.pos) FILTER (WHERE e.risk_category = 'High')::numeric, 2)  AS high_pos,
    count(*) FILTER (WHERE e.risk_category = 'Low')                        AS low_count,
    count(*) FILTER (WHERE e.pep_flag = 'PEP')                             AS pep_count,
    count(*) FILTER (WHERE e.work_abroad_flag = 'Works Abroad')            AS abroad_count,
    count(*) FILTER (WHERE e.luc_flag = 'LUC Pending')                     AS luc_pending_count,
    count(*) FILTER (WHERE e.risk_category = 'Unclassified')               AS risk_unknown_count,
    count(*) FILTER (WHERE e.pep_flag = 'Unknown')                         AS pep_unknown_count
FROM enriched e
LEFT JOIN hierarchy h ON e.branch_id = h.branch_id
GROUP BY
    e.loan_source, e.business_segment,
    e.risk_category, e.pep_flag, e.work_abroad_flag, e.luc_flag, e.nationality,
    h.zone_name, h.cluster_name, h.region_name, h.area_name, h.branch_name,
    h.zone_id, h.cluster_id, h.region_id, h.area_id,
    e.branch_id, e.lo_id, e.prod_classification,
    h.state_id, h.district_id
ORDER BY
    e.business_segment, e.risk_category,
    h.zone_name, h.cluster_name, h.region_name, h.area_name, h.branch_name;
