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
-- 0. WRITE-OFF MASTER (loan_id, wo_date)
--    Overrides a loan's STATUS to 'Write-off' when the master applies (loan
--    existed at write-off: disbursement_date <= wo_date). Universe is unchanged;
--    the Excl-W/O view (loan_status <> 'Write-off') then matches Excel + Current
--    Outstanding. Core open write-offs (status 'W') also label as 'Write-off'.
-- ─────────────────────────────────────────────────────────────────────────────
wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date
    FROM (VALUES {wo_pairs}) AS v(loan_id, wo_date)
),

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DATE ANCHORS
-- ─────────────────────────────────────────────────────────────────────────────
date_anchors AS (
    SELECT
        -- LAST COMPLETED month-end (NOT T-1 anchored): on 1-Aug this must be
        -- 31-Jul, the month that just closed with full data. Anchoring on T-1
        -- would resolve to 30-Jun and silently discard all of July — the same
        -- trap as the trend engines. This snapshot is never empty, so it does
        -- not need the 1st-of-month MTD fix applied elsewhere.
        (date_trunc('month', current_date) - interval '1 day')::date   AS eom_date,
        -- LIVE = the DATA date (T-1). Current Outstanding uses current_date - 1;
        -- using current_date here made the two disagree on loans closed yesterday.
        (current_date - 1)::date                                       AS live_date
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
-- 6c. POS AS AT THE MONTH-END (not today's POS)
--     The EOM snapshot must state POS as it stood on eom_date. Using the live
--     principal_outstanding understates it, because loans repay during the
--     current month and loans closed since read 0. Same measure as
--     aum_status.sql's prev_pos, so POS & PAR EOM ties OD Status / the trend.
-- ─────────────────────────────────────────────────────────────────────────────
il_pos_eom AS (
    SELECT rd.loan_id, sum(coalesce(rd.principal_collected, 0)) AS prin_coll
    FROM public.repayment_detail_il rd
    CROSS JOIN date_anchors da
    WHERE rd.collection_date_time::date <= da.eom_date
      AND rd.status IN ('A', 'V')
    GROUP BY rd.loan_id
),

jlg_pos_eom AS (
    SELECT rd.loan_id, sum(coalesce(rd.principal_collected, 0)) AS prin_coll
    FROM public.repayment_detail rd
    CROSS JOIN date_anchors da
    WHERE rd.collection_date::date <= da.eom_date
      AND rd.status IN ('A', 'V')
    GROUP BY rd.loan_id
),

-- Disbursed-so-far at eom_date for STAGED (tranched) IL loans — see the matching
-- block in aum_status.sql. Basing month-end POS on total_loan_amount reported
-- undisbursed sanction as outstanding (Rs 2,57,829 over 4 loans on 2026-07-31).
-- LIVE POS is untouched: it reads principal_outstanding, which already nets this off.
il_disb_eom AS MATERIALIZED (
    SELECT DISTINCT ON (a.loan_id)
           a.loan_id, a.principal_total AS disbursed
    FROM public.loan_account_il_audit a
    CROSS JOIN date_anchors da
    WHERE a.principal_total IS NOT NULL
      AND coalesce(a.modified_on, a.created_on) IS NOT NULL
      AND coalesce(a.modified_on, a.created_on)::date <= da.eom_date
      AND a.loan_id IN (
          SELECT loan_id FROM public.loan_account_il_audit
          WHERE principal_total IS NOT NULL AND total_loan_amount IS NOT NULL
          GROUP BY loan_id HAVING bool_or(principal_total <> total_loan_amount))
    ORDER BY a.loan_id, coalesce(a.modified_on, a.created_on) DESC
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
        -- POS AS AT eom_date, not today's balance — see il_pos_eom.
        greatest(coalesce(de.disbursed, la.total_loan_amount, 0)
                 - coalesce(pe.prin_coll, 0), 0) AS pos,
        coalesce(dpd.dpd, 0)     AS dpd,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'Write-off' ELSE 'Active' END  AS loan_status
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    LEFT JOIN wo_master w    ON w.loan_id   = la.loan_id
    LEFT JOIN il_dpd_eom dpd ON dpd.loan_id = la.loan_id
    LEFT JOIN il_pos_eom pe  ON pe.loan_id  = la.loan_id
    LEFT JOIN il_disb_eom de ON de.loan_id = la.loan_id
    -- ::date on BOTH sides of every anchor compare. IL disbursement/closure dates are
    -- TIMESTAMPs with a real time-of-day (4,809 of 7,743 rows); the anchors are DATEs.
    -- Uncast, a loan disbursed at 17:14 on the anchor day is dropped, and one closed
    -- at 17:14 on the anchor day is held open. JLG is always 00:00:00, so IL only.
    WHERE la.disbursement_date::date <= da.eom_date
      AND la.status <> 'R'
      AND (
            -- Death cases (D / I) are still OUTSTANDING loans and must be counted,
            -- exactly like Current Outstanding / Trend. Excluding them made POS & PAR
            -- read 94,021 against Current Outstanding's 94,119 (99 death loans).
            (la.status IN ('A','D','I')
             AND (la.closure_date IS NULL OR la.closure_date::date > da.eom_date))
            OR (la.status = 'W' AND la.closure_date::date > da.eom_date)
            -- CLOSED SINCE the snapshot: status is 'X' today, but the loan was on
            -- book on eom_date, so the month-end portfolio must include it. Without
            -- this, EOM read 93,923 against the 94,201 month-end (278 closures).
            -- LIVE deliberately does NOT get this branch — 'X' is closed now.
            OR (la.status = 'X' AND la.closure_date::date > da.eom_date)
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
        coalesce(dpd.dpd, 0)     AS dpd,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'Write-off' ELSE 'Active' END  AS loan_status
    FROM public.loan_account_il la
    CROSS JOIN date_anchors da
    LEFT JOIN wo_master w     ON w.loan_id   = la.loan_id
    LEFT JOIN il_dpd_live dpd ON dpd.loan_id = la.loan_id
    WHERE la.disbursement_date::date <= da.live_date       -- ::date: see il_eom note
      AND la.status NOT IN ('X', 'R')
      AND (
            -- Death cases (D / I) are still OUTSTANDING loans and must be counted,
            -- exactly like Current Outstanding / Trend. Excluding them made POS & PAR
            -- read 94,021 against Current Outstanding's 94,119 (99 death loans).
            (la.status IN ('A','D','I')
             AND (la.closure_date IS NULL OR la.closure_date::date > da.live_date))
            OR (la.status = 'W' AND la.closure_date::date > da.live_date)
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
        -- POS AS AT eom_date, not today's balance — see jlg_pos_eom.
        greatest(coalesce(hla.total_loan_amount, 0) - coalesce(pe.prin_coll, 0), 0) AS pos,
        coalesce(dpd.dpd, 0) AS dpd,
        CASE WHEN hla.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR hla.disbursement_date::date <= w.wo_date))
             THEN 'Write-off' ELSE 'Active' END  AS loan_status
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    LEFT JOIN wo_master w     ON w.loan_id   = hla.loan_id
    LEFT JOIN jlg_dpd_eom dpd ON dpd.loan_id = hla.loan_id
    LEFT JOIN jlg_pos_eom pe  ON pe.loan_id  = hla.loan_id
    WHERE hla.disbursement_date::date <= da.eom_date   -- ::date: see il_eom note
      AND hla.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND hla.status <> 'R'
      AND (
            -- Death cases (D / I) count — see note in the IL block above.
            (hla.status IN ('A','D','I')
             AND (hla.closure_date IS NULL OR hla.closure_date::date > da.eom_date))
            OR (hla.status = 'W' AND hla.closure_date::date > da.eom_date)
            -- Closed SINCE the snapshot — on book at eom_date. See il_eom.
            OR (hla.status = 'X' AND hla.closure_date::date > da.eom_date)
          )
      -- Cross-listed loan_id: IL is primary when the IL loan was disbursed later
      -- (customers graduate JLG -> IL). Stock report, so count the loan once.
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id = hla.loan_id
            AND il.status IN ('A','D','I','W')
            AND il.disbursement_date > hla.disbursement_date
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
        coalesce(dpd.dpd, 0) AS dpd,
        CASE WHEN hla.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR hla.disbursement_date::date <= w.wo_date))
             THEN 'Write-off' ELSE 'Active' END  AS loan_status
    FROM public.home_loan_account hla
    JOIN public.home_center_master cm ON hla.center_id = cm.center_id
    CROSS JOIN date_anchors da
    LEFT JOIN wo_master w      ON w.loan_id   = hla.loan_id
    LEFT JOIN jlg_dpd_live dpd ON dpd.loan_id = hla.loan_id
    WHERE hla.disbursement_date::date <= da.live_date  -- ::date: see il_eom note
      AND hla.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND hla.status NOT IN ('X', 'R')
      AND (
            -- Death cases (D / I) count — see note in the IL block above.
            (hla.status IN ('A','D','I')
             AND (hla.closure_date IS NULL OR hla.closure_date::date > da.live_date))
            OR (hla.status = 'W' AND hla.closure_date::date > da.live_date)
          )
      -- Cross-listed loan_id: IL is primary when the IL loan was disbursed later
      -- (customers graduate JLG -> IL). Stock report, so count the loan once.
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id = hla.loan_id
            AND il.status IN ('A','D','I','W')
            AND il.disbursement_date > hla.disbursement_date
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
    lf.loan_status,

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
    lf.loan_status,
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