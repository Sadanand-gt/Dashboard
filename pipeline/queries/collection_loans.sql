-- =============================================================================
-- Collection — LOAN GRAIN  ->  rpt_collection_loans
--
-- One row per loan with a T-1 or MTD demand OR receipt. Feeds the loan-wise CSV
-- export on the T-1 and MTD Collection pages, and the loan_id lookup.
--
--   RECONCILIATION — must hold after every run:
--     sum(ftod_flag)      = rpt_collection.mtd_ftod
--     sum(t1_ontime)      = rpt_collection.t1_ontime
--     sum(mtd_collection) = rpt_collection.mtd_collection
--
-- MEASURE NOTES — do not re-derive downstream:
--   t1_ontime  CAPPED per loan: least(t1_collection, t1_demand). Total collection
--     includes arrears against older dues, which is why the uncapped
--     t1_collection / t1_demand read 110.15% on 2026-08-13.
--   mtd_ontime  TIMING measure (receipts on/before the loan's last MTD demand
--     date) that is now ALSO CAPPED per loan at that loan's own demand, matching
--     t1_ontime. Before the cap it exceeded demand on 1,723 loans (Rs 52.4 L) and
--     pushed branch-level MTD OTRR over 100% — 5 branches, max 103.40%.
--     It is NOT least(mtd_collection, mtd_demand): that is the capped CE (93.22%)
--     and would count loans paying AFTER their due date as on-time.
--   ftod_flag  first-time OD AND not written off, so it agrees with the OD
--     Status matrix by construction.
--
-- The CTE block below is GENERATED from collection_fact.sql. See gen_loan_grain.py.
-- report_day is NOT selected here; pg_write_report_day stamps it on write.
-- =============================================================================
-- =============================================================================
-- Report  : Collection Efficiency fact (feeds BOTH "T-1 Collection" & "MTD Collection")
-- Grain   : one row per unique combination of all analysis-parameter dimensions
--           (aggregated from loan level).  Both pages read this single table.
--
-- Periods (anchored on T-1 = yesterday, matching the .pbit TODAY()-1 logic):
--   T-1  : demand & collection on the single day  yesterday
--   MTD  : demand & collection  1st-of-current-month → yesterday
--   PMSD : previous month SAME DAY (single day)      → T-1 comparison
--   PMTD : previous month TO DATE (1st → same day)   → MTD comparison
--   (PMSD/PMTD always reference the previous month — e.g. July report → June)
--
-- Metrics per group — RAW & manually verifiable:
--   *_demand      = SUM(total_amt_due)     WHERE demand_date in period
--   *_collection  = SUM(amount_collected)  WHERE status='A' AND collection date in period
--   *_demand_count= # loans with demand in the period (t1 / mtd)
--   CE% (backend) = collection / demand (.pbit DIVIDE, uncapped)
--   mtd_ontime    = collections on/before the loan's latest MTD demand date (→ OTRR%, unchanged)
--   ftod          = First-Time OD count (eom_dpd = 0 AND live dpd > 0) (unchanged)
-- Universe: ALL loans in the loan-account tables (incl. closed), no dedup —
--   so grand totals equal the raw table sums exactly.
--
-- Dimensions (same universe/attributes as Current Outstanding):
--   business_segment, loan_source, geography (zone→branch, state, district),
--   prod_classification, curr_od_status, dpd_bucket, bucket_movement, loan_status,
--   cycle_no, disb_year, purpose_id, facility_id, lender_id, caste, religion
--
-- DPD (identical convention to aum_status.sql):
--   live dpd  = la.dpd            → curr_od_status, dpd_bucket
--   eom_dpd   = computed @ prev_month_end
--   bucket_movement = live dpd vs eom_dpd (current movement, per Excel)
-- =============================================================================

WITH
-- Write-off master, matched on loan_id AND date. loan_id is NOT unique across
-- sources: every IL loan here also exists in JLG with an earlier disbursement
-- (customers graduate JLG -> IL). Matching on loan_id alone wrongly kills a
-- brand-new IL loan whose id was written off in its earlier JLG life, so a
-- write-off may only apply to a loan that already existed when it was written
-- off. A NULL writeoff_date falls back to id-only matching.
wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date
    FROM (VALUES {wo_pairs}) AS v(loan_id, wo_date)
),
-- T-1 = current_date - 1 (matches the .pbit TODAY()-1). If collection data for T-1
-- is not yet loaded that is a warehouse/DBA data-freshness issue, not a report-logic
-- one — the logic here is not adjusted for it.  Advance collection is handled per the
-- .pbit [Collection] measure (per-loan opening advance + cap) in il_base / jlg_base.
ref AS (
    SELECT
        (current_date - interval '1 day')::date                                            AS yesterday,
        date_trunc('month', current_date - 1)::date                                            AS curr_month_start,
        (date_trunc('month', current_date - 1) - interval '1 day')::date                       AS prev_month_end,
        date_trunc('month', current_date - 1 - interval '1 month')::date                       AS prev_month_start,
        (date_trunc('month', current_date - 1 - interval '1 month') - interval '1 day')::date  AS prev_prev_month_end,
        -- PMSD cutoff: same day-of-month last month, capped at prev_month_end
        LEAST(
            (date_trunc('month', current_date - 1 - interval '1 month')
             + (extract(day from current_date - interval '1 day')::int - 1) * interval '1 day')::date,
            (date_trunc('month', current_date - 1) - interval '1 day')::date
        )                                                                                  AS pmsd_cutoff
),

