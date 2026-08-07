-- =============================================================================
-- TREND ENGINE — JLG: monthly series over ALL available history.
-- One row out per (month_end × segment × branch × lo). All measures stored as
-- ADDITIVE components so the backend can group by any AP and apply user scope;
-- ratios (PAR%, CE%, roll rate) are computed at read time.
--
-- Method: per-loan MONTHLY ledger (demand vs collection by month) + window
-- cumulatives → EOM POS. DAY-LEVEL DPD (OD-script method: days since the earliest
-- still-unpaid demand, from stored cumulative_*_due vs cumulative A-collections),
-- proven == the core live dpd; PAR>0/30/60/90 = dpd>=1/>30/>60/>90 (matches live).
-- Written-off loans (writeoff_date) leave POS/PAR from the write-off month;
-- their later collections are counted as wo_recovery.
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
last_m AS (   -- last COMPLETED month
    SELECT (date_trunc('month', current_date) - interval '1 month')::date AS m
),

hierarchy AS (
    SELECT bm.branch_id, bm.branch_name, a.area_name,
        reg.branch_name AS region_name, clus.area_name AS cluster_name,
        z.area_name AS zone_name
    , bm.state_id, bm.district_id
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
    LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
    LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
    LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id
),

-- Graduation: many JLG customers move JLG -> IL. Their old JLG loan is left as a
-- stale status='A' with NULL closure_date, so its DPD grows without bound. The
-- live report drops it via later-disbursement-wins; here we do the MONTH-AWARE
-- version — the JLG loan is on-book only until the month its IL successor was
-- disbursed (keeps real pre-graduation history, stops it at graduation).
il_grad AS (
    SELECT loan_id, min(disbursement_date)::date AS il_disb
    FROM public.loan_account_il
    WHERE status IN ('A','D','I','W') AND disbursement_date IS NOT NULL
    GROUP BY loan_id
),

