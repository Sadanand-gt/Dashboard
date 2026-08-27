-- =============================================================================
-- AML Risk Category — LOAN GRAIN  ->  rpt_aml_loans
--
-- One row per screened loan. Feeds the AML page's With / Excl write-off views,
-- its new-case cards and its loan-wise CSV export.
--
-- UNIVERSE AND CLASSIFICATION ARE COPIED VERBATIM FROM aum_status.sql.
--   The active portfolio is the SAME book in both reports, so its loan count
--   cannot differ between the two pages. Rather than approximate that universe,
--   this query reproduces it clause for clause:
--     * raw_status applies the write-off master WITH ITS DATE GATE
--       (disbursement_date <= wo_date). Without the gate a brand-new IL loan
--       inherits the write-off of the JLG loan whose id it reused.
--     * open_now anchors on current_date - 1 (T-1: the warehouse only holds
--       through yesterday) and EXEMPTS status 'W' from the closure guard.
--     * JLG drops zero-balance write-offs: (status != 'W' OR prin_os > 0).
--     * Loans closed during the current month are retained and labelled
--       'Closed', exactly as aum_status does, so both agree on every bucket.
--
--   RECONCILIATION — must hold after every run:
--     loan_status IN ('Active','Death')             = Current Outstanding Excl W/O
--     loan_status IN ('Active','Death','Write-off') = Current Outstanding With W/O
--
-- Getting here took two fixes worth recording:
--   1. The borrower joins were INNER, dropping 5,048 loans whose customer has no
--      AML attribute row — the never-screened borrowers, which is precisely who
--      a compliance report exists to surface. They are LEFT joins now and appear
--      as Unclassified / Unknown.
--   2. The universe used current_date and guarded 'W' against closure, leaving
--      AML 8 loans short of Current Outstanding Excl W/O and 122 short With W/O.
--
-- AML attributes come from the BORROWER and are independent of loan status: the
-- write-off master overrides STATUS only, never a borrower's risk grading.
--
-- report_day is NOT selected here; pg_write_report_day stamps it on write.
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

ref AS (
    SELECT (date_trunc('month', current_date) - interval '1 day')::date AS prev_month_end
),

wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date
    FROM (VALUES {wo_pairs}) AS v(loan_id, wo_date)
),

-- ── IL loans: aum_status universe + borrower AML attributes ─────────────────
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
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END                        AS raw_status,
        (la.status IN ('A','D','I','W')
         AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1
              OR la.status = 'W'))                              AS open_now,
        upper(nullif(btrim(bo.aml_risk::text), ''))             AS aml_risk,
        (bo.cust_id IS NOT NULL)                                AS has_aml_row,
        upper(nullif(btrim(bo.political_exposure_flag::text),'')) AS pep,
        upper(nullif(btrim(bo.work_abroad_flag::text), ''))     AS abroad,
        upper(nullif(btrim(bo.luc_india::text), ''))            AS luc,
        upper(nullif(btrim(bo.citizenship::text), ''))          AS citizenship,
        coalesce(ipc.prod_classification, 'Other')              AS prod_classification
    FROM public.loan_account_il la
    LEFT JOIN public.brrwroth_il bo ON bo.cust_id = la.cust_id
    LEFT JOIN il_prod_class ipc ON ipc.product_id = la.product_id::text
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    WHERE la.loan_id >= 10000000
      AND la.status <> 'R'
      AND (
           (la.status IN ('A','D','I','W')
            AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1
                 OR la.status = 'W'))
        OR (la.disbursement_date::date <= (SELECT prev_month_end FROM ref)
            AND la.closure_date::date  >  (SELECT prev_month_end FROM ref)
            AND la.closure_date::date  <= current_date - 1)
      )
),

-- ── JLG loans: aum_status universe + borrower AML attributes ────────────────
jlg_loans AS (
    SELECT
        'JLG'::text                                             AS loan_source,
        'JLG'::text                                             AS business_segment,
        la.loan_id, cm.branch_id,
        cm.assigned_to::varchar                                 AS lo_id,
        coalesce(la.prin_os, 0)                                 AS pos,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END                        AS raw_status,
        (la.status IN ('A','D','I','W')
         AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1
              OR la.status = 'W'))                              AS open_now,
        upper(nullif(btrim(bm.aml_risk::text), ''))             AS aml_risk,
        (bm.cust_id IS NOT NULL)                                AS has_aml_row,
        upper(nullif(btrim(bm.political_exposure_flag::text),'')) AS pep,
        upper(nullif(btrim(bm.work_abroad_flag::text), ''))     AS abroad,
        upper(nullif(btrim(bm.luc_india::text), ''))            AS luc,
        upper(nullif(btrim(bm.citizenship::text), ''))          AS citizenship,
        coalesce(jpc.prod_classification, 'Other')              AS prod_classification
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN public.home_brrwr_misc bm ON bm.cust_id = la.cust_id
    LEFT JOIN jlg_prod_class jpc ON jpc.product_id = la.product_id::text
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    WHERE la.loan_id >= 10000000
      AND la.status <> 'R'
      AND (la.status != 'W' OR la.prin_os > 0)
      AND (
           (la.status IN ('A','D','I','W')
            AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1
                 OR la.status = 'W'))
        OR (la.disbursement_date::date <= (SELECT prev_month_end FROM ref)
            AND la.closure_date::date  >  (SELECT prev_month_end FROM ref)
            AND la.closure_date::date  <= current_date - 1)
      )
      -- graduated customers: a JLG loan whose id was re-disbursed later as IL is
      -- screened on the IL incarnation only
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
),