-- ─────────────────────────────────────────────────────────────────────────────
-- BRANCH HIERARCHY — Zone → Cluster → Region → Unit → Branch
-- ─────────────────────────────────────────────────────────────────────────────
hierarchy AS (
    SELECT
        bm.branch_id, bm.branch_name,
        a.area_id, a.area_name,
        reg.branch_id   AS region_id,  reg.branch_name AS region_name,
        clus.area_id    AS cluster_id, clus.area_name  AS cluster_name,
        z.area_id       AS zone_id,    z.area_name      AS zone_name,
        bm.state_id, bm.district_id
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
    LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id
    WHERE bm.active = 'Y' AND bm.is_region = 'N'
      AND bm.branch_name <> 'DEMO' AND bm.closing_date IS NULL
),

-- ═════════════════════════════════════════════════════════════════════════════
-- EOM DPD (as of prev_month_end)  — ported from aum_status.sql
-- ═════════════════════════════════════════════════════════════════════════════
il_rd AS (
    SELECT loan_id, principal_collected, interest_collected
    FROM public.repayment_detail_il
    WHERE collection_date_time < (SELECT curr_month_start FROM ref) AND status IN ('A','V')
),
il_ars AS (
    SELECT rs.loan_id, rs.demand_date,
        CASE WHEN sum(rd.principal_collected) IS NULL THEN rs.cumulative_principal_due
             WHEN sum(rd.principal_collected) < rs.cumulative_principal_due
                  THEN rs.cumulative_principal_due - sum(rd.principal_collected) ELSE 0 END AS od_principal,
        CASE WHEN sum(rd.interest_collected) IS NULL THEN rs.cumulative_interest_due
             WHEN sum(rd.interest_collected) < rs.cumulative_interest_due
                  THEN rs.cumulative_interest_due - sum(rd.interest_collected) ELSE 0 END AS od_interest
    FROM public.loan_account_il la
    JOIN public.repayment_schedule_il rs ON rs.loan_id = la.loan_id
    LEFT JOIN il_rd rd ON rd.loan_id = rs.loan_id
    WHERE (
        (la.status = 'W' AND la.closure_date::date > DATE '2025-03-30')
        OR (la.closure_type = 'W' AND la.last_collection_date::date > (SELECT prev_month_end FROM ref))
        OR la.status IN ('D','I')
        OR ((la.closure_date IS NULL OR la.closure_date::date > (SELECT prev_month_end FROM ref))
            AND rs.demand_date::date <= (SELECT prev_month_end FROM ref))
    )
    GROUP BY rs.loan_id, rs.demand_date, rs.cumulative_principal_due, rs.cumulative_interest_due
),
il_dpd AS (
    SELECT loan_id,
        CASE WHEN min(demand_date) IS NULL THEN 0
             WHEN min(demand_date)::date > (SELECT prev_month_end FROM ref) THEN 0
             ELSE ((SELECT prev_month_end FROM ref) - min(demand_date)::date) + 1 END AS dpd
    FROM il_ars WHERE od_principal > 0 OR od_interest > 0 GROUP BY loan_id
),
jlg_rd AS (
    SELECT loan_id, principal_collected, interest_collected
    FROM public.repayment_detail
    WHERE collection_date::date < (SELECT curr_month_start FROM ref) AND status IN ('A','V')
),
jlg_ars AS (
    SELECT rs.loan_id, rs.demand_date,
        CASE WHEN sum(rd.principal_collected) IS NULL THEN rs.cumulative_principal_due
             WHEN sum(rd.principal_collected) < rs.cumulative_principal_due
                  THEN rs.cumulative_principal_due - sum(rd.principal_collected) ELSE 0 END AS od_principal,
        CASE WHEN sum(rd.interest_collected) IS NULL THEN rs.cumulative_interest_due
             WHEN sum(rd.interest_collected) < rs.cumulative_interest_due
                  THEN rs.cumulative_interest_due - sum(rd.interest_collected) ELSE 0 END AS od_interest
    FROM public.home_loan_account la
    JOIN public.repayment_schedule rs ON rs.loan_id = la.loan_id
    LEFT JOIN jlg_rd rd ON rd.loan_id = rs.loan_id
    WHERE (
        (la.status = 'W' AND la.closure_date::date > DATE '2025-03-30')
        OR (la.closure_type = 'W' AND la.last_collection_date::date > (SELECT prev_month_end FROM ref))
        OR la.status IN ('D','I')
        OR ((la.closure_date IS NULL OR la.closure_date::date > (SELECT prev_month_end FROM ref))
            AND rs.demand_date::date <= (SELECT prev_month_end FROM ref))
    )
    GROUP BY rs.loan_id, rs.demand_date, rs.cumulative_principal_due, rs.cumulative_interest_due
),
jlg_dpd AS (
    SELECT loan_id,
        CASE WHEN min(demand_date) IS NULL THEN 0
             WHEN min(demand_date)::date > (SELECT prev_month_end FROM ref) THEN 0
             ELSE ((SELECT prev_month_end FROM ref) - min(demand_date)::date) + 1 END AS dpd
    FROM jlg_ars WHERE od_principal > 0 OR od_interest > 0 GROUP BY loan_id
),

