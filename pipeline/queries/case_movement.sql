-- =============================================================================
-- Report  : Case Movement (Loan Application Pipeline Tracker)
-- PBI File: CASE MOVEMENT ANANAYA.pbit
-- Logic   : Tracks loan applications moving through credit stages:
--           Enrolled -> Booked (BK) -> Credit (CC) -> TVR (TV) -> Sanctioned (SN) -> Disbursed
--           Also tracks rejections (XR), CB approval ratios, meetings (CGT/GRT)
--
-- Periods : T-1 = yesterday, MTD = month-to-date (1st of month to yesterday)
-- TOPUP   : excluded from all counts (product_id ILIKE '%TOPUP%')
-- New Client (NC): first-time borrower (no prior loan_account record)
-- Existing Client (EC/repeat): CUST_ID found in loan_account_il or home_loan_account
--
-- Tables  : loan_application_il (IL apps)
--           loan_application     (JLG apps, uses center_id -> home_center_master)
--           loan_account_il      (to detect new vs existing IL clients)
--           home_loan_account    (to detect new vs existing JLG clients)
--           home_meeting_sch     (JLG CGT/GRT meeting tracking)
--           brnch_master, area_master, home_center_master
--
-- Note    : IL meeting table (meeting_sch) not confirmed in prod DB.
--           CGT/GRT metrics pulled from home_meeting_sch for JLG only.
--           approval_ratio = approved / cb_checked (CB=credit bureau check)
--           approved = the application carries a sanction_date. NOTE the cohort
--           is immature: applications filed this month that are still in process
--           count in the denominator but not yet in the numerator, so the ratio
--           reads low early in a month and rises as decisions land.
--           Approval: status='XR' AND rejection_reason IN ('LC','Rejected','BRJ')
--           (per PBI DAX -- these reason codes indicate credit-approved loans,
--            not truly rejected ones, in Ananya's CBS naming convention)
-- =============================================================================

WITH

ref AS (
    SELECT
        (current_date - interval '1 day')::date                            AS yesterday,
        date_trunc('month', current_date - 1)::date                            AS mtd_start,
        (date_trunc('month', current_date - 1) - interval '1 day')::date       AS pmsd_date,
        -- Previous month same date (for LMSD comparison)
        date(
            date_trunc('month', current_date - 1) - interval '1 month'
        )                                                                   AS lm_month_start
),

hierarchy AS (
    SELECT
        bm.branch_id,
        bm.branch_name,
        a.area_name,
        reg.branch_name  AS region_name,
        clus.area_name   AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON a.area_id    = bm.area_id
    LEFT JOIN public.brnch_master reg  ON reg.branch_id = a.region_id
    LEFT JOIN public.area_master  clus ON clus.area_id  = reg.area_id
    WHERE bm.active = 'Y'
      AND bm.is_region = 'N'
      AND bm.branch_name <> 'DEMO'
),

-- =========================================================
-- EXISTING CUSTOMERS (to classify NC vs EC)
-- A cust_id with any prior disbursed loan = existing client
-- =========================================================
existing_cust_il AS (
    SELECT DISTINCT cust_id FROM public.loan_account_il
    WHERE status NOT IN ('XR')
),

existing_cust_jlg AS (
    SELECT DISTINCT cust_id FROM public.home_loan_account
    WHERE status NOT IN ('XR')
),

-- =========================================================
-- IL APPLICATIONS
-- branch_id comes directly from loan_application_il
-- =========================================================
il_apps AS (
    SELECT
        a.application_number,
        a.cust_id,
        a.status,
        a.product_id,
        a.branch_id,
        a.application_date::date                                           AS app_date,
        a.sanction_date::date                                               AS sanction_date,
        a.rejection_date::date                                              AS rejection_date,
        a.rejection_reason,
        a.comments,
        CASE WHEN e.cust_id IS NOT NULL THEN 'EC' ELSE 'NC' END            AS cust_type,
        -- TOPUP filter flag
        CASE WHEN upper(a.product_id::text) LIKE '%TOPUP%' THEN 1 ELSE 0 END  AS is_topup,
        -- Duplicate flag
        CASE WHEN upper(a.comments::text) LIKE '%DUPLICATE APPLICATION%'
             THEN 1 ELSE 0 END                                             AS is_duplicate
    FROM public.loan_application_il a
    LEFT JOIN existing_cust_il e ON e.cust_id = a.cust_id
),

-- =========================================================
-- JLG APPLICATIONS
-- center_id -> home_center_master -> branch_id
-- Note: JLG uses sanctioned_date (not sanction_date)
-- =========================================================
jlg_apps AS (
    SELECT
        a.application_number,
        a.cust_id,
        a.status,
        a.product_id,
        cm.branch_id,
        a.application_date::date                                           AS app_date,
        a.sanctioned_date::date                                             AS sanction_date,
        a.rejection_date::date                                              AS rejection_date,
        a.rejection_reason,
        a.comments,
        CASE WHEN e.cust_id IS NOT NULL THEN 'EC' ELSE 'NC' END            AS cust_type,
        CASE WHEN upper(a.product_id::text) LIKE '%TOPUP%' THEN 1 ELSE 0 END  AS is_topup,
        CASE WHEN upper(a.comments::text) LIKE '%DUPLICATE APPLICATION%'
             THEN 1 ELSE 0 END                                             AS is_duplicate
    FROM public.loan_application a
    JOIN public.home_center_master cm ON cm.center_id = a.center_id
    LEFT JOIN existing_cust_jlg e     ON e.cust_id = a.cust_id
),

-- =========================================================
-- PD / GRT — Personal Discussion submitted, by branch.
-- JLG ONLY: measured 2026-08-21, 14,246 of 14,249 pd_remarks applications in the
-- last 60 days matched loan_application (JLG) and ZERO matched loan_account_il.
-- It is a STAGE of its own — do not fold its count into any approval ratio.
-- =========================================================
pd_branch AS (
    SELECT j.branch_id,
        count(DISTINCT CASE WHEN pr.submitted_on::date = r.yesterday
              THEN pr.application_number END)                              AS pd_done_t1,
        count(DISTINCT CASE WHEN pr.submitted_on::date >= r.mtd_start
              AND pr.submitted_on::date < current_date
              THEN pr.application_number END)                              AS pd_done_mtd
    FROM public.pd_remarks pr
    JOIN jlg_apps j ON j.application_number::text = pr.application_number::text
    CROSS JOIN ref r
    WHERE pr.submitted_on::date >= r.mtd_start - interval '1 day'
    GROUP BY j.branch_id
),

-- First PD date per application — used to say whether a REJECTED file had
-- already been through Personal Discussion when it was turned down. Unbounded
-- by date on purpose: a file rejected this month may have had its PD in an
-- earlier month, and clipping to MTD would misfile those as pre-PD.
pd_first AS (
    SELECT pr.application_number::text        AS application_number,
           min(pr.submitted_on::date)         AS pd_date
    FROM public.pd_remarks pr
    GROUP BY 1
),

-- =========================================================
-- DISBURSEMENTS (from loan accounts, not applications)
-- =========================================================
il_disb AS (
    SELECT branch_id,
           (disbursement_date::date = (SELECT yesterday FROM ref))::int         AS is_t1,
           (disbursement_date::date >= (SELECT mtd_start FROM ref)
            AND disbursement_date::date <= (SELECT yesterday FROM ref))::int    AS is_mtd,
           total_loan_amount
    FROM public.loan_account_il
    WHERE status = 'A'
      AND disbursement_date IS NOT NULL
),

jlg_disb AS (
    SELECT cm.branch_id,
           (la.disbursement_date::date = (SELECT yesterday FROM ref))::int      AS is_t1,
           (la.disbursement_date::date >= (SELECT mtd_start FROM ref)
            AND la.disbursement_date::date <= (SELECT yesterday FROM ref))::int AS is_mtd,
           la.total_loan_amount
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    WHERE la.status = 'A'
      AND la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND la.disbursement_date IS NOT NULL
),

-- =========================================================
-- MEETINGS (JLG only via home_meeting_sch)
-- meeting_status = 'C' (Completed)
-- meeting_purpose: 'C1' = CGT-1, 'G1' = GRT-1
-- =========================================================
jlg_meetings AS (
    SELECT
        cm.branch_id,
        -- CGT and GRT are DIFFERENT ACTIVITIES and each needs BOTH periods.
        -- Previously only cgt1_t1 and grt1_mtd existed, so any tile pairing them
        -- compared compulsory group training YESTERDAY against group recognition
        -- MONTH-TO-DATE — two activities over two windows, in one number.
        sum(CASE WHEN ms.meeting_status = 'C' AND ms.meeting_purpose = 'C1'
                  AND ms.meeting_date = (SELECT yesterday FROM ref) THEN 1 ELSE 0 END)  AS cgt1_t1,
        sum(CASE WHEN ms.meeting_status = 'C' AND ms.meeting_purpose = 'C1'
                  AND ms.meeting_date >= (SELECT mtd_start FROM ref)
                  AND ms.meeting_date <= (SELECT yesterday FROM ref) THEN 1 ELSE 0 END) AS cgt1_mtd,
        sum(CASE WHEN ms.meeting_status = 'C' AND ms.meeting_purpose = 'G1'
                  AND ms.meeting_date = (SELECT yesterday FROM ref) THEN 1 ELSE 0 END)  AS grt1_t1,
        sum(CASE WHEN ms.meeting_status = 'C' AND ms.meeting_purpose = 'G1'
                  AND ms.meeting_date >= (SELECT mtd_start FROM ref)
                  AND ms.meeting_date <= (SELECT yesterday FROM ref) THEN 1 ELSE 0 END) AS grt1_mtd
    FROM public.home_meeting_sch ms
    JOIN public.home_center_master cm ON cm.center_id = ms.center_id
    GROUP BY cm.branch_id
),

-- =========================================================
-- AGGREGATE IL APPLICATIONS BY BRANCH
-- =========================================================
il_branch AS (
    SELECT
        'IL'                                                               AS loan_source,
        a.branch_id,
        -- T-1 stage counts (new clients only = NC, non-TOPUP)
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.is_topup = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS new_clients_t1,
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.status = 'BK' AND a.is_topup = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS booked_t1,
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.status = 'CC'
              THEN a.application_number END)                               AS credit_t1,
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.status = 'TV'
              THEN a.application_number END)                               AS tvr_t1,
        count(DISTINCT CASE WHEN a.sanction_date = r.yesterday
              AND a.is_topup = 0
              THEN a.application_number END)                               AS sanctioned_t1,
        count(DISTINCT CASE WHEN a.rejection_date = r.yesterday
              AND a.status = 'XR' AND a.is_topup = 0
              THEN a.application_number END)                               AS rejected_t1,
        -- MTD stage counts
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS new_clients_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.status = 'BK' AND a.is_topup = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS booked_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date AND a.status = 'CC'
              THEN a.application_number END)                               AS credit_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date AND a.status = 'TV'
              THEN a.application_number END)                               AS tvr_mtd,
        count(DISTINCT CASE WHEN a.sanction_date >= r.mtd_start
              AND a.sanction_date <= r.yesterday AND a.is_topup = 0
              THEN a.application_number END)                               AS sanctioned_mtd,
        count(DISTINCT CASE WHEN a.rejection_date > (SELECT prev_month_end FROM
              (SELECT (date_trunc('month', current_date - 1) - interval '1 day')::date AS prev_month_end) pe)
              AND a.rejection_date < current_date
              AND a.status = 'XR' AND a.is_topup = 0
              THEN a.application_number END)                               AS rejected_mtd,
        -- CB Checks (non-TOPUP, non-duplicate, new clients)
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS cb_checked_nc_mtd,
        -- Approved = credit sanctioned. The previous rule counted
        -- status='XR' AND rejection_reason IN ('LC','Rejected','BRJ') — but 'XR'
        -- is this file's own REJECTED marker (see rejected_t1 / rejected_mtd),
        -- so approvals were being counted out of the rejected pile, and
        -- 'Rejected' is not even a value rejection_reason takes. It read 4
        -- against 461 sanctioned and 453 disbursed. On loan_application_il,
        -- status 'DS' is the successful state and all 7,750 of those rows carry
        -- a sanction_date, so sanction_date IS NOT NULL is the reliable test
        -- and it matches how sanctioned_mtd is already measured.
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.sanction_date IS NOT NULL
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS approved_nc_mtd,
        -- Existing clients (EC)
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'EC'
              THEN a.application_number END)                               AS cb_checked_ec_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.sanction_date IS NOT NULL
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'EC'
              THEN a.application_number END)                               AS approved_ec_mtd,
        -- Duplicate %
        -- T-1 counterparts of the MTD screening pair. The .pbit carries
        -- "Approval Ratio % T-11" = approved T-1 / CBs checked T-1, and without
        -- these the T-1 approval tile had no denominator and read "—".
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.is_topup = 0 AND a.is_duplicate = 0
              THEN a.application_number END)                               AS cb_checked_t1,
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.sanction_date IS NOT NULL
              AND a.is_topup = 0 AND a.is_duplicate = 0
              THEN a.application_number END)                               AS approved_t1,
        count(CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_duplicate = 1 THEN 1 END)                          AS duplicate_mtd,
        count(CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date THEN 1 END)                   AS total_apps_mtd,
        0 AS cgt1_t1,
        0 AS grt1_mtd
    FROM il_apps a
    CROSS JOIN ref r
    GROUP BY a.branch_id
),

