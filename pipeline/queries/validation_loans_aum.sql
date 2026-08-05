-- =============================================================================
-- CURRENT OUTSTANDING — loan-grain validation universe.
-- Reproduces EXACTLY the universe of rpt_aum_status (the Current Outstanding
-- report), but one row PER LOAN instead of aggregated, so figures can be diffed
-- against the loandump / Excel loan-by-loan.
--
-- Run against the SOURCE replica (Ananya_app_prod). The {wo_pairs} placeholder
-- is filled by pipeline/materialize_validation_sql.py (the write-off master is in
-- the report DB, not reachable from the replica, so it is baked in as a literal).
--
-- Segment classification, JLG-vs-IL dedupe ("later disbursement wins") and the
-- write-off rule (a write-off applies only if the loan existed when it was
-- written off: disbursement_date <= writeoff_date) are IDENTICAL to aum_status.sql.
-- =============================================================================
WITH
wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date
    FROM (VALUES {wo_pairs}) AS v(loan_id, wo_date)
),

il_loans AS (
    SELECT
        'IL'::text AS loan_source,
        CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
                  OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
                  OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
             THEN 'LAP' ELSE 'IEL' END               AS business_segment,
        la.loan_id,
        la.branch_id,
        la.principal_outstanding::numeric            AS pos,
        la.disbursement_date::date                   AS disb_date,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END              AS raw_status
    FROM public.loan_account_il la
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    WHERE la.status IN ('A', 'D', 'I', 'W')
),

jlg_loans AS (
    SELECT
        'JLG'::text AS loan_source,
        'JLG'::text AS business_segment,
        la.loan_id,
        cm.branch_id,
        la.prin_os::numeric                          AS pos,
        la.disbursement_date::date                   AS disb_date,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END              AS raw_status
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    WHERE la.status IN ('A', 'D', 'I', 'W')
      AND (la.status <> 'W' OR la.prin_os > 0)
      -- later-disbursement-wins: a loan_id present in BOTH books belongs to the
      -- source that disbursed it most recently (JLG customers graduate to IL).
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id = la.loan_id
            AND il.status IN ('A', 'D', 'I', 'W')
            AND il.disbursement_date > la.disbursement_date)
),

all_loans AS (
    SELECT * FROM il_loans
    UNION ALL
    SELECT * FROM jlg_loans
)

SELECT
    loan_id,
    loan_source,
    business_segment,
    branch_id,
    round(pos, 2)                                     AS pos,
    disb_date,
    CASE raw_status WHEN 'A' THEN 'Active'
                    WHEN 'D' THEN 'Death'
                    WHEN 'I' THEN 'Death'
                    WHEN 'W' THEN 'Write-off' END      AS loan_status,
    (raw_status = 'W')                                AS is_writeoff
FROM all_loans
ORDER BY business_segment, loan_id;