-- ─────────────────────────────────────────────────────────────────────────────
-- PRODUCT CLASSIFICATION + DEMOGRAPHIC LOOKUPS  (same as disbursement/aum)
-- ─────────────────────────────────────────────────────────────────────────────
prod_class AS (
    SELECT 'IL'  AS loan_source, lp.product_id::text AS product_id,
           coalesce(pc.product_classification,'Other') AS prod_classification
    FROM public.loan_product_il lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
    UNION ALL
    SELECT 'JLG' AS loan_source, lp.product_id::text AS product_id,
           coalesce(pc.product_classification,'Other') AS prod_classification
    FROM public.loan_product lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),
loan_extra AS (
    (
        SELECT DISTINCT ON (la.loan_id)
            'IL' AS loan_source, la.loan_id,
            coalesce(la.cycle::text,'N/A')       AS cycle_no,
            coalesce(la.purpose_id::text,'N/A')  AS purpose_id,
            coalesce(la.facility_id::text,'N/A') AS facility_id,
            coalesce(la.lender_id::text,'N/A')   AS lender_id,
            coalesce(cci.caste,'N/A')            AS caste,
            coalesce(cci.religion,'N/A')         AS religion
        FROM public.loan_account_il la
        LEFT JOIN public.customer_contacts_il cci ON cci.loan_id = la.loan_id
        ORDER BY la.loan_id
    )
    UNION ALL
    (
        SELECT DISTINCT ON (hla.loan_id)
            'JLG' AS loan_source, hla.loan_id,
            coalesce(hla.cycle::text,'N/A')       AS cycle_no,
            coalesce(hla.purpose_id::text,'N/A')  AS purpose_id,
            coalesce(hla.facility_id::text,'N/A') AS facility_id,
            'N/A'::text                            AS lender_id,
            coalesce(hbm.caste,'N/A')             AS caste,
            coalesce(hbm.religion,'N/A')          AS religion
        FROM public.home_loan_account hla
        LEFT JOIN public.home_brrwr_misc hbm ON hbm.cust_id = hla.cust_id
        ORDER BY hla.loan_id
    )
),

-- ═════════════════════════════════════════════════════════════════════════════
-- COLLECTION METRIC CTEs  (per loan)  — one scan per table via FILTER aggregation
--   sched: T-1 / MTD / PMSD demand + last MTD due date + opening advance
--   detail: T-1 / MTD / PMSD collection + on-time (receipts on/before last due)
-- ═════════════════════════════════════════════════════════════════════════════

-- Closure-date lookup (one row per loan) — for the .pbit "mtd demand col" filter:
-- a demand counts only if the loan was not closed before that demand date.
il_closure AS (
    SELECT DISTINCT ON (loan_id) loan_id, closure_date
    FROM public.loan_account_il ORDER BY loan_id, disbursement_date DESC
),
jlg_closure AS (
    SELECT DISTINCT ON (loan_id) loan_id, closure_date
    FROM public.home_loan_account ORDER BY loan_id, disbursement_date DESC
),