-- =========================================================
-- AGGREGATE JLG APPLICATIONS BY BRANCH
-- =========================================================
jlg_branch AS (
    SELECT
        'JLG'                                                              AS loan_source,
        a.branch_id,
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.is_topup = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS new_clients_t1,
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.status = 'BK' AND a.is_topup = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS booked_t1,
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.status = 'CC'
              THEN a.application_number END)                               AS credit_t1,
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.status = 'TV'
              THEN a.application_number END)                               AS tvr_t1,
        count(DISTINCT CASE WHEN a.sanction_date = r.yesterday
              AND a.is_topup = 0
              THEN a.application_number END)                               AS sanctioned_t1,
        -- JLG's rejected status is 'X', NOT 'XR'. Measured 2026-08-21 on
        -- loan_application: status 'XR' occurs ZERO times in the whole table,
        -- 'X' occurs 538,690 times. This CASE therefore returned 0 for every
        -- JLG branch since it was written, which is why the funnel's Rejected
        -- tile showed IL-only rejections (482 MTD) sitting beside firm-wide
        -- application and disbursement counts. 'XR' is correct for IL and is
        -- left alone in il_branch — the two systems use different codes.
        count(DISTINCT CASE WHEN a.rejection_date = r.yesterday
              AND a.status = 'X' AND a.is_topup = 0
              THEN a.application_number END)                               AS rejected_t1,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS new_clients_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.status = 'BK' AND a.is_topup = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS booked_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date AND a.status = 'CC'
              THEN a.application_number END)                               AS credit_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date AND a.status = 'TV'
              THEN a.application_number END)                               AS tvr_mtd,
        count(DISTINCT CASE WHEN a.sanction_date >= r.mtd_start
              AND a.sanction_date <= r.yesterday AND a.is_topup = 0
              THEN a.application_number END)                               AS sanctioned_mtd,
        count(DISTINCT CASE WHEN a.rejection_date > (SELECT prev_month_end FROM
              (SELECT (date_trunc('month', current_date - 1) - interval '1 day')::date AS prev_month_end) pe)
              AND a.rejection_date < current_date
              AND a.status = 'X' AND a.is_topup = 0
              THEN a.application_number END)                               AS rejected_mtd,
        -- STAGE ATTRIBUTION for the rejections above. A rejection carries a
        -- reason code (BRJ / MN / EX / UFR / OT) but the warehouse holds NO
        -- lookup for those codes, so they are not decoded here. What IS
        -- factual is how far the file had travelled when it was rejected:
        --   past PD  = pd_remarks.submitted_on exists on or before rejection
        --   pre-PD   = everything else (screening / BRE / CGT)
        -- last_cb_date is NOT usable for this: 0 of 7,365 August rejections
        -- carried one on or before the rejection date (measured 2026-08-21),
        -- the same staleness already found on loan_application.cb_result.
        count(DISTINCT CASE WHEN a.rejection_date > (SELECT prev_month_end FROM
              (SELECT (date_trunc('month', current_date - 1) - interval '1 day')::date AS prev_month_end) pe)
              AND a.rejection_date < current_date
              AND a.status = 'X' AND a.is_topup = 0
              AND pdx.pd_date IS NOT NULL AND pdx.pd_date <= a.rejection_date
              THEN a.application_number END)                               AS rejected_post_pd_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS cb_checked_nc_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.sanction_date IS NOT NULL
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS approved_nc_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'EC'
              THEN a.application_number END)                               AS cb_checked_ec_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.sanction_date IS NOT NULL
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'EC'
              THEN a.application_number END)                               AS approved_ec_mtd,
        -- T-1 counterparts of the MTD screening pair. The .pbit carries
        -- "Approval Ratio % T-11" = approved T-1 / CBs checked T-1, and without
        -- these the T-1 approval tile had no denominator and read "—".
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.is_topup = 0 AND a.is_duplicate = 0
              THEN a.application_number END)                               AS cb_checked_t1,
        count(DISTINCT CASE WHEN a.app_date = r.yesterday
              AND a.sanction_date IS NOT NULL
              AND a.is_topup = 0 AND a.is_duplicate = 0
              THEN a.application_number END)                               AS approved_t1,
        count(CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_duplicate = 1 THEN 1 END)                          AS duplicate_mtd,
        count(CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date THEN 1 END)                   AS total_apps_mtd,
        coalesce(m.cgt1_t1, 0)                                            AS cgt1_t1,
        coalesce(m.cgt1_mtd, 0)                                           AS cgt1_mtd,
        coalesce(m.grt1_t1, 0)                                            AS grt1_t1,
        coalesce(m.grt1_mtd, 0)                                           AS grt1_mtd
    FROM jlg_apps a
    CROSS JOIN ref r
    LEFT JOIN jlg_meetings m ON m.branch_id = a.branch_id
    -- First PD per application, pre-aggregated. Deliberately NOT a correlated
    -- subquery: on this replica that form trips "canceling statement due to
    -- conflict with recovery" — the same failure already worked around in
    -- od_status and the trend engine.
    LEFT JOIN pd_first pdx ON pdx.application_number = a.application_number::text
    GROUP BY a.branch_id, m.cgt1_t1, m.cgt1_mtd, m.grt1_t1, m.grt1_mtd
),

