-- =============================================================================
-- Report  : OTS (One-Time Settlement) — count, settled amount, and the
--           principal / interest waiver split, by hierarchy and settlement bucket.
--
-- Universe (user-confirmed 2026-08-04):
--   a loan is an OTS case when it carries a WAIVER (repayment_detail.waiveoff_amt
--   > 0) AND its reconstructed DPD at the settlement date is > 60 ("OTS is applied
--   on the 60+ bucket"). Settlement date = date of the waiver posting (latest, if
--   waived across several). Measured: 880 of 964 waiver loans (91%) are 60+, and
--   they carry 98% of the waived value — the 60+ rule is borne out by the data.
--
-- HOW THE CORE POSTS AN OTS (established from the data, 2026-08-04):
--   The settlement posting's amount_collected is the FULL amount settled and
--   ALREADY INCLUDES the waived portion; the cash the borrower actually paid is
--   amount_collected - waiveoff_amt. The tell: that difference lands on round
--   numbers (50,000 / 25,000 / 23,000) while the gross does not. So:
--       ots_amount           = amount_collected on the settlement posting
--       net_amount_collected = amount_collected - waiveoff_amt      (real cash)
--   principal_collected / interest_collected likewise include the waived legs,
--   so the NET legs are those minus their waiver.
--
-- Waiver split (user-confirmed): INTEREST FIRST, then principal —
--   due 60,000 (P 40,000 + I 20,000), paid 35,000 -> waiver 25,000
--   -> interest waiver 20,000 + principal waiver 5,000.
--   Reproduced exactly by: int_waiver = LEAST(waiver, interest_collected).
--
-- Bucket (user-confirmed): the DPD bucket AS AT the settlement date, reconstructed
--   from collections STRICTLY BEFORE the settlement receipt — measured after it,
--   every settled loan reads Regular and the dimension carries no information.
--   DPD method: SEPARATE (principal-vs-principal OR interest-vs-interest), the one
--   method used across this dashboard — see report-consistency-rules.
-- =============================================================================