enriched AS (
    SELECT al.*,
        -- Reverted to a single Unclassified bucket 2026-08-13: home_brrwr_misc
        -- is being synced, which should clear the ~5,029 JLG borrowers who had
        -- no row there. has_aml_row is still carried on the loan rows, so the
        -- split can be reinstated by restoring the WHEN NOT has_aml_row branch
        -- if the gap persists after the sync.
        CASE WHEN aml_risk = 'H' THEN 'High'
             WHEN aml_risk = 'L' THEN 'Low'
             ELSE 'Unclassified' END                            AS risk_category,
        CASE pep    WHEN 'Y' THEN 'PEP' WHEN 'N' THEN 'Non-PEP'
             ELSE 'Unknown' END                                 AS pep_flag,
        CASE abroad WHEN 'Y' THEN 'Works Abroad' WHEN 'N' THEN 'Domestic'
             ELSE 'Unknown' END                                 AS work_abroad_flag,
        CASE luc    WHEN 'Y' THEN 'LUC Done' WHEN 'N' THEN 'LUC Pending'
             ELSE 'Unknown' END                                 AS luc_flag,
        -- Question 4 of Client Risk Categorization. Kept as the raw declared
        -- value rather than a Y/N: the field is free text at source and a
        -- non-Indian nationality is the whole point of asking, so collapsing it
        -- to a flag would discard the only answer that would ever matter.
        coalesce(citizenship, 'Unknown')                        AS nationality,
        -- identical to aum_status: write-off wins over a current-month closure
        CASE
            WHEN al.raw_status = 'W'        THEN 'Write-off'
            WHEN NOT al.open_now            THEN 'Closed'
            WHEN al.raw_status = 'A'        THEN 'Active'
            WHEN al.raw_status IN ('D','I') THEN 'Death'
            ELSE al.raw_status
        END                                                     AS loan_status
    FROM all_loans al
)

SELECT
    (current_date - 1)                              AS as_of_date,
    e.loan_id,
    e.loan_source,
    e.business_segment,
    e.risk_category,
    e.pep_flag,
    e.work_abroad_flag,
    e.luc_flag,
    -- RAW source values alongside the normalised labels. A row reads
    -- Unclassified / Unknown precisely because these are NULL or blank at
    -- source, so shipping them makes an exported file self-validating — no
    -- re-querying the core tables to confirm what a blank means.
    e.aml_risk                                      AS aml_risk_raw,
    e.pep                                           AS political_exposure_flag_raw,
    e.abroad                                        AS work_abroad_flag_raw,
    e.luc                                           AS luc_india_raw,
    e.nationality,
    e.loan_status,
    (e.raw_status = 'W')                            AS is_wo,
    e.open_now,
    coalesce(h.zone_name,    'Unassigned')          AS zone_name,
    coalesce(h.cluster_name, 'Unassigned')          AS cluster_name,
    coalesce(h.region_name,  'Unassigned')          AS region_name,
    coalesce(h.area_name,    'Unassigned')          AS area_name,
    coalesce(h.branch_name,  'Unassigned')          AS branch_name,
    e.branch_id,
    coalesce(e.lo_id,        'N/A')                 AS lo_id,
    coalesce(h.zone_id::text   || ' - ' || h.zone_name,    'Unassigned') AS zone_label,
    coalesce(h.cluster_id::text|| ' - ' || h.cluster_name, 'Unassigned') AS cluster_label,
    coalesce(h.region_id::text || ' - ' || h.region_name,  'Unassigned') AS region_label,
    coalesce(h.area_id::text   || ' - ' || h.area_name,    'Unassigned') AS area_label,
    coalesce(e.branch_id::text || ' - ' || h.branch_name,  'Unassigned') AS branch_label,
    coalesce(e.prod_classification, 'Other')        AS prod_classification,
    coalesce(h.state_id::text,   'N/A')             AS state_id,
    coalesce(h.district_id::text,'N/A')             AS district_id,
    round(e.pos::numeric, 2)                        AS pos
FROM enriched e
LEFT JOIN hierarchy h ON e.branch_id = h.branch_id
ORDER BY e.business_segment, e.risk_category, e.loan_id;