-- =========================================================
-- DISBURSEMENT TOTALS BY BRANCH
-- =========================================================
il_disb_branch AS (
    SELECT branch_id,
           sum(is_t1)                          AS disbursed_t1_count,
           sum(is_t1 * total_loan_amount)      AS disbursed_t1_amount,
           sum(is_mtd)                         AS disbursed_mtd_count,
           sum(is_mtd * total_loan_amount)     AS disbursed_mtd_amount
    FROM il_disb
    GROUP BY branch_id
),

jlg_disb_branch AS (
    SELECT branch_id,
           sum(is_t1)                          AS disbursed_t1_count,
           sum(is_t1 * total_loan_amount)      AS disbursed_t1_amount,
           sum(is_mtd)                         AS disbursed_mtd_count,
           sum(is_mtd * total_loan_amount)     AS disbursed_mtd_amount
    FROM jlg_disb
    GROUP BY branch_id
),

-- =========================================================
-- TAT — median calendar days from APPLICATION PUNCH to DISBURSEMENT, for loans
-- DISBURSED this month. The standard NBFC turnaround: what the customer actually
-- waits end to end, not the internal sanction step.
--
-- LINK: application_number BECOMES loan_id on disbursement. Verified 2026-08-21 —
-- 100% of JLG disbursements (9,305 over 60 days) and 100% of IL (290 over 90 days)
-- join on it. An earlier version matched on cust_id + "latest application on or
-- before disbursement", which also resolved 100% but was a proxy; this is exact.
-- NOTE the loan account tables carry no application_number column of their own,
-- and JLG's old_application_id is 100% NULL — the id IS the join.
--
-- MEDIAN, not mean: a few reopened or backdated files would drag an average.
-- =========================================================
il_tat AS (
    SELECT d.branch_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY (d.dd - a.ad)) AS tat_days_mtd
    FROM (SELECT loan_id, branch_id, disbursement_date::date AS dd
          FROM public.loan_account_il
          WHERE status = 'A' AND loan_id >= 10000000
            AND disbursement_date::date >= (SELECT mtd_start FROM ref)
            AND disbursement_date::date <= (SELECT yesterday FROM ref)) d
    JOIN (SELECT application_number::bigint AS an, application_date::date AS ad
          FROM public.loan_application_il
          WHERE application_date IS NOT NULL) a ON a.an = d.loan_id
    WHERE d.dd >= a.ad
    GROUP BY d.branch_id
),