WITH
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. SETTLEMENT POSTINGS — one row per loan (the waiver rows themselves)
-- ─────────────────────────────────────────────────────────────────────────────
waiver_il AS (
    SELECT 'IL'::text                                AS loan_source,
           rd.loan_id,
           max(rd.collection_date_time::date)        AS settle_date,
           sum(coalesce(rd.waiveoff_amt, 0))         AS waiver_amt,
           sum(coalesce(rd.principal_collected, 0))  AS post_prin,
           sum(coalesce(rd.interest_collected, 0))   AS post_int,
           sum(coalesce(rd.amount_collected, 0))     AS post_amt
    FROM public.repayment_detail_il rd
    WHERE rd.status = 'A' AND coalesce(rd.waiveoff_amt, 0) > 0
    GROUP BY rd.loan_id
),
waiver_jlg AS (
    SELECT 'JLG'::text                               AS loan_source,
           rd.loan_id,
           max(rd.collection_date::date)             AS settle_date,
           sum(coalesce(rd.waiveoff_amt, 0))         AS waiver_amt,
           sum(coalesce(rd.principal_collected, 0))  AS post_prin,
           sum(coalesce(rd.interest_collected, 0))   AS post_int,
           sum(coalesce(rd.amount_collected, 0))     AS post_amt
    FROM public.repayment_detail rd
    WHERE rd.status = 'A' AND coalesce(rd.waiveoff_amt, 0) > 0
    GROUP BY rd.loan_id
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. COLLECTED STRICTLY BEFORE THE SETTLEMENT — basis for the settlement bucket
-- ─────────────────────────────────────────────────────────────────────────────
pre_il AS (
    SELECT w.loan_id,
           sum(coalesce(rd.principal_collected, 0)) AS prin_coll,
           sum(coalesce(rd.interest_collected, 0))  AS int_coll
    FROM waiver_il w
    JOIN public.repayment_detail_il rd ON rd.loan_id = w.loan_id
    WHERE rd.status IN ('A', 'V') AND rd.collection_date_time::date < w.settle_date
    GROUP BY w.loan_id
),
pre_jlg AS (
    SELECT w.loan_id,
           sum(coalesce(rd.principal_collected, 0)) AS prin_coll,
           sum(coalesce(rd.interest_collected, 0))  AS int_coll
    FROM waiver_jlg w
    JOIN public.repayment_detail rd ON rd.loan_id = w.loan_id
    WHERE rd.status IN ('A', 'V') AND rd.collection_date::date < w.settle_date
    GROUP BY w.loan_id
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. DPD AS AT THE SETTLEMENT DATE — earliest demand still unpaid immediately
--    before the settlement receipt.
-- ─────────────────────────────────────────────────────────────────────────────
dpd_il AS (
    SELECT w.loan_id, (w.settle_date - min(rs.demand_date::date)) + 1 AS dpd
    FROM waiver_il w
    JOIN public.repayment_schedule_il rs ON rs.loan_id = w.loan_id
    LEFT JOIN pre_il c ON c.loan_id = w.loan_id
    WHERE rs.demand_date::date <= w.settle_date
      AND (rs.cumulative_principal_due > coalesce(c.prin_coll, 0) + 0.005
        OR rs.cumulative_interest_due  > coalesce(c.int_coll, 0)  + 0.005)
    GROUP BY w.loan_id, w.settle_date
),
dpd_jlg AS (
    SELECT w.loan_id, (w.settle_date - min(rs.demand_date::date)) + 1 AS dpd
    FROM waiver_jlg w
    JOIN public.repayment_schedule rs ON rs.loan_id = w.loan_id
    LEFT JOIN pre_jlg c ON c.loan_id = w.loan_id
    WHERE rs.demand_date::date <= w.settle_date
      AND (rs.cumulative_principal_due > coalesce(c.prin_coll, 0) + 0.005
        OR rs.cumulative_interest_due  > coalesce(c.int_coll, 0)  + 0.005)
    GROUP BY w.loan_id, w.settle_date
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. BRANCH HIERARCHY — Zone → Cluster → Region → Unit → Branch
-- ─────────────────────────────────────────────────────────────────────────────
hierarchy AS (
    SELECT bm.branch_id, bm.branch_name, a.area_name,
           reg.branch_name AS region_name, clus.area_name AS cluster_name,
           z.area_name AS zone_name, bm.state_id, bm.district_id
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
    LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id
    WHERE bm.active = 'Y' AND bm.is_region = 'N'
      AND bm.branch_name <> 'DEMO' AND bm.closing_date IS NULL
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. LOAN-LEVEL OTS FACTS
-- ─────────────────────────────────────────────────────────────────────────────
base_il AS (
    SELECT w.loan_source, w.loan_id, w.settle_date, w.waiver_amt,
           w.post_prin, w.post_int, w.post_amt,
           la.branch_id,
           la.loan_officer::varchar                     AS lo_id,
           CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
                  OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
                  OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
                THEN 'LAP' ELSE 'IEL' END               AS business_segment,
           la.product_id::text                          AS product_id,
           coalesce(d.dpd, 0)                           AS settle_dpd
    FROM waiver_il w
    JOIN public.loan_account_il la ON la.loan_id = w.loan_id
    LEFT JOIN dpd_il d ON d.loan_id = w.loan_id
    WHERE la.loan_id >= 10000000
),
base_jlg AS (
    SELECT w.loan_source, w.loan_id, w.settle_date, w.waiver_amt,
           w.post_prin, w.post_int, w.post_amt,
           cm.branch_id,
           cm.assigned_to::varchar                      AS lo_id,
           'JLG'::text                                  AS business_segment,
           la.product_id::text                          AS product_id,
           coalesce(d.dpd, 0)                           AS settle_dpd
    FROM waiver_jlg w
    JOIN public.home_loan_account la  ON la.loan_id   = w.loan_id
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN dpd_jlg d ON d.loan_id = w.loan_id
    WHERE la.loan_id >= 10000000
),
all_ots AS (SELECT * FROM base_il UNION ALL SELECT * FROM base_jlg),

split AS (
    SELECT b.*,
        -- INTEREST FIRST: the waiver clears the interest leg of the settlement
        -- posting in full before any of it touches principal.
        least(b.waiver_amt, b.post_int)                  AS int_waiver,
        greatest(b.waiver_amt - b.post_int, 0)           AS prin_waiver,
        CASE WHEN b.settle_dpd > 360 THEN '360 +'
             WHEN b.settle_dpd > 180 THEN '181 - 360'
             WHEN b.settle_dpd > 90  THEN '91 - 180'
             ELSE                         '61 - 90' END  AS settle_bucket,
        to_char(b.settle_date, 'YYYY')                   AS settle_year,
        to_char(b.settle_date, 'YYYY-MM')                AS settle_month
    FROM all_ots b
    WHERE b.settle_dpd > 60          -- OTS applies to the 60+ bucket only
)

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. FINAL AGGREGATION — one row per dimension combination
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    s.loan_source,
    s.business_segment,
    coalesce(h.zone_name,    'Unassigned')   AS zone_name,
    coalesce(h.cluster_name, 'Unassigned')   AS cluster_name,
    coalesce(h.region_name,  'Unassigned')   AS region_name,
    coalesce(h.area_name,    'Unassigned')   AS area_name,
    coalesce(h.branch_name,  'Unassigned')   AS branch_name,
    s.branch_id,
    coalesce(s.lo_id, 'N/A')                 AS lo_id,
    coalesce(h.state_id::text,    'N/A')     AS state_id,
    coalesce(h.district_id::text, 'N/A')     AS district_id,
    coalesce(s.product_id, 'N/A')            AS product_id,
    s.settle_bucket,
    s.settle_year,
    s.settle_month,

    count(*)                                                     AS ots_count,
    round(sum(s.post_amt)::numeric, 2)                           AS ots_amount,
    round(sum(s.post_prin)::numeric, 2)                          AS principal_collected,
    round(sum(s.post_int)::numeric, 2)                           AS interest_collected,
    round(sum(s.prin_waiver)::numeric, 2)                        AS principal_waiver,
    round(sum(s.int_waiver)::numeric, 2)                         AS interest_waiver,
    round(sum(s.waiver_amt)::numeric, 2)                         AS total_waiver,
    -- NET = what the book actually realised in cash, per leg and overall.
    round(sum(s.post_amt  - s.waiver_amt)::numeric, 2)           AS net_amount_collected,
    round(sum(s.post_prin - s.prin_waiver)::numeric, 2)          AS net_principal,
    round(sum(s.post_int  - s.int_waiver)::numeric, 2)           AS net_interest,
    max(s.settle_date)                                           AS last_settle_date
FROM split s
LEFT JOIN hierarchy h ON h.branch_id = s.branch_id
GROUP BY
    s.loan_source, s.business_segment, h.zone_name, h.cluster_name, h.region_name,
    h.area_name, h.branch_name, s.branch_id, s.lo_id, h.state_id, h.district_id,
    s.product_id, s.settle_bucket, s.settle_year, s.settle_month;