-- IL ── schedule metrics (single scan)
--   .pbit MTD Demand / Demand till PMSD apply a closure filter
--     (closure_date IS NULL OR closure_date >= demand_date); T-1 & single-day
--     PMSD demand do NOT (matches [total due amount] / [Demand PMSD]).
--   PMSD = previous month SAME DAY (single day)     → T-1 comparison
--   PMTD = previous month TO DATE (1st → same day)  → MTD comparison
il_sched AS (
    SELECT rs.loan_id,
        sum(rs.total_amt_due) FILTER (WHERE rs.demand_date::date = r.yesterday)                                              AS t1_demand,
        sum(rs.total_amt_due) FILTER (WHERE rs.demand_date::date > r.prev_month_end AND rs.demand_date::date <= r.yesterday
             AND (lc.closure_date IS NULL OR lc.closure_date::date >= rs.demand_date::date))                                 AS mtd_demand,
        max(rs.demand_date::date) FILTER (WHERE rs.demand_date::date > r.prev_month_end AND rs.demand_date::date <= r.yesterday) AS last_due,
        sum(rs.total_amt_due) FILTER (WHERE rs.demand_date::date = r.pmsd_cutoff)                                             AS pmsd_demand,
        sum(rs.total_amt_due) FILTER (WHERE rs.demand_date::date >= r.prev_month_start AND rs.demand_date::date <= r.pmsd_cutoff
             AND (lc.closure_date IS NULL OR lc.closure_date::date >= rs.demand_date::date))                                 AS pmtd_demand,
        -- .pbit CE numerator support: per-loan cap demand (principal_due+interest_due =
        -- [Demand MTD calc]) and opening principal/interest due up to prev month-end.
        sum(rs.principal_due + rs.interest_due) FILTER (WHERE rs.demand_date::date > r.prev_month_end AND rs.demand_date::date <= r.yesterday
             AND (lc.closure_date IS NULL OR lc.closure_date::date >= rs.demand_date::date))                                 AS cap_demand_mtd,
        sum(rs.principal_due) FILTER (WHERE rs.demand_date::date <= r.prev_month_end)                                        AS prin_due_eom,
        sum(rs.interest_due)  FILTER (WHERE rs.demand_date::date <= r.prev_month_end)                                        AS int_due_eom,
        -- PMTD mirrors of the MTD cap / opening-advance inputs, shifted one month,
        -- so PMTD CE is built the SAME way as MTD CE (see il_base.pmtd_collection).
        sum(rs.principal_due + rs.interest_due) FILTER (WHERE rs.demand_date::date >= r.prev_month_start AND rs.demand_date::date <= r.pmsd_cutoff
             AND (lc.closure_date IS NULL OR lc.closure_date::date >= rs.demand_date::date))                                 AS cap_demand_pmtd,
        sum(rs.principal_due) FILTER (WHERE rs.demand_date::date <= r.prev_prev_month_end)                                   AS prin_due_ppm,
        sum(rs.interest_due)  FILTER (WHERE rs.demand_date::date <= r.prev_prev_month_end)                                   AS int_due_ppm
    FROM public.repayment_schedule_il rs
    CROSS JOIN ref r
    LEFT JOIN il_closure lc ON lc.loan_id = rs.loan_id
    GROUP BY rs.loan_id
),
-- IL ── detail metrics (single scan, joins sched for on-time cutoff)
il_detail AS (
    SELECT rd.loan_id,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date = r.yesterday)                                            AS t1_collection,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date > r.prev_month_end AND rd.collection_date_time::date <= r.yesterday) AS mtd_collection,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date > r.prev_month_end AND rd.collection_date_time::date <= s.last_due)  AS mtd_ontime,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date = r.pmsd_cutoff)                                          AS pmsd_collection,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date >= r.prev_month_start AND rd.collection_date_time::date <= r.pmsd_cutoff) AS pmtd_collection,
        -- .pbit CE numerator support: MTD principal+interest collection ([Collection MTD])
        -- and principal/interest collected up to prev month-end (opening advance).
        sum(rd.principal_collected + rd.interest_collected) FILTER (WHERE rd.collection_date_time::date > r.prev_month_end AND rd.collection_date_time::date <= r.yesterday) AS mtd_coll_pi,
        sum(rd.principal_collected) FILTER (WHERE rd.collection_date_time::date <= r.prev_month_end)                                    AS prin_coll_eom,
        sum(rd.interest_collected)  FILTER (WHERE rd.collection_date_time::date <= r.prev_month_end)                                    AS int_coll_eom,
        -- PMTD mirrors of the MTD numerator inputs, shifted one month.
        sum(rd.principal_collected + rd.interest_collected) FILTER (WHERE rd.collection_date_time::date >= r.prev_month_start AND rd.collection_date_time::date <= r.pmsd_cutoff) AS pmtd_coll_pi,
        sum(rd.principal_collected) FILTER (WHERE rd.collection_date_time::date <= r.prev_prev_month_end)                               AS prin_coll_ppm,
        sum(rd.interest_collected)  FILTER (WHERE rd.collection_date_time::date <= r.prev_prev_month_end)                               AS int_coll_ppm
    FROM public.repayment_detail_il rd
    CROSS JOIN ref r
    LEFT JOIN il_sched s ON s.loan_id = rd.loan_id
    WHERE rd.status='A'
    GROUP BY rd.loan_id
),