jlg_tat AS (
    SELECT d.branch_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY (d.dd - a.ad)) AS tat_days_mtd
    FROM (SELECT la.loan_id, cm.branch_id, la.disbursement_date::date AS dd
          FROM public.home_loan_account la
          JOIN public.home_center_master cm ON cm.center_id = la.center_id
          WHERE la.status = 'A' AND la.loan_id >= 10000000
            AND la.disbursement_date::date >= (SELECT mtd_start FROM ref)
            AND la.disbursement_date::date <= (SELECT yesterday FROM ref)) d
    JOIN (SELECT application_number::bigint AS an, application_date::date AS ad
          FROM public.loan_application
          WHERE application_date IS NOT NULL) a ON a.an = d.loan_id
    WHERE d.dd >= a.ad
    GROUP BY d.branch_id
),

combined AS (
    SELECT
        b.loan_source, b.branch_id,
        b.new_clients_t1, b.booked_t1, b.credit_t1, b.tvr_t1,
        b.sanctioned_t1, b.rejected_t1,
        b.new_clients_mtd, b.booked_mtd, b.credit_mtd, b.tvr_mtd,
        b.sanctioned_mtd, b.rejected_mtd,
        b.cb_checked_nc_mtd, b.approved_nc_mtd,
        b.cb_checked_ec_mtd, b.approved_ec_mtd,
        b.duplicate_mtd, b.total_apps_mtd,
        b.cb_checked_t1, b.approved_t1, t.tat_days_mtd,
        -- PD is captured only for JLG (pd_remarks holds no IL application), so IL
        -- reports 0 rather than a NULL that would look like "not measured yet".
        0::bigint AS pd_done_t1, 0::bigint AS pd_done_mtd,
        -- Same reason: the post-PD rejection split needs pd_remarks, so IL is 0.
        0::bigint AS rejected_post_pd_mtd,
        0::bigint AS cgt1_t1, 0::bigint AS cgt1_mtd,
        0::bigint AS grt1_t1, 0::bigint AS grt1_mtd,
        coalesce(d.disbursed_t1_count, 0)  AS disbursed_t1_count,
        coalesce(d.disbursed_t1_amount, 0) AS disbursed_t1_amount,
        coalesce(d.disbursed_mtd_count, 0) AS disbursed_mtd_count,
        coalesce(d.disbursed_mtd_amount,0) AS disbursed_mtd_amount
    FROM il_branch b
    LEFT JOIN il_disb_branch d ON d.branch_id = b.branch_id
    LEFT JOIN il_tat t         ON t.branch_id = b.branch_id
    UNION ALL
    SELECT
        b.loan_source, b.branch_id,
        b.new_clients_t1, b.booked_t1, b.credit_t1, b.tvr_t1,
        b.sanctioned_t1, b.rejected_t1,
        b.new_clients_mtd, b.booked_mtd, b.credit_mtd, b.tvr_mtd,
        b.sanctioned_mtd, b.rejected_mtd,
        b.cb_checked_nc_mtd, b.approved_nc_mtd,
        b.cb_checked_ec_mtd, b.approved_ec_mtd,
        b.duplicate_mtd, b.total_apps_mtd,
        b.cb_checked_t1, b.approved_t1, t.tat_days_mtd,
        coalesce(pdb.pd_done_t1, 0)  AS pd_done_t1,
        coalesce(pdb.pd_done_mtd, 0) AS pd_done_mtd,
        b.rejected_post_pd_mtd,
        b.cgt1_t1, b.cgt1_mtd, b.grt1_t1, b.grt1_mtd,
        coalesce(d.disbursed_t1_count, 0)  AS disbursed_t1_count,
        coalesce(d.disbursed_t1_amount, 0) AS disbursed_t1_amount,
        coalesce(d.disbursed_mtd_count, 0) AS disbursed_mtd_count,
        coalesce(d.disbursed_mtd_amount,0) AS disbursed_mtd_amount
    FROM jlg_branch b
    LEFT JOIN jlg_disb_branch d ON d.branch_id = b.branch_id
    LEFT JOIN pd_branch pdb     ON pdb.branch_id = b.branch_id
    LEFT JOIN jlg_tat t         ON t.branch_id = b.branch_id
)