loans AS (
    SELECT la.loan_id, cm.branch_id,
        cm.assigned_to::varchar                        AS lo_id,
        'JLG'::text                                    AS business_segment,
        -- Death cases follow the CORE — but ONLY where the core actually zeroed the
        -- DPD. The core does NOT do this uniformly (of 108 open death loans, 31 still
        -- carry DPD > 0). Blanket-zeroing would turn those into false "OD Slippage"
        -- (Regular at month-end -> OD now). Zero only when the core says 0, so the
        -- reconstruction agrees with the live book in BOTH directions.
        (la.status IN ('D','I') AND coalesce(la.dpd,0) = 0)  AS is_death,
        la.total_loan_amount                           AS orig_amount,
        la.disbursement_date::date                     AS disb_date,
        la.closure_date::date                          AS closure_date,
        -- month the customer graduated to IL (NULL if never / earlier IL loan)
        CASE WHEN g.il_disb > la.disbursement_date::date
             THEN date_trunc('month', g.il_disb)::date END AS grad_month,
        -- Tier 1+2 slicer dims (static per loan; grain widened for the trend).
        -- Formats mirror rpt_aum_status so labels/filters match across tables.
        extract(year FROM la.disbursement_date)::text  AS disb_year,
        coalesce(la.cycle::text, 'N/A')                AS cycle_no,
        coalesce(pc.product_classification, 'Other')   AS prod_classification,
        -- Write-off month. The MASTER (w.wo_date) marks loans written off even
        -- when the core still shows status='A' with a NULL writeoff_date — those
        -- must leave the Excl-W/O book from the master's write-off month, else
        -- they linger with runaway DPD. Use the core date if present, else the
        -- master's. (Mirrors aum_status raw_status, which flags them via w.)
        CASE WHEN la.status = 'W'
                  OR (w.loan_id IS NOT NULL
                      AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN date_trunc('month', coalesce(la.writeoff_date, w.wo_date))::date END AS wo_month,
        -- Same test, DAY precision. wo_recovery is measured against the write-off
        -- DATE, not its month: a collection taken later in the write-off month is
        -- still a recovery. Verified against Excel 2026-08-07 (Sep-25 within Rs 9).
        CASE WHEN la.status = 'W'
                  OR (w.loan_id IS NOT NULL
                      AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN coalesce(la.writeoff_date, w.wo_date)::date END AS wo_dt
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    -- Converted loans' JLG history is real up to graduation; grad_month (below)
    -- ends the grid the month the IL successor is disbursed.
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    LEFT JOIN il_grad   g ON g.loan_id = la.loan_id
    LEFT JOIN public.loan_product     lp ON lp.product_id  = la.product_id
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
    WHERE la.status <> 'R'
      AND la.disbursement_date IS NOT NULL
      AND la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      -- Chunk predicate. Everything downstream is PER-LOAN (all window functions
      -- partition by loan_id; the final GROUP BY is additive), so filtering the
      -- loan universe here yields an exact partition of the work. runner.py runs
      -- N balanced loan_id chunks and re-aggregates — each chunk is short enough
      -- to finish before the replica cancels the connection. Empty = whole book
      -- (e.g. running the file directly in pgAdmin).
      {chunk_pred}
),

-- monthly demand ledger
sched_m AS (
    SELECT rs.loan_id,
        date_trunc('month', rs.demand_date)::date AS m,
        sum(coalesce(rs.principal_due,0) + coalesce(rs.interest_due,0)) AS due,
        sum(coalesce(rs.principal_due,0))                               AS due_prin
    FROM public.repayment_schedule rs
    JOIN loans l ON l.loan_id = rs.loan_id
    WHERE rs.demand_date <= (SELECT m FROM last_m) + interval '1 month' - interval '1 day'
    GROUP BY rs.loan_id, 2
),

-- monthly collection ledger — status A only, dated by collection_date (JLG),
-- matching the live report so the day-level DPD ties exactly.
coll_m AS (
    SELECT rd.loan_id,
        date_trunc('month', rd.collection_date)::date AS m,
        sum(coalesce(rd.principal_collected,0) + coalesce(rd.interest_collected,0)) AS coll,
        sum(coalesce(rd.principal_collected,0))                                     AS coll_prin,
        sum(coalesce(rd.interest_collected,0))                                      AS coll_int
    FROM public.repayment_detail rd
    JOIN loans l ON l.loan_id = rd.loan_id
    WHERE rd.status = 'A'
      AND rd.collection_date::date <= (SELECT m FROM last_m) + interval '1 month' - interval '1 day'
    GROUP BY rd.loan_id, 2
),

-- demand schedule at demand-date grain with STORED cumulative due (day-level DPD).
-- Cumulative due kept SEPARATE for principal and interest — the DPD test compares
-- principal-vs-principal and interest-vs-interest (same rule as aum_status.sql and
-- the reference Bucket_Movement .pbit), not the P+I lump sum.
demands AS (
    SELECT rs.loan_id, rs.demand_date::date AS dd,
        coalesce(rs.cumulative_principal_due,0) AS cum_prin_due,
        coalesce(rs.cumulative_interest_due,0)  AS cum_int_due
    FROM public.repayment_schedule rs
    JOIN loans l ON l.loan_id = rs.loan_id
    WHERE rs.demand_date::date <= (SELECT m FROM last_m) + interval '1 month' - interval '1 day'
),

-- per-loan month grid: DISBURSEMENT month → the earliest of {closure month,
-- graduation month − 1 (IL successor takes over), last completed month}. Bounds
-- the loan's real on-book life the way the live report does.
grid AS (
    SELECT l.loan_id,
        generate_series(
            date_trunc('month', l.disb_date)::date,
            least(
                -- Last on-book month = month BEFORE closure (loan closed mid-M is not
                -- on-book at M-end; matches aum_status closure_date>month_end and drops
                -- settled/written-off closures that leave a positive reconstructed POS).
                coalesce((date_trunc('month', l.closure_date) - interval '1 month')::date, (SELECT m FROM last_m)),
                coalesce((l.grad_month - interval '1 month')::date,  (SELECT m FROM last_m)),
                (SELECT m FROM last_m)),
            interval '1 month')::date AS m
    FROM loans l
),

ledger AS (
    SELECT g.loan_id, g.m,
        coalesce(s.due, 0)       AS due,
        coalesce(s.due_prin, 0)  AS due_prin,
        coalesce(c.coll, 0)      AS coll,
        coalesce(c.coll_prin, 0) AS coll_prin,
        coalesce(c.coll_int, 0)  AS coll_int
    FROM grid g
    LEFT JOIN sched_m s ON s.loan_id = g.loan_id AND s.m = g.m
    LEFT JOIN coll_m  c ON c.loan_id = g.loan_id AND c.m = g.m
),

cums AS (
    SELECT loan_id, m, due, coll,
        sum(due)       OVER w AS cum_due,
        sum(coll)      OVER w AS cum_coll,
        sum(coll_prin) OVER w AS cum_coll_prin,
        sum(coll_int)  OVER w AS cum_coll_int
    FROM ledger
    WINDOW w AS (PARTITION BY loan_id ORDER BY m
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),

-- DAY-LEVEL DPD per loan-month (OD-script method — proven == core's live dpd).
dpd AS (
    SELECT c.loan_id, c.m,
        coalesce(
            (c.m + interval '1 month' - interval '1 day')::date
            - min(d.dd) FILTER (WHERE d.cum_prin_due > c.cum_coll_prin + 0.005
                                   OR d.cum_int_due  > c.cum_coll_int  + 0.005) + 1,
            0) AS dpd
    FROM cums c
    JOIN demands d ON d.loan_id = c.loan_id
       AND d.dd <= (c.m + interval '1 month' - interval '1 day')::date
    GROUP BY c.loan_id, c.m
),

state AS (
    SELECT c.loan_id, c.m, c.due, c.coll,
        -- CE numerator with NBFC advance carry-forward. Cap on the CUMULATIVE
        -- demand vs collection (not per-month), so an over-payment in month M is
        -- held as advance and applied to LATER demand instead of being discarded.
        -- coll_capped(M) = Δ least(cum_coll, cum_due). least() of two monotone
        -- non-decreasing series is non-decreasing → the delta is >= 0; the outer
        -- greatest(...,0) is only a rounding/reversal safety clamp.
        greatest(
            least(c.cum_coll, c.cum_due)
            - coalesce(lag(least(c.cum_coll, c.cum_due))
                       OVER (PARTITION BY c.loan_id ORDER BY c.m), 0),
            0)                                                    AS coll_capped,
        -- death cases follow the core (DPD 0); see loans.is_death
        CASE WHEN l.is_death THEN 0 ELSE coalesce(dp.dpd, 0) END  AS dpd,
        greatest(l.orig_amount - c.cum_coll_prin, 0)              AS pos,
        l.branch_id, l.lo_id, l.business_segment, l.wo_month,
        l.disb_year, l.cycle_no, l.prod_classification
    FROM cums c
    JOIN loans l ON l.loan_id = c.loan_id
    LEFT JOIN dpd dp ON dp.loan_id = c.loan_id AND dp.m = c.m
),

flags AS (
    SELECT *,
        lag(dpd) OVER (PARTITION BY loan_id ORDER BY m) AS prev_dpd,
        lag(pos) OVER (PARTITION BY loan_id ORDER BY m) AS prev_pos,
        (wo_month IS NOT NULL AND m >= wo_month)         AS is_wo,
        (wo_month IS NOT NULL AND m >  wo_month)         AS is_post_wo
    FROM state
),

-- Post-write-off recovery, taken STRAIGHT FROM THE COLLECTION LEDGER.
--
-- It deliberately does NOT go through `grid`/`flags`. The grid ends a loan's
-- month series at the month BEFORE closure, and a write-off normally CLOSES the
-- loan — so every recovery month fell outside the grid and was silently dropped.
-- Measured 2026-08-07: rpt_trend_full ran 35-45% under Excel every month, while
-- this ledger-based figure lands on it (Sep-25 within Rs 9, Mar-26 within
-- Rs 5,389). Only loans are joined here, never the grid, so a closed loan still
-- reports the cash it brings in.
--
-- Stock measures keep the grid truncation, which is correct for them: a loan
-- closed mid-month is not on-book at month-end.
wo_rec_m AS (
    SELECT date_trunc('month', rd.collection_date)::date AS m,
        l.branch_id, l.lo_id, l.business_segment,
        l.disb_year, l.cycle_no, l.prod_classification,
        sum(coalesce(rd.principal_collected, 0)
          + coalesce(rd.interest_collected, 0))            AS wo_recovery
    FROM public.repayment_detail rd
    JOIN loans l ON l.loan_id = rd.loan_id
    WHERE rd.status = 'A'
      AND l.wo_dt IS NOT NULL
      AND rd.collection_date::date > l.wo_dt
      AND date_trunc('month', rd.collection_date)::date <= (SELECT m FROM last_m)
    GROUP BY 1, 2, 3, 4, 5, 6, 7
),

-- monthly disbursement (independent of the repayment ledger)
disb_m AS (
    SELECT date_trunc('month', disb_date)::date AS m,
        branch_id, lo_id, business_segment,
        disb_year, cycle_no, prod_classification,
        count(*)         AS disb_count,
        sum(orig_amount) AS disb_amount
    FROM loans
    WHERE disb_date <= (SELECT m FROM last_m) + interval '1 month' - interval '1 day'
    GROUP BY 1, 2, 3, 4, 5, 6, 7
),

agg AS (
    SELECT
        f.m, f.business_segment, f.branch_id, f.lo_id,
        f.disb_year, f.cycle_no, f.prod_classification,
        -- portfolio at month end (write-offs excluded from POS/PAR)
        -- A loan is counted until its STATUS changes — a fully-repaid but still-open
        -- loan (POS 0) stays in the count, matching the live book. (No `pos > 0`.)
        count(*)                FILTER (WHERE NOT f.is_wo)                             AS loans_eom,
        sum(f.pos)              FILTER (WHERE NOT f.is_wo)                             AS pos_eom,
        sum(f.pos)              FILTER (WHERE NOT f.is_wo AND f.dpd >= 1)              AS par0_pos,
        sum(f.pos)              FILTER (WHERE NOT f.is_wo AND f.dpd > 30)             AS par30_pos,
        sum(f.pos)              FILTER (WHERE NOT f.is_wo AND f.dpd > 60)             AS par60_pos,
        sum(f.pos)              FILTER (WHERE NOT f.is_wo AND f.dpd > 90)             AS par90_pos,
        -- write-off book at month end (feeds the With/Excl W-O portfolio toggle).
        -- Mirrors the live report, where a written-off loan sits in EVERY PAR
        -- band, so "With W/O" adds wo_pos_eom to POS and to each PAR numerator.
        count(*)                FILTER (WHERE f.is_wo AND f.pos > 0)                   AS wo_loans_eom,
        sum(f.pos)              FILTER (WHERE f.is_wo)                                 AS wo_pos_eom,
        -- month flows (collection_capped = per-loan min(coll, due) — CE numerator).
        -- Stored EXCL write-off (NOT is_wo); the *_wo companions below carry the
        -- write-off portion so the backend can fold a "With W/O" view. is_wo is
        -- chronological (month >= write-off month), so a loan contributes to the
        -- live book until its write-off month, then moves to the write-off side.
        sum(f.due)              FILTER (WHERE NOT f.is_wo)                             AS demand,
        sum(f.coll)             FILTER (WHERE NOT f.is_wo)                             AS collection,
        sum(f.coll_capped)      FILTER (WHERE NOT f.is_wo)                             AS collection_capped,
        -- slippage: Regular (dpd 0) last month-end → OD (dpd>=1) this month-end
        count(*)                FILTER (WHERE NOT f.is_wo AND f.dpd >= 1
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS slip_count,
        sum(f.pos)              FILTER (WHERE NOT f.is_wo AND f.dpd >= 1
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS slip_pos,
        sum(f.prev_pos)         FILTER (WHERE NOT f.is_wo
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS prev_regular_pos,
        -- CE% on loans Regular at previous month-end
        sum(f.due)              FILTER (WHERE NOT f.is_wo
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS reg_demand,
        sum(f.coll_capped)      FILTER (WHERE NOT f.is_wo
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS reg_collection,
        -- collections this month from loans PAR>60 at previous month-end
        sum(f.coll)             FILTER (WHERE NOT f.is_wo
                                          AND coalesce(f.prev_dpd, 0) > 60)            AS par60_collection,
        -- post-write-off recovery
        sum(f.coll)             FILTER (WHERE f.is_post_wo)                            AS wo_recovery,
        -- write-off PORTION of the flow measures (is_wo). "With W/O" = base + *_wo,
        -- mirroring pos_eom + wo_pos_eom. Lets CE / roll-rate / slippage offer both
        -- views, matching each live report's Excl./With. W/O toggle.
        sum(f.due)              FILTER (WHERE f.is_wo)                                 AS demand_wo,
        sum(f.coll_capped)      FILTER (WHERE f.is_wo)                                 AS collection_capped_wo,
        count(*)                FILTER (WHERE f.is_wo AND f.dpd >= 1
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS slip_count_wo,
        sum(f.pos)              FILTER (WHERE f.is_wo AND f.dpd >= 1
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS slip_pos_wo,
        sum(f.prev_pos)         FILTER (WHERE f.is_wo
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS prev_regular_pos_wo,
        sum(f.due)              FILTER (WHERE f.is_wo
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS reg_demand_wo,
        sum(f.coll_capped)      FILTER (WHERE f.is_wo
                                          AND coalesce(f.prev_dpd, 0) = 0)             AS reg_collection_wo
    FROM flags f
    GROUP BY 1, 2, 3, 4, 5, 6, 7
)

, joined AS (
    SELECT
        coalesce(a.m, d.m, r.m)                                   AS m,
        coalesce(a.business_segment, d.business_segment, r.business_segment)     AS business_segment,
        coalesce(a.branch_id, d.branch_id, r.branch_id)                   AS branch_id,
        coalesce(a.lo_id, d.lo_id, r.lo_id)                           AS lo_id,
        coalesce(a.disb_year, d.disb_year, r.disb_year)                   AS disb_year,
        coalesce(a.cycle_no, d.cycle_no, r.cycle_no)                     AS cycle_no,
        coalesce(a.prod_classification, d.prod_classification, r.prod_classification) AS prod_classification,
        a.loans_eom, a.pos_eom, a.par0_pos, a.par30_pos, a.par60_pos, a.par90_pos,
        a.wo_loans_eom, a.wo_pos_eom,
        a.demand, a.collection, a.collection_capped,
        a.slip_count, a.slip_pos, a.prev_regular_pos,
        a.reg_demand, a.reg_collection, a.par60_collection,
        r.wo_recovery,
        a.demand_wo, a.collection_capped_wo, a.slip_count_wo, a.slip_pos_wo,
        a.prev_regular_pos_wo, a.reg_demand_wo, a.reg_collection_wo,
        d.disb_count, d.disb_amount
    FROM agg a
    FULL OUTER JOIN disb_m d
        ON d.m = a.m AND d.branch_id = a.branch_id
       AND d.lo_id IS NOT DISTINCT FROM a.lo_id
       AND d.business_segment = a.business_segment
       AND d.disb_year IS NOT DISTINCT FROM a.disb_year
       AND d.cycle_no  IS NOT DISTINCT FROM a.cycle_no
       AND d.prod_classification IS NOT DISTINCT FROM a.prod_classification
    FULL OUTER JOIN wo_rec_m r
        ON r.m = coalesce(a.m, d.m) AND r.branch_id = coalesce(a.branch_id, d.branch_id)
       AND r.lo_id IS NOT DISTINCT FROM coalesce(a.lo_id, d.lo_id)
       AND r.business_segment = coalesce(a.business_segment, d.business_segment)
       AND r.disb_year IS NOT DISTINCT FROM coalesce(a.disb_year, d.disb_year)
       AND r.cycle_no  IS NOT DISTINCT FROM coalesce(a.cycle_no, d.cycle_no)
       AND r.prod_classification IS NOT DISTINCT FROM coalesce(a.prod_classification, d.prod_classification)
)

SELECT
    (a.m + interval '1 month' - interval '1 day')::date AS month_end,
    'JLG'                                  AS loan_source,
    a.business_segment,
    coalesce(h.zone_name,    'Unassigned') AS zone_name,
    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    a.branch_id,
    coalesce(a.lo_id, 'N/A')               AS lo_id,
    coalesce(h.state_id::text,    'N/A')   AS state_id,
    coalesce(h.district_id::text, 'N/A')   AS district_id,
    coalesce(a.disb_year,          'N/A')  AS disb_year,
    coalesce(a.cycle_no,           'N/A')  AS cycle_no,
    coalesce(a.prod_classification,'Other') AS prod_classification,
    coalesce(a.loans_eom, 0)               AS loans_eom,
    round(coalesce(a.pos_eom, 0)::numeric, 2)            AS pos_eom,
    round(coalesce(a.par0_pos, 0)::numeric, 2)           AS par0_pos,
    round(coalesce(a.par30_pos, 0)::numeric, 2)          AS par30_pos,
    round(coalesce(a.par60_pos, 0)::numeric, 2)          AS par60_pos,
    round(coalesce(a.par90_pos, 0)::numeric, 2)          AS par90_pos,
    coalesce(a.wo_loans_eom, 0)                          AS wo_loans_eom,
    round(coalesce(a.wo_pos_eom, 0)::numeric, 2)         AS wo_pos_eom,
    coalesce(a.disb_count, 0)                            AS disb_count,
    round(coalesce(a.disb_amount, 0)::numeric, 2)        AS disb_amount,
    round(coalesce(a.demand, 0)::numeric, 2)             AS demand,
    round(coalesce(a.collection, 0)::numeric, 2)         AS collection,
    round(coalesce(a.collection_capped, 0)::numeric, 2)  AS collection_capped,
    coalesce(a.slip_count, 0)                            AS slip_count,
    round(coalesce(a.slip_pos, 0)::numeric, 2)           AS slip_pos,
    round(coalesce(a.prev_regular_pos, 0)::numeric, 2)   AS prev_regular_pos,
    round(coalesce(a.reg_demand, 0)::numeric, 2)         AS reg_demand,
    round(coalesce(a.reg_collection, 0)::numeric, 2)     AS reg_collection,
    round(coalesce(a.par60_collection, 0)::numeric, 2)   AS par60_collection,
    round(coalesce(a.wo_recovery, 0)::numeric, 2)        AS wo_recovery,
    round(coalesce(a.demand_wo, 0)::numeric, 2)              AS demand_wo,
    round(coalesce(a.collection_capped_wo, 0)::numeric, 2)   AS collection_capped_wo,
    coalesce(a.slip_count_wo, 0)                             AS slip_count_wo,
    round(coalesce(a.slip_pos_wo, 0)::numeric, 2)            AS slip_pos_wo,
    round(coalesce(a.prev_regular_pos_wo, 0)::numeric, 2)    AS prev_regular_pos_wo,
    round(coalesce(a.reg_demand_wo, 0)::numeric, 2)          AS reg_demand_wo,
    round(coalesce(a.reg_collection_wo, 0)::numeric, 2)      AS reg_collection_wo
FROM joined a
LEFT JOIN hierarchy h ON h.branch_id = a.branch_id
ORDER BY month_end, business_segment, branch_id;