-- JLG ── schedule metrics (single scan)
jlg_sched AS (
    SELECT rs.loan_id,
        sum(rs.total_amt_due) FILTER (WHERE rs.demand_date::date = r.yesterday)                                              AS t1_demand,
        sum(rs.total_amt_due) FILTER (WHERE rs.demand_date::date > r.prev_month_end AND rs.demand_date::date <= r.yesterday
             AND (lc.closure_date IS NULL OR lc.closure_date::date >= rs.demand_date::date))                                 AS mtd_demand,
        max(rs.demand_date::date) FILTER (WHERE rs.demand_date::date > r.prev_month_end AND rs.demand_date::date <= r.yesterday) AS last_due,
        sum(rs.total_amt_due) FILTER (WHERE rs.demand_date::date = r.pmsd_cutoff)                                             AS pmsd_demand,
        sum(rs.total_amt_due) FILTER (WHERE rs.demand_date::date >= r.prev_month_start AND rs.demand_date::date <= r.pmsd_cutoff
             AND (lc.closure_date IS NULL OR lc.closure_date::date >= rs.demand_date::date))                                 AS pmtd_demand,
        sum(rs.principal_due + rs.interest_due) FILTER (WHERE rs.demand_date::date > r.prev_month_end AND rs.demand_date::date <= r.yesterday
             AND (lc.closure_date IS NULL OR lc.closure_date::date >= rs.demand_date::date))                                 AS cap_demand_mtd,
        sum(rs.principal_due) FILTER (WHERE rs.demand_date::date <= r.prev_month_end)                                        AS prin_due_eom,
        sum(rs.interest_due)  FILTER (WHERE rs.demand_date::date <= r.prev_month_end)                                        AS int_due_eom,
        -- PMTD mirrors — see the IL block above.
        sum(rs.principal_due + rs.interest_due) FILTER (WHERE rs.demand_date::date >= r.prev_month_start AND rs.demand_date::date <= r.pmsd_cutoff
             AND (lc.closure_date IS NULL OR lc.closure_date::date >= rs.demand_date::date))                                 AS cap_demand_pmtd,
        sum(rs.principal_due) FILTER (WHERE rs.demand_date::date <= r.prev_prev_month_end)                                   AS prin_due_ppm,
        sum(rs.interest_due)  FILTER (WHERE rs.demand_date::date <= r.prev_prev_month_end)                                   AS int_due_ppm
    FROM public.repayment_schedule rs
    CROSS JOIN ref r
    LEFT JOIN jlg_closure lc ON lc.loan_id = rs.loan_id
    GROUP BY rs.loan_id
),
-- JLG ── detail metrics (single scan)
jlg_detail AS (
    SELECT rd.loan_id,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date = r.yesterday)                                            AS t1_collection,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date > r.prev_month_end AND rd.collection_date_time::date <= r.yesterday) AS mtd_collection,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date > r.prev_month_end AND rd.collection_date_time::date <= s.last_due)  AS mtd_ontime,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date = r.pmsd_cutoff)                                          AS pmsd_collection,
        sum(rd.amount_collected) FILTER (WHERE rd.collection_date_time::date >= r.prev_month_start AND rd.collection_date_time::date <= r.pmsd_cutoff) AS pmtd_collection,
        sum(rd.principal_collected + rd.interest_collected) FILTER (WHERE rd.collection_date_time::date > r.prev_month_end AND rd.collection_date_time::date <= r.yesterday) AS mtd_coll_pi,
        sum(rd.principal_collected) FILTER (WHERE rd.collection_date_time::date <= r.prev_month_end)                                    AS prin_coll_eom,
        sum(rd.interest_collected)  FILTER (WHERE rd.collection_date_time::date <= r.prev_month_end)                                    AS int_coll_eom,
        -- PMTD mirrors — see the IL block above.
        sum(rd.principal_collected + rd.interest_collected) FILTER (WHERE rd.collection_date_time::date >= r.prev_month_start AND rd.collection_date_time::date <= r.pmsd_cutoff) AS pmtd_coll_pi,
        sum(rd.principal_collected) FILTER (WHERE rd.collection_date_time::date <= r.prev_prev_month_end)                               AS prin_coll_ppm,
        sum(rd.interest_collected)  FILTER (WHERE rd.collection_date_time::date <= r.prev_prev_month_end)                               AS int_coll_ppm
    FROM public.repayment_detail rd
    CROSS JOIN ref r
    LEFT JOIN jlg_sched s ON s.loan_id = rd.loan_id
    WHERE rd.status='A'
    GROUP BY rd.loan_id
),

