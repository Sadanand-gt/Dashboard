-- =============================================================================
-- Report  : Write-Off — LOAN GRAIN  ->  rpt_writeoff_loans
--
-- One row per written-off loan. This is the source for BOTH the Write-off page
-- and its loan-wise CSV export, so the two can never disagree: the page
-- aggregates these rows, the export ships them.
--
-- WHY A SECOND TABLE RATHER THAN WIDENING rpt_writeoff
--   rpt_writeoff is aggregated (month x hierarchy x LO x product) and is still
--   read by dashboard/data.py. Leaving it untouched keeps that consumer working,
--   and loan grain is cheap here — the master holds ~30.7k loans, far smaller
--   than the aggregate table's stacked report_days.
--   It also means every new measure the page needs (months on book, recovery hit
--   rate, average ticket) is derivable in pandas WITHOUT further DDL.
--
-- The universe, the dedupe and the recovery rule are IDENTICAL to writeoff.sql —
-- same wo_master, same "incarnation current at write-off", same post-WO
-- collection window. Only the grain differs. If one changes, change both.
--
-- report_day is NOT selected here; pg_write_report_day stamps it on write.
-- =============================================================================

WITH

wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date,
           v.writeoff_amount::numeric AS writeoff_amount
    FROM (VALUES {wo_triples}) AS v(loan_id, wo_date, writeoff_amount)
),

-- product classification (standard slicer; identical to aum_status / aml_loans)
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

hierarchy AS (
    SELECT
        bm.branch_id,
        bm.branch_name,
        a.area_name,
        reg.branch_name AS region_name,
        clus.area_name  AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
    WHERE bm.active = 'Y' AND bm.is_region = 'N'
      AND bm.branch_name <> 'DEMO' AND bm.closing_date IS NULL
),

-- IL incarnation of a master loan that existed at write-off
il_m AS (
    SELECT 'IL'                                  AS loan_source,
        la.loan_id,
        la.branch_id,
        la.loan_officer::varchar                 AS lo_id,
        la.product_id::text                      AS product_id,
        coalesce(ipc.prod_classification, 'Other') AS prod_classification,
        la.disbursement_date::date               AS disb,
        w.wo_date,
        w.writeoff_amount
    FROM wo_master w
    JOIN public.loan_account_il la ON la.loan_id = w.loan_id
    LEFT JOIN il_prod_class ipc ON ipc.product_id = la.product_id::text
    WHERE la.loan_id >= 10000000
      AND la.disbursement_date::date <= w.wo_date
),

-- JLG incarnation of a master loan that existed at write-off
jlg_m AS (
    SELECT 'JLG'                                 AS loan_source,
        la.loan_id,
        cm.branch_id,
        cm.assigned_to::varchar                  AS lo_id,
        la.product_id::text                      AS product_id,
        coalesce(jpc.prod_classification, 'Other') AS prod_classification,
        la.disbursement_date::date               AS disb,
        w.wo_date,
        w.writeoff_amount
    FROM wo_master w
    JOIN public.home_loan_account la  ON la.loan_id  = w.loan_id
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN jlg_prod_class jpc ON jpc.product_id = la.product_id::text
    WHERE la.loan_id >= 10000000
      AND la.disbursement_date::date <= w.wo_date
),

-- ── CORE-FLAGGED WRITE-OFFS NOT IN THE MASTER ───────────────────────────────
-- The master ledger begins Sep-2023. 1,079 loans carry status='W' in core
-- banking from BEFORE that (writeoff_date 2011-03-17 .. 2021-03-31) and every
-- one of them has a writeoff_date, so they can be placed in a year and month
-- exactly like a master loan. Current Outstanding already counts them as
-- Write-off; excluding them here made the two pages disagree.
--
-- The one real difference is the AMOUNT: the master carries an authoritative
-- writeoff_amount, the account table does not. Principal outstanding is used
-- instead and the row is labelled wo_source='Core status W' so the basis is
-- visible in the table and the CSV rather than blended in silently.
core_wo AS (
    SELECT 'IL' AS loan_source, la.loan_id, la.branch_id,
           la.loan_officer::varchar AS lo_id, la.product_id::text AS product_id,
           coalesce(ipc.prod_classification, 'Other') AS prod_classification,
           la.disbursement_date::date AS disb, la.writeoff_date::date AS wo_date,
           coalesce(la.principal_outstanding, 0)::numeric AS writeoff_amount
    FROM public.loan_account_il la
    LEFT JOIN il_prod_class ipc ON ipc.product_id = la.product_id::text
    WHERE la.status = 'W' AND la.loan_id >= 10000000
      AND la.writeoff_date IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM wo_master w WHERE w.loan_id = la.loan_id)
    UNION ALL
    SELECT 'JLG', la.loan_id, cm.branch_id,
           cm.assigned_to::varchar, la.product_id::text,
           coalesce(jpc.prod_classification, 'Other'),
           la.disbursement_date::date, la.writeoff_date::date,
           coalesce(la.prin_os, 0)::numeric
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN jlg_prod_class jpc ON jpc.product_id = la.product_id::text
    WHERE la.status = 'W' AND la.loan_id >= 10000000
      AND la.writeoff_date IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM wo_master w WHERE w.loan_id = la.loan_id)
),

