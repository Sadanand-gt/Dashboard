-- =============================================================================
-- Report  : Current Status AUM — LIVE VIEW
-- PBI Page: "Current Status (AUM)" — Live toggle
-- DPD     : Read directly from loan_account_il.dpd / home_loan_account.dpd
--           These are maintained live by the core banking system.
--           Use this for real-time portfolio status (as of today).
--           For EOM snapshot (previous month DPD), see aum_status.sql.
-- Tables  : loan_account_il, home_loan_account
--           brnch_master, area_master, home_center_master
-- Output  : Identical column structure to rpt_aum_status so the dashboard
--           can render both views using the same chart/table components.
-- =============================================================================

WITH

-- Write-off MASTER (loan_id, wo_date). Overrides a loan's STATUS to 'W' when the
-- master applies (loan existed at write-off: disbursement_date <= wo_date). Keeps
-- the universe unchanged — only the displayed status changes, so the Excl-W/O
-- view (loan_status <> 'Write-off') matches Excel + Current Outstanding.
wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date
    FROM (VALUES {wo_pairs}) AS v(loan_id, wo_date)
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

-- ═════════════════════════════════════════════════════════════════════════════
-- IL LOANS — dpd column read directly from core banking
-- ═════════════════════════════════════════════════════════════════════════════
il_loans AS (
    SELECT
        CASE
            -- %SECURED% belongs here too. Without it SECURED_TOP_UP loans fell
            -- into IEL, so this file reported LAP 88 while aum_status.sql (which
            -- has the clause) and Excel both reported 91. Verified 2026-08-08:
            -- 10038007, 10039190, 10040094 — Rs 2,63,835.
            WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
              OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
            THEN 'LAP'
            ELSE 'IEL'
        END                                    AS loan_source,
        la.loan_id,
        la.branch_id,
        la.loan_officer::varchar     AS lo_id,
        la.product_id::text          AS product_id,
        la.principal_outstanding,
        coalesce(la.dpd, 0)          AS dpd,
        -- Master overrides status to 'W' (write-off) when the loan existed at write-off
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END  AS status
    FROM public.loan_account_il la
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    -- Same live-book universe as aum_status.sql. Status alone is not enough:
    -- loans keep status 'A'/'I' after closing, so without the closure guard this
    -- report carried loans that had already closed (10009694 closed 13-Jul and
    -- 10014983 closed 03-Aug were still counted). ::date because IL timestamps
    -- carry a time-of-day.
    WHERE la.status IN ('A', 'D', 'I', 'W')
      AND la.loan_id >= 10000000                 -- drop junk/test ids
      AND (la.closure_date IS NULL
           OR la.closure_date::date > current_date - 1
           OR la.status = 'W')
),

-- ═════════════════════════════════════════════════════════════════════════════
-- JLG LOANS — dpd column read directly from core banking
-- home_loan_account has no branch_id; resolve via home_center_master
-- ═════════════════════════════════════════════════════════════════════════════
jlg_loans AS (
    SELECT
        'JLG'                        AS loan_source,
        la.loan_id,
        cm.branch_id,
        cm.assigned_to::varchar      AS lo_id,
        la.product_id::text          AS product_id,
        la.prin_os                   AS principal_outstanding,
        coalesce(la.dpd, 0)          AS dpd,
        -- Master overrides status to 'W' (write-off) when the loan existed at write-off
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END  AS status
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    WHERE la.status IN ('A', 'D', 'I', 'W')
      AND la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND (la.status != 'W' OR la.prin_os > 0)
      -- Closure guard, as in aum_status.sql — see the IL block above.
      AND (la.closure_date IS NULL
           OR la.closure_date::date > current_date - 1
           OR la.status = 'W')
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id            = la.loan_id
            AND il.status             IN ('A','D','I','W')
            AND il.disbursement_date  > la.disbursement_date
      )
),

all_loans AS (
    SELECT * FROM il_loans
    UNION ALL
    SELECT * FROM jlg_loans
)