-- ═════════════════════════════════════════════════════════════════════════════
-- BASE LOAN ROWS — dims + per-loan metrics (IL then JLG)
-- ═════════════════════════════════════════════════════════════════════════════
il_base AS (
    SELECT
        'IL' AS loan_source,
        CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
               OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
               OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
             THEN 'LAP' ELSE 'IEL' END               AS business_segment,
        la.loan_id, la.branch_id,
        la.loan_officer::varchar                      AS lo_id,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END              AS raw_status,
        coalesce(la.dpd,0)                            AS live_dpd,
        coalesce(d.dpd,0)                             AS eom_dpd,
        coalesce(ipc.prod_classification,'Other')     AS prod_classification,
        ex.cycle_no, ex.purpose_id, ex.facility_id, ex.lender_id, ex.caste, ex.religion,
        extract(year FROM la.disbursement_date)::text AS disb_year,
        -- RAW day / period sums — each verifiable against the tables directly
        coalesce(s.t1_demand,0)       AS t1_demand,
        coalesce(dt.t1_collection,0)  AS t1_collection,
        coalesce(s.mtd_demand,0)      AS mtd_demand,
        -- .pbit [Collection] = MIN( MTD prin+int collection + opening advance,
        -- [Demand MTD calc] ) per loan.  Opening advance = excess of collection over
        -- demand up to prev month-end, taken separately for principal and interest.
        LEAST(
            coalesce(dt.mtd_coll_pi,0)
              + greatest(coalesce(dt.prin_coll_eom,0) - coalesce(s.prin_due_eom,0), 0)
              + greatest(coalesce(dt.int_coll_eom,0)  - coalesce(s.int_due_eom,0),  0),
            coalesce(s.cap_demand_mtd,0)
        )                              AS mtd_collection,
        -- CAPPED PER LOAN at that loan's own MTD demand, matching t1_ontime.
        -- dt.mtd_ontime is a TIMING measure (receipts on/before the loan's last
        -- MTD demand date), so a borrower clearing arrears plus the current
        -- instalment before the due date produced more "on-time" than was due:
        -- 1,723 loans, Rs 52.4 L excess on 2026-08-20, which pushed branch-level
        -- MTD OTRR over 100% (5 branches, max 103.40%) — the same defect the
        -- uncapped t1 numerator had at 110.15%.
        -- The cap keeps the ON-TIME meaning (late payers are still excluded) and
        -- only bounds it. It is deliberately NOT least(mtd_collection, mtd_demand):
        -- that is the capped CE (93.22%) and would count 6,584 loans that paid
        -- AFTER their due date as on-time, collapsing OTRR into CE.
        LEAST(coalesce(dt.mtd_ontime,0), coalesce(s.mtd_demand,0)) AS mtd_ontime,
        coalesce(s.pmsd_demand,0)      AS pmsd_demand,
        coalesce(dt.pmsd_collection,0) AS pmsd_collection,
        coalesce(s.pmtd_demand,0)      AS pmtd_demand,
        -- PMTD collection built the SAME way as mtd_collection above (.pbit
        -- [Collection], shifted one month): per-loan LEAST(P+I collected in the
        -- PMTD window + opening advance as at prev-prev month-end, capped demand).
        -- It used to be the RAW amount_collected sum — uncapped, no advance, and
        -- including charges — so PMTD CE was structurally higher than MTD CE and
        -- the two were not comparable (97.70% vs 90.05% on 2026-08-04).
        LEAST(
            coalesce(dt.pmtd_coll_pi,0)
              + greatest(coalesce(dt.prin_coll_ppm,0) - coalesce(s.prin_due_ppm,0), 0)
              + greatest(coalesce(dt.int_coll_ppm,0)  - coalesce(s.int_due_ppm,0),  0),
            coalesce(s.cap_demand_pmtd,0)
        )                              AS pmtd_collection
    FROM public.loan_account_il la
    LEFT JOIN il_dpd d      ON d.loan_id  = la.loan_id
    LEFT JOIN prod_class ipc ON ipc.loan_source='IL' AND ipc.product_id = la.product_id::text
    LEFT JOIN loan_extra ex ON ex.loan_source='IL' AND ex.loan_id = la.loan_id
    LEFT JOIN il_sched  s  ON s.loan_id  = la.loan_id
    LEFT JOIN il_detail dt ON dt.loan_id = la.loan_id
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    WHERE la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND (coalesce(s.t1_demand,0)+coalesce(s.mtd_demand,0)+coalesce(s.pmtd_demand,0)
          +coalesce(dt.t1_collection,0)+coalesce(dt.mtd_collection,0)+coalesce(dt.pmtd_collection,0)) > 0
),
jlg_base AS (
    SELECT
        'JLG' AS loan_source, 'JLG' AS business_segment,
        la.loan_id, cm.branch_id,
        cm.assigned_to::varchar                       AS lo_id,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END              AS raw_status,
        coalesce(la.dpd,0)                            AS live_dpd,
        coalesce(d.dpd,0)                             AS eom_dpd,
        coalesce(jpc.prod_classification,'Other')     AS prod_classification,
        ex.cycle_no, ex.purpose_id, ex.facility_id, ex.lender_id, ex.caste, ex.religion,
        extract(year FROM la.disbursement_date)::text AS disb_year,
        -- RAW day / period sums — each verifiable against the tables directly
        coalesce(s.t1_demand,0)       AS t1_demand,
        coalesce(dt.t1_collection,0)  AS t1_collection,
        coalesce(s.mtd_demand,0)      AS mtd_demand,
        LEAST(
            coalesce(dt.mtd_coll_pi,0)
              + greatest(coalesce(dt.prin_coll_eom,0) - coalesce(s.prin_due_eom,0), 0)
              + greatest(coalesce(dt.int_coll_eom,0)  - coalesce(s.int_due_eom,0),  0),
            coalesce(s.cap_demand_mtd,0)
        )                              AS mtd_collection,
        -- CAPPED PER LOAN at that loan's own MTD demand, matching t1_ontime.
        -- dt.mtd_ontime is a TIMING measure (receipts on/before the loan's last
        -- MTD demand date), so a borrower clearing arrears plus the current
        -- instalment before the due date produced more "on-time" than was due:
        -- 1,723 loans, Rs 52.4 L excess on 2026-08-20, which pushed branch-level
        -- MTD OTRR over 100% (5 branches, max 103.40%) — the same defect the
        -- uncapped t1 numerator had at 110.15%.
        -- The cap keeps the ON-TIME meaning (late payers are still excluded) and
        -- only bounds it. It is deliberately NOT least(mtd_collection, mtd_demand):
        -- that is the capped CE (93.22%) and would count 6,584 loans that paid
        -- AFTER their due date as on-time, collapsing OTRR into CE.
        LEAST(coalesce(dt.mtd_ontime,0), coalesce(s.mtd_demand,0)) AS mtd_ontime,
        coalesce(s.pmsd_demand,0)      AS pmsd_demand,
        coalesce(dt.pmsd_collection,0) AS pmsd_collection,
        coalesce(s.pmtd_demand,0)      AS pmtd_demand,
        -- PMTD collection built the SAME way as mtd_collection above (.pbit
        -- [Collection], shifted one month): per-loan LEAST(P+I collected in the
        -- PMTD window + opening advance as at prev-prev month-end, capped demand).
        -- It used to be the RAW amount_collected sum — uncapped, no advance, and
        -- including charges — so PMTD CE was structurally higher than MTD CE and
        -- the two were not comparable (97.70% vs 90.05% on 2026-08-04).
        LEAST(
            coalesce(dt.pmtd_coll_pi,0)
              + greatest(coalesce(dt.prin_coll_ppm,0) - coalesce(s.prin_due_ppm,0), 0)
              + greatest(coalesce(dt.int_coll_ppm,0)  - coalesce(s.int_due_ppm,0),  0),
            coalesce(s.cap_demand_pmtd,0)
        )                              AS pmtd_collection
    FROM public.home_loan_account la
    LEFT JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN jlg_dpd d      ON d.loan_id  = la.loan_id
    LEFT JOIN prod_class jpc ON jpc.loan_source='JLG' AND jpc.product_id = la.product_id::text
    LEFT JOIN loan_extra ex ON ex.loan_source='JLG' AND ex.loan_id = la.loan_id
    LEFT JOIN jlg_sched  s  ON s.loan_id  = la.loan_id
    LEFT JOIN jlg_detail dt ON dt.loan_id = la.loan_id
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    WHERE la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND (coalesce(s.t1_demand,0)+coalesce(s.mtd_demand,0)+coalesce(s.pmtd_demand,0)
          +coalesce(dt.t1_collection,0)+coalesce(dt.mtd_collection,0)+coalesce(dt.pmtd_collection,0)) > 0
),
all_base AS (SELECT * FROM il_base UNION ALL SELECT * FROM jlg_base),