SELECT
    c.loan_source,
    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    c.branch_id,

    -- T-1 (yesterday)
    c.new_clients_t1,
    c.booked_t1,
    c.credit_t1,
    c.tvr_t1,
    c.sanctioned_t1,
    c.rejected_t1,
    c.disbursed_t1_count,
    round(c.disbursed_t1_amount::numeric, 2)  AS disbursed_t1_amount,

    -- MTD
    c.new_clients_mtd,
    c.booked_mtd,
    c.credit_mtd,
    c.tvr_mtd,
    c.sanctioned_mtd,
    c.rejected_mtd,
    -- Of c.rejected_mtd, the part already past Personal Discussion when it was
    -- rejected. The remainder (rejected_mtd - this) fell out earlier, at
    -- screening / BRE / CGT. JLG only — see pd_first.
    c.rejected_post_pd_mtd,
    c.disbursed_mtd_count,
    round(c.disbursed_mtd_amount::numeric, 2) AS disbursed_mtd_amount,
    c.duplicate_mtd,
    c.total_apps_mtd,

    -- CB Approval Ratios
    c.cb_checked_nc_mtd,
    c.approved_nc_mtd,
    round(CASE WHEN c.cb_checked_nc_mtd > 0
               THEN c.approved_nc_mtd::numeric / c.cb_checked_nc_mtd
               ELSE 0 END, 4)                 AS approval_ratio_nc,
    c.cb_checked_ec_mtd,
    c.approved_ec_mtd,
    round(CASE WHEN c.cb_checked_ec_mtd > 0
               THEN c.approved_ec_mtd::numeric / c.cb_checked_ec_mtd
               ELSE 0 END, 4)                 AS approval_ratio_ec,
    (c.cb_checked_nc_mtd + c.cb_checked_ec_mtd) AS cb_checked_total,
    (c.approved_nc_mtd   + c.approved_ec_mtd)   AS approved_total,
    round(CASE WHEN (c.cb_checked_nc_mtd + c.cb_checked_ec_mtd) > 0
               THEN (c.approved_nc_mtd + c.approved_ec_mtd)::numeric
                    / (c.cb_checked_nc_mtd + c.cb_checked_ec_mtd)
               ELSE 0 END, 4)                 AS approval_ratio_total,

    -- Meetings (JLG)
    c.cgt1_t1,
    c.cgt1_mtd,
    c.grt1_t1,
    c.grt1_mtd,

    -- ── New stage measures ────────────────────────────────────────────────
    -- Each belongs to ONE stage. Do NOT combine them into a single approval
    -- rate: the denominator changes at every step of the funnel.
    c.cb_checked_t1,
    c.approved_t1,
    -- .pbit "Approval Ratio % T-11" = approved T-1 / CBs checked T-1
    round(CASE WHEN c.cb_checked_t1 > 0
               THEN c.approved_t1::numeric / c.cb_checked_t1 * 100
               ELSE 0 END, 4)                 AS approval_ratio_t1,
    c.pd_done_t1,
    c.pd_done_mtd,
    round(c.tat_days_mtd::numeric, 1)         AS tat_days_mtd,

    current_date AS report_date

FROM combined c
LEFT JOIN hierarchy h ON h.branch_id = c.branch_id
ORDER BY c.loan_source, h.cluster_name, h.region_name, h.area_name, h.branch_name;