-- ═════════════════════════════════════════════════════════════════════════════
-- FINAL AGGREGATION — identical structure to rpt_aum_status
-- dpd_as_of = current_date for live view (vs prev_month_end for EOM snapshot)
-- ═════════════════════════════════════════════════════════════════════════════
SELECT
    al.loan_source,
    -- Canonical labels (match rpt_aum_status + the loan_status slicer options).
    -- 'I' is a death case → Death. Master/core write-offs → Write-off.
    CASE al.status
        WHEN 'A' THEN 'Active'
        WHEN 'W' THEN 'Write-off'
        WHEN 'D' THEN 'Death'
        WHEN 'I' THEN 'Death'
        ELSE al.status
    END                                                                    AS loan_status,
    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    al.branch_id,
    coalesce(al.lo_id, 'N/A')              AS lo_id,
    al.product_id,

    count(al.loan_id)                                                     AS total_loans,
    count(CASE WHEN al.status IN ('D', 'I') THEN 1 END)                          AS death_cases,
    round(sum(al.principal_outstanding)::numeric, 2)                      AS total_pos,

    -- PAR 0+ (DPD >= 1)
    count(CASE WHEN al.dpd >= 1 THEN 1 END)                              AS par0_count,
    round(sum(CASE WHEN al.dpd >= 1
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS par0_pos,

    -- PAR 30+ (DPD > 30)
    count(CASE WHEN al.dpd > 30 THEN 1 END)                              AS par30_count,
    round(sum(CASE WHEN al.dpd > 30
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS par30_pos,
    -- PAR 60+ (DPD > 60)
    count(CASE WHEN al.dpd > 60 THEN 1 END)                              AS par60_count,
    round(sum(CASE WHEN al.dpd > 60
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS par60_pos,
    -- PAR 90+ / NPA (DPD > 90)
    count(CASE WHEN al.dpd > 90 THEN 1 END)                              AS par90_count,
    round(sum(CASE WHEN al.dpd > 90
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS par90_pos,

    -- DPD bucket breakdown (7 buckets: Regular, 1-30, 31-60, 61-90, 91-180, 181-360, 360+)
    count(CASE WHEN al.dpd = 0                    THEN 1 END)            AS standard_count,
    count(CASE WHEN al.dpd BETWEEN 1   AND 30  THEN 1 END)               AS dpd_1_30_count,
    count(CASE WHEN al.dpd BETWEEN 31  AND 60  THEN 1 END)               AS dpd_31_60_count,
    count(CASE WHEN al.dpd BETWEEN 61  AND 90  THEN 1 END)               AS dpd_61_90_count,
    count(CASE WHEN al.dpd BETWEEN 91  AND 180 THEN 1 END)               AS dpd_91_180_count,
    count(CASE WHEN al.dpd BETWEEN 181 AND 360 THEN 1 END)               AS dpd_181_360_count,
    count(CASE WHEN al.dpd > 360                   THEN 1 END)            AS dpd_360p_count,

    round(sum(CASE WHEN al.dpd = 0
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS standard_pos,
    round(sum(CASE WHEN al.dpd BETWEEN 1   AND 30
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS dpd_1_30_pos,
    round(sum(CASE WHEN al.dpd BETWEEN 31  AND 60
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS dpd_31_60_pos,
    round(sum(CASE WHEN al.dpd BETWEEN 61  AND 90
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS dpd_61_90_pos,
    round(sum(CASE WHEN al.dpd BETWEEN 91  AND 180
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS dpd_91_180_pos,
    round(sum(CASE WHEN al.dpd BETWEEN 181 AND 360
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS dpd_181_360_pos,
    round(sum(CASE WHEN al.dpd > 360
                   THEN al.principal_outstanding ELSE 0 END)::numeric, 2) AS dpd_360p_pos,

    -- dpd_as_of = today (live view; EOM snapshot uses prev_month_end)
    current_date                                                          AS dpd_as_of,
    current_date                                                          AS report_date

FROM all_loans al
LEFT JOIN hierarchy h ON h.branch_id = al.branch_id
GROUP BY
    al.loan_source, al.status, h.cluster_name, h.region_name, h.area_name, h.branch_name,
    al.branch_id, al.lo_id, al.product_id
ORDER BY
    al.loan_source, al.status, h.cluster_name, h.region_name, h.area_name, h.branch_name;
