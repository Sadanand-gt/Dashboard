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
--           Approval: status='XR' AND rejection_reason IN ('LC','Rejected','BRJ')
--           (per PBI DAX -- these reason codes indicate credit-approved loans,
--            not truly rejected ones, in Ananya's CBS naming convention)
-- =============================================================================

WITH

ref AS (
    SELECT
        (current_date - interval '1 day')::date                            AS yesterday,
        date_trunc('month', current_date)::date                            AS mtd_start,
        (date_trunc('month', current_date) - interval '1 day')::date       AS pmsd_date,
        -- Previous month same date (for LMSD comparison)
        date(
            date_trunc('month', current_date) - interval '1 month'
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
        -- CGT-1 conducted T-1
        sum(CASE WHEN ms.meeting_status = 'C'
                  AND ms.meeting_purpose = 'C1'
                  AND ms.meeting_date = (SELECT yesterday FROM ref) THEN 1 ELSE 0 END)  AS cgt1_t1,
        -- GRT-1 conducted MTD
        sum(CASE WHEN ms.meeting_status = 'C'
                  AND ms.meeting_purpose = 'G1'
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
              (SELECT (date_trunc('month', current_date) - interval '1 day')::date AS prev_month_end) pe)
              AND a.rejection_date < current_date
              AND a.status = 'XR' AND a.is_topup = 0
              THEN a.application_number END)                               AS rejected_mtd,
        -- CB Checks (non-TOPUP, non-duplicate, new clients)
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS cb_checked_nc_mtd,
        -- Approved (per PBI: status=XR and reason LC/Rejected/BRJ = credit approved in CBS)
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.status = 'XR'
              AND a.rejection_reason IN ('LC', 'Rejected', 'BRJ')
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS approved_nc_mtd,
        -- Existing clients (EC)
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'EC'
              THEN a.application_number END)                               AS cb_checked_ec_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.status = 'XR'
              AND a.rejection_reason IN ('LC', 'Rejected', 'BRJ')
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'EC'
              THEN a.application_number END)                               AS approved_ec_mtd,
        -- Duplicate %
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
        count(DISTINCT CASE WHEN a.rejection_date = r.yesterday
              AND a.status = 'XR' AND a.is_topup = 0
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
              (SELECT (date_trunc('month', current_date) - interval '1 day')::date AS prev_month_end) pe)
              AND a.rejection_date < current_date
              AND a.status = 'XR' AND a.is_topup = 0
              THEN a.application_number END)                               AS rejected_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS cb_checked_nc_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.status = 'XR'
              AND a.rejection_reason IN ('LC', 'Rejected', 'BRJ')
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'NC'
              THEN a.application_number END)                               AS approved_nc_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'EC'
              THEN a.application_number END)                               AS cb_checked_ec_mtd,
        count(DISTINCT CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.status = 'XR'
              AND a.rejection_reason IN ('LC', 'Rejected', 'BRJ')
              AND a.is_topup = 0 AND a.is_duplicate = 0 AND a.cust_type = 'EC'
              THEN a.application_number END)                               AS approved_ec_mtd,
        count(CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date
              AND a.is_duplicate = 1 THEN 1 END)                          AS duplicate_mtd,
        count(CASE WHEN a.app_date >= r.mtd_start
              AND a.app_date < current_date THEN 1 END)                   AS total_apps_mtd,
        coalesce(m.cgt1_t1, 0)                                            AS cgt1_t1,
        coalesce(m.grt1_mtd, 0)                                           AS grt1_mtd
    FROM jlg_apps a
    CROSS JOIN ref r
    LEFT JOIN jlg_meetings m ON m.branch_id = a.branch_id
    GROUP BY a.branch_id, m.cgt1_t1, m.grt1_mtd
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
        b.cgt1_t1, b.grt1_mtd,
        coalesce(d.disbursed_t1_count, 0)  AS disbursed_t1_count,
        coalesce(d.disbursed_t1_amount, 0) AS disbursed_t1_amount,
        coalesce(d.disbursed_mtd_count, 0) AS disbursed_mtd_count,
        coalesce(d.disbursed_mtd_amount,0) AS disbursed_mtd_amount
    FROM il_branch b
    LEFT JOIN il_disb_branch d ON d.branch_id = b.branch_id
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
        b.cgt1_t1, b.grt1_mtd,
        coalesce(d.disbursed_t1_count, 0)  AS disbursed_t1_count,
        coalesce(d.disbursed_t1_amount, 0) AS disbursed_t1_amount,
        coalesce(d.disbursed_mtd_count, 0) AS disbursed_mtd_count,
        coalesce(d.disbursed_mtd_amount,0) AS disbursed_mtd_amount
    FROM jlg_branch b
    LEFT JOIN jlg_disb_branch d ON d.branch_id = b.branch_id
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
    c.grt1_mtd,

    current_date AS report_date

FROM combined c
LEFT JOIN hierarchy h ON h.branch_id = c.branch_id
ORDER BY c.loan_source, h.cluster_name, h.region_name, h.area_name, h.branch_name;