-- ─────────────────────────────────────────────────────────────────────────────
-- DERIVE RISK DIMENSIONS + FTOD FLAGS
-- ─────────────────────────────────────────────────────────────────────────────
enriched AS (
    SELECT b.*,
        CASE WHEN raw_status='W' THEN 'Write-off'
             WHEN live_dpd=0 THEN 'Regular'
             WHEN live_dpd<=90 THEN 'Overdue' ELSE 'NPA' END AS curr_od_status,
        CASE WHEN raw_status='W' THEN 'Write-Off'
             WHEN live_dpd=0 THEN 'Regular'
             WHEN live_dpd BETWEEN 1 AND 30 THEN '1 - 30'
             WHEN live_dpd BETWEEN 31 AND 60 THEN '31 - 60'
             WHEN live_dpd BETWEEN 61 AND 90 THEN '61 - 90'
             WHEN live_dpd BETWEEN 91 AND 180 THEN '91 - 180'
             WHEN live_dpd BETWEEN 181 AND 360 THEN '181 - 360'
             ELSE '360 +' END AS dpd_bucket,
        -- CURRENT movement: live DPD vs month-start (EOM) DPD.  The Excel T-1
        -- sheet's FTOD counts sit exclusively in 'Worsened' rows, which is only
        -- possible under live-vs-EOM (a fresh slip is 0 → >0 = Worsened).
        -- No W special-case: the write-off master only updates loan STATUS,
        -- it must not alter movement or any other calculation.
        CASE WHEN live_dpd = eom_dpd THEN 'Static'
             WHEN live_dpd < eom_dpd THEN 'Improved'
             ELSE 'Worsened' END AS bucket_movement,
        CASE b.raw_status WHEN 'A' THEN 'Active' WHEN 'D' THEN 'Death' WHEN 'I' THEN 'Death'
             WHEN 'W' THEN 'Write-off' WHEN 'X' THEN 'Closed'
             ELSE b.raw_status END AS loan_status,
        -- FTOD (fresh slippage): regular at prev-month-end, overdue now.
        --
        -- WRITE-OFFS EXCLUDED (2026-08-13, on instruction). "First-time overdue"
        -- is a statement about a performing loan deteriorating; a loan already
        -- written off has by definition already had the worst outcome and cannot
        -- slip for the first time. Two such loans were being counted — both
        -- written off per the master (Dec-2025 / Mar-2026) yet still Active in
        -- core at DPD 4 and 8, because written-off loans stay on the collection
        -- system for recovery.
        --
        -- This makes mtd_ftod agree with the OD Status matrix and the Excel OD
        -- Slippage sheet by CONSTRUCTION rather than via in_od_matrix: both now
        -- drop write-offs. Moves mtd_ftod 3,828 -> 3,826 and t1_ftod with it.
        CASE WHEN eom_dpd = 0 AND live_dpd > 0 AND b.raw_status <> 'W'
             THEN 1 ELSE 0 END AS ftod_flag
    FROM all_base b
)

