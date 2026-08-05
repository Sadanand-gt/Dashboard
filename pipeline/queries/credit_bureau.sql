-- =============================================================================
-- Report  : Credit Bureau & Sourcing
-- DATABASE: cb_engine  (NOT the core replica) — run via get_cb_engine().
--           The bureau decision engine writes here; the core DB's cb_* tables
--           are empty decoys. See memory: credit-bureau-data-gap.
--
-- Source  : engine_output_master_v2 — one row per bureau pull, 133 columns.
-- Decision: "FINAL RECOMMENDATION" (user-confirmed 2026-08-05) — Approved /
--           Rejected / Referred. NOT "INSTALLMENT AMOUNT DECISION", which is the
--           installment-eligibility sub-decision and does not agree with it.
--
-- Grain   : month x branch x decision x client category.
--           BRANCH here is a branch NAME; the hierarchy lives in the CORE
--           database, so it is joined in pandas by the runner (cross-database).
--           ~94% of pulls match an active branch; the rest fall to 'Unassigned'.
--
-- Ratios are NOT stored — only sums and counts, so any roll-up stays additive.
-- Averages are derived in the backend (e.g. avg lenders = lenders_sum / pulls).
--
-- NOTE the column names: spaces, dots, brackets, and a TRAILING SPACE on
-- "INSTALLMENT AMOUNT ACTIVE [OTHER] ". They must be double-quoted verbatim.
-- =============================================================================

SELECT
    to_char("CREATION DATE", 'YYYY-MM')                       AS pull_month,
    to_char("CREATION DATE", 'YYYY')                          AS pull_year,
    coalesce(nullif(trim("BRANCH"), ''), 'Unassigned')        AS cb_branch,
    coalesce(nullif(trim("CLIENT CATEGORY"), ''), 'Unknown')  AS client_category,
    CASE
        WHEN "FINAL RECOMMENDATION" ILIKE '%approve%' THEN 'Approved'
        WHEN "FINAL RECOMMENDATION" ILIKE '%reject%'  THEN 'Rejected'
        WHEN "FINAL RECOMMENDATION" ILIKE '%refer%'   THEN 'Referred'
        ELSE 'Unknown'
    END                                                       AS decision,

    count(*)                                                              AS pulls,
    -- Decision counts as MEASURES as well as a dimension, so approval rate is
    -- computable at ANY grouping (a ratio built from a group-by key alone is
    -- all-or-nothing within its own group).
    count(*) FILTER (WHERE "FINAL RECOMMENDATION" ILIKE '%approve%')       AS approved_pulls,
    count(*) FILTER (WHERE "FINAL RECOMMENDATION" ILIKE '%reject%')        AS rejected_pulls,
    count(*) FILTER (WHERE "FINAL RECOMMENDATION" ILIKE '%refer%')         AS referred_pulls,

    -- Exposure the applicant already carries with OTHER lenders, by category.
    round(sum(coalesce("MFI OUTSTANDING", 0))::numeric, 2)                AS mfi_outstanding,
    round(sum(coalesce("RETAIL UNSECURED RU OUTSTANDING", 0))::numeric, 2) AS ru_outstanding,
    round(sum(coalesce("RETAIL SECURED RS + LTS OUTSTANDING", 0))::numeric, 2) AS rs_lts_outstanding,
    round(sum(coalesce("TOTAL CONSIDERED OUTSTANDING", 0))::numeric, 2)   AS total_outstanding,
    round(sum(coalesce("TOTAL CONSIDERED OVERDUE", 0))::numeric, 2)       AS total_overdue,

    -- Lender counts: stored as SUMS so any roll-up can divide by pulls.
    sum(coalesce("NO. OF MFI LENDERS", 0))                                AS mfi_lenders_sum,
    sum(coalesce("NO. OF OVERDUE MFI LENDERS", 0))                        AS overdue_mfi_lenders_sum,
    sum(coalesce("NO-OF-OTHER-LENDERS", 0))                               AS other_lenders_sum,
    count(*) FILTER (WHERE coalesce("NO. OF OVERDUE MFI LENDERS", 0) > 0) AS with_overdue_lender,

    -- EMI already committed elsewhere, and monthly income.
    round(sum(coalesce("INSTALLMENT AMOUNT ACTIVE [OTHER] ", 0))::numeric, 2) AS emi_other,
    round(sum(coalesce("TOTAL MONTHLY INCOME", 0))::numeric, 2)           AS monthly_income,
    round(sum(coalesce("MAXIMUM LOAN ELIGIBILITY", 0))::numeric, 2)       AS max_eligibility,

    -- NOTE: the column literally named "FOIR" does NOT hold a ratio — it holds
    -- 'Approve' / 'Refer' (260,345 / 66,680). It is a decision flag under a
    -- misleading name, so it is deliberately NOT read here. The real
    -- obligation-to-income ratio is derived in the backend from the two genuine
    -- numeric columns above: emi_other / monthly_income.
    count(*) FILTER (WHERE coalesce("TOTAL MONTHLY INCOME", 0) > 0)       AS with_income

FROM public.engine_output_master_v2
WHERE "CREATION DATE" IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;