-- One row per written-off loan: the incarnation current at write-off
all_wo AS (
    SELECT DISTINCT ON (loan_id)
        loan_source, loan_id, branch_id, lo_id, product_id, prod_classification, disb,
        wo_date, writeoff_amount, wo_source
    FROM (SELECT *, 'Master'::text AS wo_source FROM il_m
          UNION ALL SELECT *, 'Master'::text FROM jlg_m
          UNION ALL SELECT *, 'Core status W'::text FROM core_wo) u
    ORDER BY loan_id, disb DESC
),

-- Post-write-off recovery: status-A collections AFTER this loan's own wo_date,
-- read from the kept incarnation's repayment table.
il_recovery AS (
    SELECT rd.loan_id, sum(rd.amount_collected) AS recovery_amount,
           max(rd.collection_date_time::date)   AS last_recovery_date,
           -- collected THIS calendar month, anchored on T-1 like every other
           -- period measure in the dashboard
           sum(rd.amount_collected) FILTER (
               WHERE rd.collection_date_time::date
                     >= date_trunc('month', current_date - 1)::date
                 AND rd.collection_date_time::date <= current_date - 1)
                                                AS recovery_mtd
    FROM public.repayment_detail_il rd
    JOIN all_wo w ON w.loan_id = rd.loan_id AND w.loan_source = 'IL'
    WHERE rd.status = 'A'
      AND rd.collection_date_time::date > w.wo_date
    GROUP BY rd.loan_id
),
jlg_recovery AS (
    SELECT rd.loan_id, sum(rd.amount_collected) AS recovery_amount,
           max(rd.collection_date::date)        AS last_recovery_date,
           sum(rd.amount_collected) FILTER (
               WHERE rd.collection_date::date
                     >= date_trunc('month', current_date - 1)::date
                 AND rd.collection_date::date <= current_date - 1)
                                                AS recovery_mtd
    FROM public.repayment_detail rd
    JOIN all_wo w ON w.loan_id = rd.loan_id AND w.loan_source = 'JLG'
    WHERE rd.status = 'A'
      AND rd.collection_date::date > w.wo_date
    GROUP BY rd.loan_id
),
all_recovery AS (
    SELECT loan_id, recovery_amount, last_recovery_date, recovery_mtd FROM il_recovery
    UNION ALL
    SELECT loan_id, recovery_amount, last_recovery_date, recovery_mtd FROM jlg_recovery
)

SELECT
    (current_date - 1)                     AS data_date,

    wo.loan_id,
    wo.loan_source,
    -- Real business segment, same rule the SQL layer uses elsewhere:
    -- JLG by source; SUGAM / UDYOGINI / SECURED products are LAP; rest IEL.
    CASE WHEN wo.loan_source = 'JLG' THEN 'JLG'
         WHEN upper(wo.product_id) LIKE '%SUGAM%'
           OR upper(wo.product_id) LIKE '%UDYOGINI%'
           OR upper(wo.product_id) LIKE '%SECURED%' THEN 'LAP'
         ELSE 'IEL' END                    AS business_segment,
    coalesce(wo.product_id, 'N/A')         AS product_id,
    coalesce(wo.prod_classification, 'Other') AS prod_classification,
    wo.wo_source,

    wo.wo_date                             AS writeoff_date,
    to_char(wo.wo_date, 'YYYY-MM')         AS writeoff_month,
    to_char(wo.wo_date, 'YYYY')            AS writeoff_year,
    -- Financial year runs Apr-Mar, so a Jan-Mar write-off belongs to the FY that
    -- STARTED the previous April.
    CASE WHEN extract(month FROM wo.wo_date) >= 4
         THEN to_char(wo.wo_date, 'YYYY') || '-' ||
              to_char(wo.wo_date + interval '1 year', 'YY')
         ELSE to_char(wo.wo_date - interval '1 year', 'YYYY') || '-' ||
              to_char(wo.wo_date, 'YY')
    END                                    AS writeoff_fy,

    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    wo.branch_id,
    coalesce(wo.lo_id, 'N/A')              AS lo_id,

    wo.disb                                AS disbursement_date,
    -- Whole months from disbursement to write-off. The vintage view: a book
    -- writing off at 8 months is failing far earlier than one writing off at 30.
    (extract(year  FROM age(wo.wo_date, wo.disb)) * 12
   + extract(month FROM age(wo.wo_date, wo.disb)))::int
                                           AS months_on_book,

    -- writeoff_count is stored as a literal 1 so the summary framework can sum
    -- it like any other measure without special-casing loan grain.
    1                                      AS writeoff_count,
    round(wo.writeoff_amount::numeric, 2)  AS writeoff_amount,
    round(coalesce(rec.recovery_amount, 0)::numeric, 2)
                                           AS recovery_amount,
    round(coalesce(rec.recovery_mtd, 0)::numeric, 2)
                                           AS recovery_mtd,
    round((wo.writeoff_amount - coalesce(rec.recovery_amount, 0))::numeric, 2)
                                           AS net_credit_loss,
    -- Recovery HIT RATE numerator: how many written-off loans repaid anything at
    -- all. Distinct from recovery %, which is a value ratio — a book can recover
    -- a large amount from very few accounts, and the two together say which.
    CASE WHEN coalesce(rec.recovery_amount, 0) > 0 THEN 1 ELSE 0 END
                                           AS recovered_count,
    rec.last_recovery_date

FROM all_wo wo
LEFT JOIN all_recovery rec ON rec.loan_id = wo.loan_id
LEFT JOIN hierarchy    h   ON h.branch_id = wo.branch_id
ORDER BY wo.wo_date DESC, wo.loan_id;