-- ===========================================================================
-- LOAN-GRAIN PROJECTION — hand-maintained.
-- EVERYTHING ABOVE THIS LINE IS GENERATED from the parent query by
-- pipeline/gen_loan_grain.py. Do not hand-edit it; edit the parent and
-- regenerate. Everything below is this file's own and is preserved.
-- ===========================================================================
SELECT
    (current_date - 1)                              AS data_date,
    e.loan_id,
    e.loan_source,
    e.business_segment,
    e.loan_status,

    e.eom_dpd,
    e.live_dpd,
    e.dpd_bucket,
    e.bucket_movement,
    e.ftod_flag,

    round(coalesce(e.t1_demand, 0)::numeric, 2)     AS t1_demand,
    round(coalesce(e.t1_collection, 0)::numeric, 2) AS t1_collection,
    round(least(coalesce(e.t1_collection, 0), coalesce(e.t1_demand, 0))::numeric, 2)
                                                    AS t1_ontime,
    round(coalesce(e.mtd_demand, 0)::numeric, 2)    AS mtd_demand,
    round(coalesce(e.mtd_collection, 0)::numeric, 2) AS mtd_collection,
    round(coalesce(e.mtd_ontime, 0)::numeric, 2)    AS mtd_ontime,
    -- no POS on this CTE: collection_fact tracks demand and receipts, not
    -- balances. Loan-level POS lives in rpt_aum_loans.

    coalesce(h.zone_name,    'Unassigned')          AS zone_name,
    coalesce(h.cluster_name, 'Unassigned')          AS cluster_name,
    coalesce(h.region_name,  'Unassigned')          AS region_name,
    coalesce(h.area_name,    'Unassigned')          AS area_name,
    coalesce(h.branch_name,  'Unassigned')          AS branch_name,
    e.branch_id,
    coalesce(h.zone_id::text   || ' - ' || h.zone_name,    'Unassigned') AS zone_label,
    coalesce(h.cluster_id::text|| ' - ' || h.cluster_name, 'Unassigned') AS cluster_label,
    coalesce(h.region_id::text || ' - ' || h.region_name,  'Unassigned') AS region_label,
    coalesce(h.area_id::text   || ' - ' || h.area_name,    'Unassigned') AS area_label,
    coalesce(e.branch_id::text || ' - ' || h.branch_name,  'Unassigned') AS branch_label,
    coalesce(e.lo_id, 'N/A')                        AS lo_id,

    coalesce(e.prod_classification, 'Other')        AS prod_classification,
    coalesce(h.state_id::text,   'N/A')             AS state_id,
    coalesce(h.district_id::text,'N/A')             AS district_id,

    -- ── Columns below exist so rpt_collection can be DERIVED from this grain ──
    -- Every remaining GROUP BY key and measure of collection_fact.sql's final
    -- aggregation. With them present, aggregating this result reproduces
    -- rpt_collection from ONE query and therefore ONE snapshot, so the page and
    -- its CSV export cannot drift apart.
    -- NOT written to rpt_collection_loans (the runner drops agg_*), so no DDL.
    coalesce(e.curr_od_status, 'N/A')               AS agg_curr_od_status,
    coalesce(e.cycle_no,       'N/A')               AS agg_cycle_no,
    coalesce(e.disb_year,      'N/A')               AS agg_disb_year,
    coalesce(e.purpose_id,     'N/A')               AS agg_purpose_id,
    coalesce(e.facility_id,    'N/A')               AS agg_facility_id,
    coalesce(e.lender_id,      'N/A')               AS agg_lender_id,
    coalesce(e.caste,          'N/A')               AS agg_caste,
    coalesce(e.religion,       'N/A')               AS agg_religion,
    round(coalesce(e.pmsd_demand,     0)::numeric, 2) AS agg_pmsd_demand,
    round(coalesce(e.pmsd_collection, 0)::numeric, 2) AS agg_pmsd_collection,
    round(coalesce(e.pmtd_demand,     0)::numeric, 2) AS agg_pmtd_demand,
    round(coalesce(e.pmtd_collection, 0)::numeric, 2) AS agg_pmtd_collection,
    (SELECT yesterday   FROM ref)                   AS agg_report_date,
    (SELECT pmsd_cutoff FROM ref)                   AS agg_pmsd_date
FROM enriched e
LEFT JOIN hierarchy h ON e.branch_id = h.branch_id
-- NO WHERE CLAUSE HERE — deliberately.
--   The parent counts EVERY enriched row in loan_count (99,398), including 7,229
--   loans with no demand and no receipts. Filtering here would make a derived
--   rpt_collection undercount by exactly those loans.
--   The export's own filter — keep a loan only if it has demand OR receipts —
--   is applied by the runner just before writing rpt_collection_loans, so the
--   exported file is unchanged (92,169 rows) while the aggregate sees everything.
--   That filter must stay as it is: filtering on demand ALONE previously dropped
--   Rs 28.4 L of mtd_ontime from loans that paid without a current-month demand.
ORDER BY e.loan_id;
