-- =============================================================================
-- Report  : Daily disbursement history (feeds the Disbursement trend "Day" view)
-- Grain   : one row per disbursement_date (portfolio-wide, IL + JLG combined)
-- Window  : full history → T-1 (warehouse holds data only through yesterday)
-- Status  : A=Active, X=Closed (same universe as rpt_disbursement)
-- =============================================================================

WITH il AS (
    SELECT
        la.disbursement_date::date       AS d,
        count(*)                          AS n,
        sum(la.total_loan_amount)         AS amt
    FROM public.loan_account_il la
    WHERE la.status IN ('A', 'X')
      AND la.disbursement_date IS NOT NULL
    GROUP BY la.disbursement_date::date
),
jlg AS (
    SELECT
        hla.disbursement_date::date      AS d,
        count(*)                          AS n,
        sum(hla.total_loan_amount)        AS amt
    FROM public.home_loan_account hla
    WHERE hla.status IN ('A', 'X')
      AND hla.disbursement_date IS NOT NULL
    GROUP BY hla.disbursement_date::date
)
SELECT
    coalesce(il.d, jlg.d)                             AS disb_date,
    coalesce(il.n, 0)  + coalesce(jlg.n, 0)           AS disb_count,
    round((coalesce(il.amt, 0) + coalesce(jlg.amt, 0))::numeric, 2) AS disb_amount
FROM il
FULL OUTER JOIN jlg ON jlg.d = il.d
WHERE coalesce(il.d, jlg.d) <= current_date - 1
ORDER BY 1;
