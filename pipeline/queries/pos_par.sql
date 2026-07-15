-- =============================================================================
-- Report  : POS (Portfolio Outstanding) & PAR (Portfolio at Risk)
-- Schema  : public
-- Tables  : loan_account_il, home_loan_account, brnch_master, area_master,
--           center_master, repayment_schedule_il, repayment_detail_il,
--           repayment_schedule, repayment_detail
-- Granularity : LO → Branch → Area → Region → Cluster
-- Date    : EOM previous month (snapshot) + live (as-of today)
-- DPD     : Computed from repayment schedule vs collections
-- Status  : A=Active, X=Closed, W=Write-off, R=Reversed
-- =============================================================================

WITH

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DATE ANCHORS
-- ─────────────────────────────────────────────────────────────────────────────
date_anchors AS (
    SELECT
        (date_trunc('month', current_date) - interval '1 day')::date AS eom_date,
        current_date::date                                             AS live_date
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. BRANCH HIERARCHY
--    branch → area → region → cluster
-- ─────────────────────────────────────────────────────────────────────────────
hierarchy AS (
    SELECT
        bm.branch_id,
        bm.branch_name,
        a.area_name,
        bm.area_id,
        r.branch_id   AS region_id,
        r.branch_name AS region_name,
        c.area_id     AS cluster_id,
        c.area_name   AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master r ON bm.region_id = r.branch_id
    LEFT JOIN public.area_master  c ON r.area_id    = c.area_id
    WHERE bm.active      = 'Y'
      AND bm.is_region   = 'N'
      AND bm.branch_name <> 'DEMO'
      AND bm.closing_date IS NULL
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. COMPUTED DPD — IL (EOM)
--    collection_date_time is a timestamp on repayment_detail_il → cast to date
--    DPD = days between earliest OD demand_date and eom_date (inclusive)
--    extract(epoch)/86400 avoids all interval/integer cast issues
-- ─────────────────────────────────────────────────────────────────────────────
il_dpd_eom AS (
    SELECT
        rs.loan_id,
        greatest(
            extract(epoch from (
                da.eom_date::timestamp - min(rs.demand_date)::timestamp
            )) / 86400 + 1,
            0
        )::int AS dpd
    FROM public.repayment_schedule_il rs
    CROSS JOIN date_anchors da
    LEFT JOIN (
        SELECT
            loan_id,
            sum(principal_collected) AS total_collected
        FROM public.repayment_detail_il
        WHERE collection_date_time::date <= (
                  select eom_date from date_anchors
              )
          AND status IN ('A', 'V')
        GROUP BY loan_id
    ) rd ON rd.loan_id = rs.loan_id
    WHERE rs.demand_date <= da.eom_date
      AND coalesce(rd.total_collected, 0) < rs.cumulative_principal_due
    GROUP BY rs.loan_id, da.eom_date
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. COMPUTED DPD — IL (LIVE)
-- ─────────────────────────────────────────────────────────────────────────────
il_dpd_live AS (
    SELECT
        rs.loan_id,
        greatest(
            extract(epoch from (
                da.live_date::timestamp - min(rs.demand_date)::timestamp
            )) / 86400 + 1,
            0
        )::int AS dpd
    FROM public.repayment_schedule_il rs
    CROSS JOIN date_anchors da
    LEFT JOIN (
        SELECT
            loan_id,
            sum(principal_collected) AS total_collected
        FROM public.repayment_detail_il
        WHERE collection_date_time::date <= (
                  select live_date from date_anchors
              )
          AND status IN ('A', 'V')
        GROUP BY loan_id
    ) rd ON rd.loan_id = rs.loan_id
    WHERE rs.demand_date <= da.live_date
      AND coalesce(rd.total_collected, 0) < rs.cumulative_principal_due
    GROUP BY rs.loan_id, da.live_date
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. COMPUTED DPD — JLG (EOM)
--    collection_date on repayment_detail is a plain date — no cast needed
-- ─────────────────────────────────────────────────────────────────────────────
jlg_dpd_eom AS (
    SELECT
        rs.loan_id,
        greatest(
            extract(epoch from (
                da.eom_date::timestamp - min(rs.demand_date)::timestamp
            )) / 86400 + 1,
            0
        )::int AS dpd
    FROM public.repayment_schedule rs
    CROSS JOIN date_anchors da
    LEFT JOIN (
        SELECT
            loan_id,
            sum(principal_collected) AS total_collected
        FROM public.repayment_detail
        WHERE collection_date <= (
                  select eom_date from date_anchors
              )
          AND status IN ('A', 'V')
        GROUP BY loan_id
    ) rd ON rd.loan_id = rs.loan_id
    WHERE rs.demand_date <= da.eom_date
      AND coalesce(rd.total_collected, 0) < rs.cumulative_principal_due
    GROUP BY rs.loan_id, da.eom_date
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. COMPUTED DPD — JLG (LIVE)
-- ─────────────────────────────────────────────────────────────────────────────
jlg_dpd_live AS (
    SELECT
        rs.loan_id,
        greatest(
            extract(epoch from (
                da.live_date::timestamp - min(rs.demand_date)::timestamp
            )) / 86400 + 1,
            0
        )::int AS dpd
    FROM public.repayment_schedule rs
    CROSS JOIN date_anchors da
    LEFT JOIN (
        SELECT
            loan_id,
            sum(principal_collected) AS total_collected
        FROM public.repayment_detail
        WHERE collection_date <= (
                  select live_date from date_anchors
              )
          AND status IN ('A', 'V')
        GROUP BY loan_id
    ) rd ON rd.loan_id = rs.loan_id
    WHERE rs.demand_date <= da.live_date
      AND coalesce(rd.total_collected, 0) < rs.cumulative_principal_due
    GROUP BY rs.loan_id, da.live_date
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 7a. IL LOAN UNIVERSE — EOM
-- ─────────────────────────────────────────────────────────────────────────────
il_eom AS (
    SELECT
        'IL'                     AS loan_source,
        'EOM'                    AS report_type,
        da.eom_date              AS report_date,
        la.loan_id,
        la.branch_id,
        la.loan_officer          AS lo_id,
        la.principal_outstanding AS pos,
        coalesce(dpd.dpd, 0)     AS dpd
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    LEFT JOIN il_dpd_eom dpd ON dpd.loan_id = la.loan_id
    WHERE la.disbursement_date <= da.eom_date
      AND la.status NOT IN ('X', 'R')
      AND (
            la.status = 'A'
            OR (la.status = 'W' AND la.closure_date > da.eom_date)
          )
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 7b. IL LOAN UNIVERSE — LIVE
-- ─────────────────────────────────────────────────────────────────────────────
il_live AS (
    SELECT
        'IL'                     AS loan_source,
        'LIVE'                   AS report_type,
        da.live_date             AS report_date,
        la.loan_id,
        la.branch_id,
        la.loan_officer          AS lo_id,
        la.principal_outstanding AS pos,
        coalesce(dpd.dpd, 0)     AS dpd
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    LEFT JOIN il_dpd_live dpd ON dpd.loan_id = la.loan_id
    WHERE la.disbursement_date <= da.live_date
      AND la.status NOT IN ('X', 'R')
      AND (
            la.status = 'A'
            OR (la.status = 'W' AND la.closure_date > da.live_date)
          )
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 8a. JLG LOAN UNIVERSE — EOM
--     branch linked via center_master
-- ─────────────────────────────────────────────────────────────────────────────
jlg_eom AS (
    SELECT
        'JLG'                AS loan_source,
        'EOM'                AS report_type,
        da.eom_date          AS report_date,
        hla.loan_id,
        cm.branch_id,
        cm.assigned_to::varchar AS lo_id,
        hla.prin_os          AS pos,
        coalesce(dpd.dpd, 0) AS dpd
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    LEFT JOIN jlg_dpd_eom dpd ON dpd.loan_id = hla.loan_id
    WHERE hla.disbursement_date <= da.eom_date
      AND hla.status NOT IN ('X', 'R')
      AND (
            hla.status = 'A'
            OR (hla.status = 'W' AND hla.closure_date > da.eom_date)
          )
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 8b. JLG LOAN UNIVERSE — LIVE
-- ─────────────────────────────────────────────────────────────────────────────
jlg_live AS (
    SELECT
        'JLG'                AS loan_source,
        'LIVE'               AS report_type,
        da.live_date         AS report_date,
        hla.loan_id,
        cm.branch_id,
        cm.assigned_to::varchar AS lo_id,
        hla.prin_os          AS pos,
        coalesce(dpd.dpd, 0) AS dpd
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    LEFT JOIN jlg_dpd_live dpd ON dpd.loan_id = hla.loan_id
    WHERE hla.disbursement_date <= da.live_date
      AND hla.status NOT IN ('X', 'R')
      AND (
            hla.status = 'A'
            OR (hla.status = 'W' AND hla.closure_date > da.live_date)
          )
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. UNION ALL FOUR UNIVERSES
-- ─────────────────────────────────────────────────────────────────────────────
all_loans AS (
    SELECT * FROM il_eom
    UNION ALL
    SELECT * FROM il_live
    UNION ALL
    SELECT * FROM jlg_eom
    UNION ALL
    SELECT * FROM jlg_live
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. PAR FLAGS AT LOAN LEVEL
-- ─────────────────────────────────────────────────────────────────────────────
loan_with_flags AS (
    SELECT
        al.*,
        case when al.dpd > 0  then 1 else 0 end AS is_par0,
        case when al.dpd > 30 then 1 else 0 end AS is_par30,
        case when al.dpd > 60 then 1 else 0 end AS is_par60,
        case when al.dpd > 90 then 1 else 0 end AS is_par90,
        case when al.dpd > 0  then al.pos else 0 end AS par0_pos,
        case when al.dpd > 30 then al.pos else 0 end AS par30_pos,
        case when al.dpd > 60 then al.pos else 0 end AS par60_pos,
        case when al.dpd > 90 then al.pos else 0 end AS par90_pos
    FROM all_loans al
)

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. FINAL AGGREGATION
--     One row per: report_type × loan_source × cluster × region × area × branch × lo
--     Dashboard re-aggregates to any level needed.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    lf.report_type,
    lf.report_date,
    lf.loan_source,

    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    lf.branch_id,
    coalesce(lf.lo_id, 'N/A')             AS lo_id,

    count(lf.loan_id)                      AS total_loans,
    round(sum(lf.pos)::numeric, 2)         AS total_pos,

    sum(lf.is_par0)                        AS par0_count,
    sum(lf.is_par30)                       AS par30_count,
    sum(lf.is_par60)                       AS par60_count,
    sum(lf.is_par90)                       AS par90_count,

    round(sum(lf.par0_pos)::numeric,  2)   AS par0_pos,
    round(sum(lf.par30_pos)::numeric, 2)   AS par30_pos,
    round(sum(lf.par60_pos)::numeric, 2)   AS par60_pos,
    round(sum(lf.par90_pos)::numeric, 2)   AS par90_pos,

    round(case when sum(lf.pos) > 0
          then sum(lf.par0_pos)  / sum(lf.pos) else 0 end::numeric, 4) AS par0_pct,
    round(case when sum(lf.pos) > 0
          then sum(lf.par30_pos) / sum(lf.pos) else 0 end::numeric, 4) AS par30_pct,
    round(case when sum(lf.pos) > 0
          then sum(lf.par60_pos) / sum(lf.pos) else 0 end::numeric, 4) AS par60_pct,
    round(case when sum(lf.pos) > 0
          then sum(lf.par90_pos) / sum(lf.pos) else 0 end::numeric, 4) AS par90_pct

FROM loan_with_flags lf
LEFT JOIN hierarchy h ON lf.branch_id = h.branch_id

GROUP BY
    lf.report_type,
    lf.report_date,
    lf.loan_source,
    h.cluster_name,
    h.region_name,
    h.area_name,
    h.branch_name,
    lf.branch_id,
    lf.lo_id

ORDER BY
    lf.report_type,
    lf.loan_source,
    h.cluster_name,
    h.region_name,
    h.area_name,
    h.branch_name,
    lf.lo_id;