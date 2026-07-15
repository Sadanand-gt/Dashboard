-- =============================================================================
-- Report  : Disbursement
-- Anchor  : Everything is measured relative to T-1 (yesterday), matching the
--           .pbit measures which use TODAY()-1 as the reference point.
-- Month-end rule : when T-1 is the last day of its month (i.e. the report is
--           run on the 1st of a month), the previous-month windows extend to
--           the LAST day of the previous month too — so full month vs full
--           month.  Otherwise they align to the same day-of-month as T-1.
-- Periods (example when today = 1-Jul, so T-1 = 30-Jun = month-end):
--   T1   = T-1 itself                          → 30-Jun            (single day)
--   PMSD = previous month, SAME day-of-month   → 30-May            (single day)
--   MTD  = 1st of T-1's month  → T-1            → 1-Jun to 30-Jun   (month-to-date)
--   PMTD = 1st of prev month   → month-end day  → 1-May to 31-May   (prev month-to-date)
-- Note   : disbursement_date is a TIMESTAMP on loan_account_il, so all period
--          filters cast ::date to avoid dropping same-day records with a time part.
-- Status  : A=Active, X=Closed
-- =============================================================================

WITH

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DATE ANCHORS  (all relative to T-1 = current_date - 1 day, per .pbit)
--    anchor        = T-1 (yesterday)
--    is_month_end  = anchor is the last calendar day of its month
--    pm_match_day  = corresponding day in the previous month:
--                      • last day of prev month, if anchor is month-end
--                      • same day-of-month as anchor, otherwise
-- ─────────────────────────────────────────────────────────────────────────────
date_anchors AS (
    SELECT
        anchor                                                       AS t1_date,
        -- PMSD = previous month, SAME day-of-month as T-1 (e.g. 30-Jun → 30-May)
        (anchor - interval '1 month')::date                          AS pmsd_date,
        -- MTD = 1st of T-1's month → T-1
        date_trunc('month', anchor)::date                            AS mtd_start,
        anchor                                                       AS mtd_end,
        -- PMTD = 1st of prev month → month-end-aware day
        --   • last day of prev month when T-1 is a month-end (report run on the 1st)
        --   • same day-of-month as T-1 otherwise
        date_trunc('month', anchor - interval '1 month')::date       AS pmtd_start,
        pmtd_end                                                     AS pmtd_end,
        -- PM = the FULL previous month (1st → last day)
        date_trunc('month', anchor - interval '1 month')::date       AS pm_start,
        (date_trunc('month', anchor) - interval '1 day')::date       AS pm_end,
        -- YTD = 1st April of T-1's fiscal year → T-1
        CASE WHEN extract(month FROM anchor) >= 4
             THEN make_date(extract(year FROM anchor)::int, 4, 1)
             ELSE make_date(extract(year FROM anchor)::int - 1, 4, 1) END AS ytd_start
    FROM (
        SELECT
            anchor,
            CASE
                WHEN anchor = (date_trunc('month', anchor) + interval '1 month' - interval '1 day')::date
                    THEN (date_trunc('month', anchor) - interval '1 day')::date   -- last day of prev month
                ELSE (anchor - interval '1 month')::date                          -- same day-of-month
            END AS pmtd_end
        FROM (SELECT (current_date - interval '1 day')::date AS anchor) a0
    ) a1
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. BRANCH HIERARCHY — Zone → Cluster → Region → Unit → Branch
-- ─────────────────────────────────────────────────────────────────────────────
hierarchy AS (
    SELECT
        bm.branch_id,
        bm.branch_name,
        a.area_id,
        a.area_name,
        reg.branch_id   AS region_id,
        reg.branch_name AS region_name,
        clus.area_id    AS cluster_id,
        clus.area_name  AS cluster_name,
        z.area_id       AS zone_id,
        z.area_name     AS zone_name,
        bm.state_id,
        bm.district_id
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
    LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id
    WHERE bm.active       = 'Y'
      AND bm.is_region    = 'N'
      AND bm.branch_name <> 'DEMO'
      AND bm.closing_date IS NULL
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 2a. PRODUCT CLASSIFICATION LOOKUP (by loan_source + product_id)
-- ─────────────────────────────────────────────────────────────────────────────
prod_class AS (
    SELECT 'IL'  AS loan_source, lp.product_id::text AS product_id,
           coalesce(pc.product_classification, 'Other') AS prod_classification
    FROM public.loan_product_il lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
    UNION ALL
    SELECT 'JLG' AS loan_source, lp.product_id::text AS product_id,
           coalesce(pc.product_classification, 'Other') AS prod_classification
    FROM public.loan_product lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 2b. DEMOGRAPHIC / FACILITY LOOKUP — one row per loan (by loan_source + loan_id)
--     cycle_no, purpose_id, facility_id, lender_id, caste, religion
-- ─────────────────────────────────────────────────────────────────────────────
loan_extra AS (
    (
        SELECT DISTINCT ON (la.loan_id)
            'IL' AS loan_source, la.loan_id,
            coalesce(la.cycle::text,       'N/A') AS cycle_no,
            coalesce(la.purpose_id::text,  'N/A') AS purpose_id,
            coalesce(la.facility_id::text, 'N/A') AS facility_id,
            coalesce(la.lender_id::text,   'N/A') AS lender_id,
            coalesce(cci.caste,            'N/A') AS caste,
            coalesce(cci.religion,         'N/A') AS religion
        FROM public.loan_account_il la
        LEFT JOIN public.customer_contacts_il cci ON cci.loan_id = la.loan_id
        ORDER BY la.loan_id
    )
    UNION ALL
    (
        SELECT DISTINCT ON (hla.loan_id)
            'JLG' AS loan_source, hla.loan_id,
            coalesce(hla.cycle::text,       'N/A') AS cycle_no,
            coalesce(hla.purpose_id::text,  'N/A') AS purpose_id,
            coalesce(hla.facility_id::text, 'N/A') AS facility_id,
            'N/A'::text                             AS lender_id,
            coalesce(hbm.caste,             'N/A') AS caste,
            coalesce(hbm.religion,          'N/A') AS religion
        FROM public.home_loan_account hla
        LEFT JOIN public.home_brrwr_misc hbm ON hbm.cust_id = hla.cust_id
        ORDER BY hla.loan_id
    )
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. IL — T1 (yesterday)
-- ─────────────────────────────────────────────────────────────────────────────
il_t1 AS (
    SELECT
        'IL' AS loan_source, 'T1' AS period_type,
        da.t1_date AS period_start, da.t1_date AS period_end,
        la.loan_id, la.branch_id, la.loan_officer AS lo_id,
        la.product_id, la.total_loan_amount AS disb_amount,
        la.disbursement_date
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    WHERE la.disbursement_date::date = da.t1_date AND la.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. IL — PMSD (previous month same day as T1)
-- ─────────────────────────────────────────────────────────────────────────────
il_pmsd AS (
    SELECT
        'IL' AS loan_source, 'PMSD' AS period_type,
        da.pmsd_date AS period_start, da.pmsd_date AS period_end,
        la.loan_id, la.branch_id, la.loan_officer AS lo_id,
        la.product_id, la.total_loan_amount AS disb_amount,
        la.disbursement_date
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    WHERE la.disbursement_date::date = da.pmsd_date AND la.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. IL — MTD (current month 1st → today)
-- ─────────────────────────────────────────────────────────────────────────────
il_mtd AS (
    SELECT
        'IL' AS loan_source, 'MTD' AS period_type,
        da.mtd_start AS period_start, da.mtd_end AS period_end,
        la.loan_id, la.branch_id, la.loan_officer AS lo_id,
        la.product_id, la.total_loan_amount AS disb_amount,
        la.disbursement_date
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    WHERE la.disbursement_date::date >= da.mtd_start
      AND la.disbursement_date::date <= da.mtd_end
      AND la.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 5b. IL — PM (full previous month; feeds the Exec Summary "Last Month" card)
-- ─────────────────────────────────────────────────────────────────────────────
il_pm AS (
    SELECT
        'IL' AS loan_source, 'PM' AS period_type,
        da.pm_start AS period_start, da.pm_end AS period_end,
        la.loan_id, la.branch_id, la.loan_officer AS lo_id,
        la.product_id, la.total_loan_amount AS disb_amount,
        la.disbursement_date
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    WHERE la.disbursement_date::date >= da.pm_start
      AND la.disbursement_date::date <= da.pm_end
      AND la.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. IL — PMTD (previous month 1st → same day-of-month as today)
-- ─────────────────────────────────────────────────────────────────────────────
il_pmtd AS (
    SELECT
        'IL' AS loan_source, 'PMTD' AS period_type,
        da.pmtd_start AS period_start, da.pmtd_end AS period_end,
        la.loan_id, la.branch_id, la.loan_officer AS lo_id,
        la.product_id, la.total_loan_amount AS disb_amount,
        la.disbursement_date
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    WHERE la.disbursement_date::date >= da.pmtd_start
      AND la.disbursement_date::date <= da.pmtd_end
      AND la.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 6b. IL — YTD (1st April of T-1's FY → T-1)
-- ─────────────────────────────────────────────────────────────────────────────
il_ytd AS (
    SELECT
        'IL' AS loan_source, 'YTD' AS period_type,
        da.ytd_start AS period_start, da.t1_date AS period_end,
        la.loan_id, la.branch_id, la.loan_officer AS lo_id,
        la.product_id, la.total_loan_amount AS disb_amount,
        la.disbursement_date
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    WHERE la.disbursement_date::date >= da.ytd_start
      AND la.disbursement_date::date <= da.t1_date
      AND la.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. JLG — T1
-- ─────────────────────────────────────────────────────────────────────────────
jlg_t1 AS (
    SELECT
        'JLG' AS loan_source, 'T1' AS period_type,
        da.t1_date AS period_start, da.t1_date AS period_end,
        hla.loan_id, cm.branch_id, cm.assigned_to::varchar AS lo_id,
        hla.product_id, hla.total_loan_amount AS disb_amount,
        hla.disbursement_date
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    WHERE hla.disbursement_date::date = da.t1_date AND hla.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. JLG — PMSD
-- ─────────────────────────────────────────────────────────────────────────────
jlg_pmsd AS (
    SELECT
        'JLG' AS loan_source, 'PMSD' AS period_type,
        da.pmsd_date AS period_start, da.pmsd_date AS period_end,
        hla.loan_id, cm.branch_id, cm.assigned_to::varchar AS lo_id,
        hla.product_id, hla.total_loan_amount AS disb_amount,
        hla.disbursement_date
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    WHERE hla.disbursement_date::date = da.pmsd_date AND hla.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. JLG — MTD
-- ─────────────────────────────────────────────────────────────────────────────
jlg_mtd AS (
    SELECT
        'JLG' AS loan_source, 'MTD' AS period_type,
        da.mtd_start AS period_start, da.mtd_end AS period_end,
        hla.loan_id, cm.branch_id, cm.assigned_to::varchar AS lo_id,
        hla.product_id, hla.total_loan_amount AS disb_amount,
        hla.disbursement_date
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    WHERE hla.disbursement_date::date >= da.mtd_start
      AND hla.disbursement_date::date <= da.mtd_end
      AND hla.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 9b. JLG — PM (full previous month)
-- ─────────────────────────────────────────────────────────────────────────────
jlg_pm AS (
    SELECT
        'JLG' AS loan_source, 'PM' AS period_type,
        da.pm_start AS period_start, da.pm_end AS period_end,
        hla.loan_id, cm.branch_id, cm.assigned_to::varchar AS lo_id,
        hla.product_id, hla.total_loan_amount AS disb_amount,
        hla.disbursement_date
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    WHERE hla.disbursement_date::date >= da.pm_start
      AND hla.disbursement_date::date <= da.pm_end
      AND hla.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. JLG — PMTD
-- ─────────────────────────────────────────────────────────────────────────────
jlg_pmtd AS (
    SELECT
        'JLG' AS loan_source, 'PMTD' AS period_type,
        da.pmtd_start AS period_start, da.pmtd_end AS period_end,
        hla.loan_id, cm.branch_id, cm.assigned_to::varchar AS lo_id,
        hla.product_id, hla.total_loan_amount AS disb_amount,
        hla.disbursement_date
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    WHERE hla.disbursement_date::date >= da.pmtd_start
      AND hla.disbursement_date::date <= da.pmtd_end
      AND hla.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 10b. JLG — YTD (1st April of T-1's FY → T-1)
-- ─────────────────────────────────────────────────────────────────────────────
jlg_ytd AS (
    SELECT
        'JLG' AS loan_source, 'YTD' AS period_type,
        da.ytd_start AS period_start, da.t1_date AS period_end,
        hla.loan_id, cm.branch_id, cm.assigned_to::varchar AS lo_id,
        hla.product_id, hla.total_loan_amount AS disb_amount,
        hla.disbursement_date
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    WHERE hla.disbursement_date::date >= da.ytd_start
      AND hla.disbursement_date::date <= da.t1_date
      AND hla.status IN ('A', 'X')
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. UNION ALL PERIOD CTEs
-- ─────────────────────────────────────────────────────────────────────────────
all_disb AS (
    SELECT * FROM il_t1
    UNION ALL SELECT * FROM il_pmsd
    UNION ALL SELECT * FROM il_mtd
    UNION ALL SELECT * FROM il_pm
    UNION ALL SELECT * FROM il_pmtd
    UNION ALL SELECT * FROM il_ytd
    UNION ALL SELECT * FROM jlg_t1
    UNION ALL SELECT * FROM jlg_pmsd
    UNION ALL SELECT * FROM jlg_mtd
    UNION ALL SELECT * FROM jlg_pm
    UNION ALL SELECT * FROM jlg_pmtd
    UNION ALL SELECT * FROM jlg_ytd
)

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. FINAL AGGREGATION
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    d.period_type,
    d.period_start,
    d.period_end,
    d.loan_source,

    -- Business segment: IL split into LAP / IEL by product; JLG as-is
    CASE
        WHEN d.loan_source = 'IL' AND (
                 upper(trim(d.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(d.product_id::text)) LIKE '%UDYOGINI%'
              OR upper(trim(d.product_id::text)) LIKE '%SECURED%')
            THEN 'LAP'
        WHEN d.loan_source = 'IL' THEN 'IEL'
        ELSE 'JLG'
    END                                         AS business_segment,

    coalesce(h.zone_name,         'Unassigned') AS zone_name,
    coalesce(h.cluster_name,      'Unassigned') AS cluster_name,
    coalesce(h.region_name,       'Unassigned') AS region_name,
    coalesce(h.area_name,         'Unassigned') AS area_name,
    coalesce(h.branch_name,       'Unassigned') AS branch_name,
    d.branch_id,
    coalesce(h.state_id::text,    'N/A')        AS state_id,
    coalesce(h.district_id::text, 'N/A')        AS district_id,
    coalesce(d.lo_id,             'N/A')        AS lo_id,
    coalesce(d.product_id::text,  'N/A')        AS product_id,

    coalesce(pc.prod_classification, 'Other')   AS prod_classification,
    extract(year FROM d.disbursement_date)::text AS disb_year,
    coalesce(ex.cycle_no,         'N/A')        AS cycle_no,
    coalesce(ex.purpose_id,       'N/A')        AS purpose_id,
    coalesce(ex.facility_id,      'N/A')        AS facility_id,
    coalesce(ex.lender_id,        'N/A')        AS lender_id,
    coalesce(ex.caste,            'N/A')        AS caste,
    coalesce(ex.religion,         'N/A')        AS religion,

    count(d.loan_id)                            AS disb_count,
    round(sum(d.disb_amount)::numeric, 2)       AS disb_amount

FROM all_disb d
LEFT JOIN hierarchy  h  ON d.branch_id    = h.branch_id
LEFT JOIN prod_class pc ON pc.loan_source = d.loan_source AND pc.product_id = d.product_id::text
LEFT JOIN loan_extra ex ON ex.loan_source = d.loan_source AND ex.loan_id    = d.loan_id

GROUP BY
    d.period_type,
    d.period_start,
    d.period_end,
    d.loan_source,
    business_segment,
    h.zone_name,
    h.cluster_name,
    h.region_name,
    h.area_name,
    h.branch_name,
    d.branch_id,
    h.state_id,
    h.district_id,
    d.lo_id,
    d.product_id,
    pc.prod_classification,
    disb_year,
    ex.cycle_no,
    ex.purpose_id,
    ex.facility_id,
    ex.lender_id,
    ex.caste,
    ex.religion

ORDER BY
    d.period_type,
    d.loan_source,
    h.zone_name,
    h.cluster_name,
    h.region_name,
    h.area_name,
    h.branch_name;
