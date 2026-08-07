-- =============================================================================
-- Report  : Current Status (AUM)
-- DPD     : Computed EOM DPD (end of previous month)
--           cumulative_principal_due / cumulative_interest_due from stored cols.
--           pre_dpd = DPD as of prev_prev_month_end (for OD movement direction).
-- Dedup   : Cross-listed loan_id → IL is primary if IL disburse > JLG disburse
-- LAP     : product_id LIKE '%SUGAM%' OR '%UDYOGINI%' OR '%SECURED%'
-- prod_class: uses product_classification.product_class_id
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
ref AS (
    -- The month-end reference is ALWAYS the LAST COMPLETED month-end (NBFC standard).
    -- On 1-Aug that is 31-Jul: July closed with full data (the warehouse holds T-1),
    -- so 31-Jul is the month end to report against.
    --
    -- This deliberately does NOT use the T-1 form (date_trunc('month', current_date - 1)
    -- ...), which on the 1st resolves one month further back — 1-Aug would anchor on
    -- 30-Jun and report June's portfolio while trend_full and pos_par both report
    -- 31-Jul, breaking the cross-report match on one day in thirty. Identical on every
    -- other day of the month.
    --
    -- Divergence from the reference Bucket_Movement .pbit (EOMONTH(TODAY()-1,-1)) is
    -- therefore limited to the 1st: on that day the .pbit still shows the PREVIOUS
    -- month's movement (Jun-30 -> Jul) whereas this shows the just-closed month-end
    -- (31-Jul) with the new month's movement not yet started. Days 2-31 are identical.
    SELECT
        (date_trunc('month', current_date) - interval '1 day')::date                       AS prev_month_end,
        date_trunc('month', current_date)::date                                            AS curr_month_start,
        (date_trunc('month', current_date - interval '1 month') - interval '1 day')::date  AS prev_prev_month_end,
        date_trunc('month', current_date - interval '1 month')::date                       AS prev_month_start
),

-- ─────────────────────────────────────────────────────────────────────────────
-- BRANCH HIERARCHY — Zone → Cluster → Region → Unit → Branch
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

-- NOTE: lo_name ("<lo_id> - <NAME>") is NOT resolved here. Joining
-- public.home_employee_master into this query — at any position, even with the
-- uniqueness of employee_id made explicit — makes the planner estimate a 23x
-- fan-out on top of its already-wild 70M grouped-row estimate (actual ~40k),
-- pushing the total cost 150M -> 5,192M (34.6x). runner.py maps lo_id -> name
-- in pandas after the fact instead; see LO_NAME_REPORTS there.

-- ═════════════════════════════════════════════════════════════════════════════
-- CURRENT DPD — EOM as of prev_month_end
-- ═════════════════════════════════════════════════════════════════════════════

-- IL — collections before current month start
il_rd AS (
    SELECT loan_id, principal_collected, interest_collected
    FROM public.repayment_detail_il
    WHERE collection_date_time < (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
),

-- IL — OD per demand_date
il_ars AS (
    SELECT
        rs.loan_id,
        rs.demand_date,
        CASE
            WHEN sum(rd.principal_collected) IS NULL
                THEN rs.cumulative_principal_due
            WHEN sum(rd.principal_collected) < rs.cumulative_principal_due
                THEN rs.cumulative_principal_due - sum(rd.principal_collected)
            ELSE 0
        END AS od_principal,
        CASE
            WHEN sum(rd.interest_collected) IS NULL
                THEN rs.cumulative_interest_due
            WHEN sum(rd.interest_collected) < rs.cumulative_interest_due
                THEN rs.cumulative_interest_due - sum(rd.interest_collected)
            ELSE 0
        END AS od_interest
    FROM public.loan_account_il la
    JOIN public.repayment_schedule_il rs ON rs.loan_id = la.loan_id
    LEFT JOIN il_rd rd ON rd.loan_id = rs.loan_id
    WHERE (
        (la.status = 'W' AND la.closure_date::date > DATE '2025-03-30')
        OR (la.closure_type = 'W'
            AND la.last_collection_date::date > (SELECT prev_month_end FROM ref))
        OR la.status IN ('D', 'I')
        OR (
            (la.closure_date IS NULL
             OR la.closure_date::date > (SELECT prev_month_end FROM ref))
            AND rs.demand_date::date <= (SELECT prev_month_end FROM ref)
        )
    )
    GROUP BY rs.loan_id, rs.demand_date, rs.cumulative_principal_due, rs.cumulative_interest_due
),

-- IL — DPD per loan (EOM)
il_dpd AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL                                         THEN 0
            WHEN min(demand_date)::date > (SELECT prev_month_end FROM ref)        THEN 0
            ELSE ((SELECT prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS dpd
    FROM il_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- JLG — collections before current month start (use collection_date for JLG)
jlg_rd AS (
    SELECT loan_id, principal_collected, interest_collected
    FROM public.repayment_detail
    WHERE collection_date::date < (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
),

-- JLG — OD per demand_date (repayment_schedule has stored cumulative columns)
jlg_ars AS (
    SELECT
        rs.loan_id,
        rs.demand_date,
        CASE
            WHEN sum(rd.principal_collected) IS NULL
                THEN rs.cumulative_principal_due
            WHEN sum(rd.principal_collected) < rs.cumulative_principal_due
                THEN rs.cumulative_principal_due - sum(rd.principal_collected)
            ELSE 0
        END AS od_principal,
        CASE
            WHEN sum(rd.interest_collected) IS NULL
                THEN rs.cumulative_interest_due
            WHEN sum(rd.interest_collected) < rs.cumulative_interest_due
                THEN rs.cumulative_interest_due - sum(rd.interest_collected)
            ELSE 0
        END AS od_interest
    FROM public.home_loan_account la
    JOIN public.repayment_schedule rs ON rs.loan_id = la.loan_id
    LEFT JOIN jlg_rd rd ON rd.loan_id = rs.loan_id
    WHERE (
        (la.status = 'W' AND la.closure_date::date > DATE '2025-03-30')
        OR (la.closure_type = 'W'
            AND la.last_collection_date::date > (SELECT prev_month_end FROM ref))
        OR la.status IN ('D', 'I')
        OR (
            (la.closure_date IS NULL
             OR la.closure_date::date > (SELECT prev_month_end FROM ref))
            AND rs.demand_date::date <= (SELECT prev_month_end FROM ref)
        )
    )
    GROUP BY rs.loan_id, rs.demand_date, rs.cumulative_principal_due, rs.cumulative_interest_due
),

-- JLG — DPD per loan (EOM)
jlg_dpd AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL                                         THEN 0
            WHEN min(demand_date)::date > (SELECT prev_month_end FROM ref)        THEN 0
            ELSE ((SELECT prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS dpd
    FROM jlg_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- ═════════════════════════════════════════════════════════════════════════════
-- PRE-PERIOD DPD — as of prev_prev_month_end (for bucket movement direction)
-- ═════════════════════════════════════════════════════════════════════════════

-- IL pre-period collections (before 2 months ago start)
il_pre_rd AS (
    SELECT loan_id,
           sum(principal_collected) AS cum_collected,
           sum(interest_collected)  AS cum_interest_collected
    FROM public.repayment_detail_il
    WHERE collection_date_time < (SELECT prev_month_start FROM ref)
      AND status IN ('A', 'V')
    GROUP BY loan_id
),

-- IL — OD per demand_date as of prev_prev_month_end
il_pre_ars AS (
    SELECT
        rs.loan_id,
        rs.demand_date,
        CASE
            WHEN rd.cum_collected IS NULL
                THEN rs.cumulative_principal_due
            WHEN rd.cum_collected < rs.cumulative_principal_due
                THEN rs.cumulative_principal_due - rd.cum_collected
            ELSE 0
        END AS od_principal,
        CASE
            WHEN rd.cum_interest_collected IS NULL
                THEN rs.cumulative_interest_due
            WHEN rd.cum_interest_collected < rs.cumulative_interest_due
                THEN rs.cumulative_interest_due - rd.cum_interest_collected
            ELSE 0
        END AS od_interest
    FROM public.repayment_schedule_il rs
    LEFT JOIN il_pre_rd rd ON rd.loan_id = rs.loan_id
    WHERE rs.demand_date::date <= (SELECT prev_prev_month_end FROM ref)
),

-- IL — pre_dpd per loan
il_pre AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL                                              THEN 0
            WHEN min(demand_date)::date > (SELECT prev_prev_month_end FROM ref)        THEN 0
            ELSE ((SELECT prev_prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS pre_dpd
    FROM il_pre_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- JLG pre-period collections (before 2 months ago start)
jlg_pre_rd AS (
    SELECT loan_id,
           sum(principal_collected) AS cum_collected,
           sum(interest_collected)  AS cum_interest_collected
    FROM public.repayment_detail
    WHERE collection_date::date < (SELECT prev_month_start FROM ref)
      AND status IN ('A', 'V')
    GROUP BY loan_id
),

-- JLG — OD per demand_date as of prev_prev_month_end
jlg_pre_ars AS (
    SELECT
        rs.loan_id,
        rs.demand_date,
        CASE
            WHEN rd.cum_collected IS NULL
                THEN rs.cumulative_principal_due
            WHEN rd.cum_collected < rs.cumulative_principal_due
                THEN rs.cumulative_principal_due - rd.cum_collected
            ELSE 0
        END AS od_principal,
        CASE
            WHEN rd.cum_interest_collected IS NULL
                THEN rs.cumulative_interest_due
            WHEN rd.cum_interest_collected < rs.cumulative_interest_due
                THEN rs.cumulative_interest_due - rd.cum_interest_collected
            ELSE 0
        END AS od_interest
    FROM public.repayment_schedule rs
    LEFT JOIN jlg_pre_rd rd ON rd.loan_id = rs.loan_id
    WHERE rs.demand_date::date <= (SELECT prev_prev_month_end FROM ref)
),

-- JLG — pre_dpd per loan
jlg_pre AS (
    SELECT
        loan_id,
        CASE
            WHEN min(demand_date) IS NULL                                              THEN 0
            WHEN min(demand_date)::date > (SELECT prev_prev_month_end FROM ref)        THEN 0
            ELSE ((SELECT prev_prev_month_end FROM ref) - min(demand_date)::date) + 1
        END AS pre_dpd
    FROM jlg_pre_ars
    WHERE od_principal > 0 OR od_interest > 0
    GROUP BY loan_id
),

-- ─────────────────────────────────────────────────────────────────────────────
-- PRODUCT CLASSIFICATION LOOKUP (for AP filter / group-by)
-- ─────────────────────────────────────────────────────────────────────────────
il_prod_class AS (
    SELECT lp.product_id,
           coalesce(pc.product_classification, 'Other') AS prod_classification
    FROM public.loan_product_il lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),

jlg_prod_class AS (
    SELECT lp.product_id,
           coalesce(pc.product_classification, 'Other') AS prod_classification
    FROM public.loan_product lp
    LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
),

-- ─────────────────────────────────────────────────────────────────────────────
-- DEMOGRAPHIC & FACILITY MAPPING — purpose_id, facility_id, lender_id, caste, religion
-- One row per loan (DISTINCT ON guards against multi-row joins)
-- ─────────────────────────────────────────────────────────────────────────────
il_extra AS (
    SELECT DISTINCT ON (la.loan_id)
        la.loan_id,
        coalesce(la.purpose_id::text,  'N/A') AS purpose_id,
        coalesce(la.facility_id::text, 'N/A') AS facility_id,
        coalesce(la.lender_id::text,   'N/A') AS lender_id,
        coalesce(cci.caste,            'N/A') AS caste,
        coalesce(cci.religion,         'N/A') AS religion
    FROM public.loan_account_il la
    LEFT JOIN public.customer_contacts_il cci ON cci.loan_id = la.loan_id
    WHERE la.status IN ('A','D','I','W')
    ORDER BY la.loan_id
),

jlg_extra AS (
    SELECT DISTINCT ON (hla.loan_id)
        hla.loan_id,
        coalesce(hla.purpose_id::text,  'N/A') AS purpose_id,
        coalesce(hla.facility_id::text, 'N/A') AS facility_id,
        'N/A'::text                             AS lender_id,
        coalesce(hbm.caste,             'N/A') AS caste,
        coalesce(hbm.religion,          'N/A') AS religion
    FROM public.home_loan_account hla
    LEFT JOIN public.home_brrwr_misc hbm ON hbm.cust_id = hla.cust_id
    WHERE hla.status IN ('A','D','I','W')
    ORDER BY hla.loan_id
),

-- ═════════════════════════════════════════════════════════════════════════════
-- LOAN LISTS — status IN ('A','D','I','W') only 
-- dpd     = live la.dpd column (for dpd_bucket, PAR amounts)
-- eom_dpd = computed EOM DPD (for od_movement_status / bucket_movement only)
-- pre_dpd = computed M-2 EOM DPD (movement direction)
-- raw_status = 'W' if loan_id in writeoff_master OR db status = 'W' (no extra loans added)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── POS AT PREV MONTH-END (for the movement reports) ────────────────────────
-- Bucket Movement / OD Status are denominated in the PREVIOUS month-end POS
-- (the Excel sheet header is literally "POS [Previous Month]"), NOT the live POS.
-- Same formula as the trend engine: sanction - principal collected through the
-- prev month-end, floored at 0. Reuses the same A/V cash basis as the EOM DPD.
il_pos_eom AS (
    SELECT loan_id, sum(coalesce(principal_collected, 0)) AS prin_coll
    FROM public.repayment_detail_il
    WHERE collection_date_time::date < (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
    GROUP BY loan_id
),
jlg_pos_eom AS (
    SELECT loan_id, sum(coalesce(principal_collected, 0)) AS prin_coll
    FROM public.repayment_detail
    WHERE collection_date::date < (SELECT curr_month_start FROM ref)
      AND status IN ('A', 'V')
    GROUP BY loan_id
),

-- Disbursed-so-far at the prev month-end, for STAGED (tranched) IL loans.
-- prev_pos was based on total_loan_amount = the SANCTION, so undisbursed sanction
-- was reported as outstanding. On 2026-07-31 four IL loans were part-disbursed and
-- that overstated month-end POS by Rs 2,57,829 (Rs 0.0258 Cr) — exactly the gap
-- between OD Status and the trend engine, which has always used disbursed-so-far.
-- Live POS is unaffected: it reads la.principal_outstanding, the core system's own
-- balance, which already nets off the undisbursed portion.
-- Same source and as-of rule as trend_full_il.sql's disb_asof, so the two engines
-- agree by construction. The inner subquery narrows the audit scan to staged loans
-- only (principal_total <> total_loan_amount at some point); single-tranche loans
-- never enter, so this is a no-op for the rest of the book.
-- JLG has no staging (home_loan_account disburses in one shot) and measured a zero
-- gap, so jlg prev_pos is deliberately left on total_loan_amount.
il_disb_eom AS MATERIALIZED (
    SELECT DISTINCT ON (a.loan_id)
           a.loan_id, a.principal_total AS disbursed
    FROM public.loan_account_il_audit a
    WHERE a.principal_total IS NOT NULL
      AND coalesce(a.modified_on, a.created_on) IS NOT NULL
      AND coalesce(a.modified_on, a.created_on)::date < (SELECT curr_month_start FROM ref)
      AND a.loan_id IN (
          SELECT loan_id FROM public.loan_account_il_audit
          WHERE principal_total IS NOT NULL AND total_loan_amount IS NOT NULL
          GROUP BY loan_id HAVING bool_or(principal_total <> total_loan_amount))
    ORDER BY a.loan_id, coalesce(a.modified_on, a.created_on) DESC
),

il_loans AS (
    SELECT
        'IL'                                                    AS loan_source,
        CASE
            WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
              OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
            THEN 'LAP'
            ELSE 'IEL'
        END                                                     AS business_segment,
        la.loan_id,
        la.branch_id,
        la.loan_officer                                         AS lo_id,
        la.product_id::text                                     AS product_id,
        la.principal_outstanding                                AS pos,
        greatest(coalesce(de.disbursed, la.total_loan_amount, 0)
                 - coalesce(pe.prin_coll,0), 0)                 AS prev_pos,
        la.total_loan_amount                                    AS sanctioned_amount,
        la.disbursement_date,
        la.first_demand_date,
        la.last_demand_date,
        la.last_collection_date,
        coalesce(la.dpd, 0)                                     AS dpd,
        -- Death cases (status D / I) follow the CORE, which zeroes DPD on death.
        -- la.dpd (live) is already 0 for them; the RECONSTRUCTED month-end DPDs
        -- must match, else the previous-month bucket disagrees with the live one.
        CASE WHEN la.status IN ('D','I') AND coalesce(la.dpd,0) = 0 THEN 0
             ELSE coalesce(d.dpd, 0) END                        AS eom_dpd,
        CASE WHEN la.status IN ('D','I') AND coalesce(la.dpd,0) = 0 THEN 0
             ELSE coalesce(p.pre_dpd, 0) END                    AS pre_dpd,
        coalesce(la.principal_arrear, 0) + coalesce(la.interest_arrear, 0) AS total_arrear,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END                        AS raw_status,
        coalesce(la.cycle::text, 'N/A')                         AS cycle_no,
        extract(year FROM la.disbursement_date)::text           AS disb_year,
        coalesce(ipc.prod_classification, 'Other')              AS prod_classification,
        coalesce(ex.purpose_id,          'N/A')               AS purpose_id,
        coalesce(ex.facility_id,         'N/A')               AS facility_id,
        coalesce(ex.lender_id,           'N/A')               AS lender_id,
        coalesce(ex.caste,               'N/A')               AS caste,
        coalesce(ex.religion,            'N/A')               AS religion,
        -- TRUE = in the LIVE active book (open as of today). FALSE = on-book at
        -- prev month-end but closed during the current month (movement-only).
        (la.status IN ('A','D','I','W')
         AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1
              OR la.status = 'W'))                             AS open_now
    FROM public.loan_account_il la
    LEFT JOIN il_dpd        d   ON d.loan_id      = la.loan_id
    LEFT JOIN il_pre        p   ON p.loan_id      = la.loan_id
    LEFT JOIN il_prod_class ipc ON ipc.product_id = la.product_id::text
    LEFT JOIN il_extra      ex  ON ex.loan_id     = la.loan_id
    LEFT JOIN il_pos_eom    pe  ON pe.loan_id     = la.loan_id
    LEFT JOIN il_disb_eom   de  ON de.loan_id     = la.loan_id
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    WHERE la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND la.status <> 'R'
      AND (
           -- LIVE active book (open as of today). Unchanged universe for the
           -- live-book reports (Current Outstanding / Ageing / DQ). W loans kept.
           (la.status IN ('A','D','I','W')
            AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1
                 OR la.status = 'W'))
        OR
           -- On-book at PREV month-end but CLOSED during the current month. Added
           -- ONLY so the movement reports (OD Status / Bucket Movement) reconcile
           -- to the month-end portfolio; tagged loan_status='Closed' (open_now=false)
           -- and dropped by every live-book report. These carry POS=0, live DPD=0.
           (la.disbursement_date::date <= (SELECT prev_month_end FROM ref)
            AND la.closure_date::date  >  (SELECT prev_month_end FROM ref)
            AND la.closure_date::date  <= current_date - 1)
      )
),

jlg_loans AS (
    SELECT
        'JLG'                                                   AS loan_source,
        'JLG'                                                   AS business_segment,
        la.loan_id,
        cm.branch_id,
        cm.assigned_to::varchar                                 AS lo_id,
        la.product_id::text                                     AS product_id,
        la.prin_os                                              AS pos,
        greatest(coalesce(la.total_loan_amount,0)
                 - coalesce(pe.prin_coll,0), 0)                 AS prev_pos,
        la.total_loan_amount                                    AS sanctioned_amount,
        la.disbursement_date,
        la.first_demand_date,
        la.last_demand_date,
        la.last_collection_date,
        coalesce(la.dpd, 0)                                     AS dpd,
        -- Death cases (status D / I) follow the CORE, which zeroes DPD on death.
        -- la.dpd (live) is already 0 for them; the RECONSTRUCTED month-end DPDs
        -- must match, else the previous-month bucket disagrees with the live one.
        CASE WHEN la.status IN ('D','I') AND coalesce(la.dpd,0) = 0 THEN 0
             ELSE coalesce(d.dpd, 0) END                        AS eom_dpd,
        CASE WHEN la.status IN ('D','I') AND coalesce(la.dpd,0) = 0 THEN 0
             ELSE coalesce(p.pre_dpd, 0) END                    AS pre_dpd,
        coalesce(la.principal_arrear, 0) + coalesce(la.interest_arrear, 0) AS total_arrear,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END                        AS raw_status,
        coalesce(la.cycle::text, 'N/A')                         AS cycle_no,
        extract(year FROM la.disbursement_date)::text           AS disb_year,
        coalesce(jpc.prod_classification, 'Other')              AS prod_classification,
        coalesce(ex.purpose_id,           'N/A')              AS purpose_id,
        coalesce(ex.facility_id,          'N/A')              AS facility_id,
        coalesce(ex.lender_id,            'N/A')              AS lender_id,
        coalesce(ex.caste,                'N/A')              AS caste,
        coalesce(ex.religion,             'N/A')              AS religion,
        -- TRUE = in the LIVE active book (open today); FALSE = movement-only
        -- (on-book at prev month-end, closed during the current month).
        (la.status IN ('A','D','I','W')
         AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1
              OR la.status = 'W'))                             AS open_now
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN jlg_dpd        d   ON d.loan_id      = la.loan_id
    LEFT JOIN jlg_pre        p   ON p.loan_id      = la.loan_id
    LEFT JOIN jlg_prod_class jpc ON jpc.product_id = la.product_id::text
    LEFT JOIN jlg_extra      ex  ON ex.loan_id     = la.loan_id
    LEFT JOIN jlg_pos_eom    pe  ON pe.loan_id     = la.loan_id
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    WHERE la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND la.status <> 'R'
      AND (la.status != 'W' OR la.prin_os > 0)
      AND (
           -- LIVE active book (open today) — unchanged universe for the live-book
           -- reports (Current Outstanding / Ageing / DQ). W loans kept.
           (la.status IN ('A','D','I','W')
            AND (la.closure_date IS NULL OR la.closure_date::date > current_date - 1
                 OR la.status = 'W'))
        OR
           -- On-book at PREV month-end, CLOSED during the current month → kept ONLY
           -- for the movement reports (loan_status='Closed', open_now=false).
           -- POS=0, live DPD=0; dropped by every live-book report.
           (la.disbursement_date::date <= (SELECT prev_month_end FROM ref)
            AND la.closure_date::date  >  (SELECT prev_month_end FROM ref)
            AND la.closure_date::date  <= current_date - 1)
      )
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id           = la.loan_id
            AND il.status            IN ('A', 'D', 'I', 'W')
            AND il.disbursement_date > la.disbursement_date
      )
),

all_loans AS (
    SELECT * FROM il_loans
    UNION ALL
    SELECT * FROM jlg_loans
),

-- ─────────────────────────────────────────────────────────────────────────────
-- BUCKET ASSIGNMENT + OD STATUS
-- ─────────────────────────────────────────────────────────────────────────────
bucketed AS (
    SELECT al.*,
        CASE
            WHEN al.raw_status = 'W'                THEN 'Write-off'
            WHEN al.dpd = 0                         THEN 'Regular'
            WHEN al.dpd <= 90                       THEN 'Overdue'
            ELSE                                         'NPA'
        END AS curr_od_status,
        CASE
            WHEN al.raw_status = 'W'                THEN 'Write-Off'
            WHEN al.dpd = 0                         THEN 'Regular'
            WHEN al.dpd BETWEEN   1 AND  30         THEN '1 - 30'
            WHEN al.dpd BETWEEN  31 AND  60         THEN '31 - 60'
            WHEN al.dpd BETWEEN  61 AND  90         THEN '61 - 90'
            WHEN al.dpd BETWEEN  91 AND 180         THEN '91 - 180'
            WHEN al.dpd BETWEEN 181 AND 360         THEN '181 - 360'
            ELSE                                         '360 +'
        END AS dpd_bucket,
        -- Previous-month bucket (pure EOM DPD, no W override) — for Bucket Movement
        CASE
            WHEN al.eom_dpd = 0                     THEN 'Regular'
            WHEN al.eom_dpd BETWEEN   1 AND  30     THEN '1 - 30'
            WHEN al.eom_dpd BETWEEN  31 AND  60     THEN '31 - 60'
            WHEN al.eom_dpd BETWEEN  61 AND  90     THEN '61 - 90'
            WHEN al.eom_dpd BETWEEN  91 AND 180     THEN '91 - 180'
            WHEN al.eom_dpd BETWEEN 181 AND 360     THEN '181 - 360'
            ELSE                                         '360 +'
        END AS prev_dpd_bucket,
        -- Current bucket by LIVE DPD, pure (no W override) — Bucket Movement puts
        -- write-off loans in their real DPD bucket (e.g. 181-360, 360+)
        CASE
            WHEN al.dpd = 0                         THEN 'Regular'
            WHEN al.dpd BETWEEN   1 AND  30         THEN '1 - 30'
            WHEN al.dpd BETWEEN  31 AND  60         THEN '31 - 60'
            WHEN al.dpd BETWEEN  61 AND  90         THEN '61 - 90'
            WHEN al.dpd BETWEEN  91 AND 180         THEN '91 - 180'
            WHEN al.dpd BETWEEN 181 AND 360         THEN '181 - 360'
            ELSE                                         '360 +'
        END AS curr_dpd_bucket,
        -- Movement is measured MONTH-END -> LIVE, the same period as
        -- prev_dpd_bucket -> curr_dpd_bucket above and as rpt_od_slippage.
        -- These two columns previously compared eom_dpd vs pre_dpd, i.e. the
        -- PREVIOUS month's movement (Jun-end -> Jul-end) while the matrix showed
        -- Jul-end -> today. The OD Status KPI reads od_movement_status and its
        -- own matrix reads the buckets, so the same page disagreed with itself:
        -- 317 vs 3,082 slippage on 2026-08-07. Same rule, shifted one period.
        CASE
            WHEN al.raw_status = 'W'                          THEN 'Write-Off'
            WHEN al.eom_dpd = 0 AND coalesce(al.dpd,0) = 0    THEN 'Not OD'
            WHEN al.eom_dpd = 0 AND coalesce(al.dpd,0) > 0    THEN 'OD Slippage'
            WHEN al.eom_dpd > 0 AND coalesce(al.dpd,0) = 0    THEN 'Regularised'
            ELSE                                                   'Continuing'
        END AS od_movement_status,
        CASE
            WHEN al.raw_status = 'W'                          THEN 'N/A'
            WHEN coalesce(al.dpd,0) = al.eom_dpd              THEN 'Static'
            WHEN coalesce(al.dpd,0) < al.eom_dpd              THEN 'Improved'
            ELSE                                                   'Worsened'
        END AS bucket_movement,
        CASE WHEN al.dpd >= 1                       THEN al.pos ELSE 0 END AS par0_pos,
        CASE WHEN al.dpd > 30                       THEN al.pos ELSE 0 END AS par30_pos,
        CASE WHEN al.dpd > 60                       THEN al.pos ELSE 0 END AS par60_pos,
        CASE WHEN al.dpd > 90                       THEN al.pos ELSE 0 END AS par90_pos,
        CASE WHEN al.raw_status = 'W'               THEN al.pos ELSE 0 END AS writeoff_pos
    FROM all_loans al
)

-- ─────────────────────────────────────────────────────────────────────────────
-- FINAL AGGREGATION
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    current_date                                    AS as_of_date,
    b.loan_source,
    b.business_segment,
    b.curr_od_status,
    -- Write-off wins over Closed: a written-off loan that closed this month is
    -- still a write-off (deep-NPA settlement), NOT a healthy 'Regularised' move.
    -- The LIVE book is protected by the open_now flag below (live-book reports
    -- filter open_now IS TRUE), so this no longer inflates live Write-off counts.
    CASE
        WHEN b.raw_status = 'W'        THEN 'Write-off'
        WHEN NOT b.open_now            THEN 'Closed'   -- movement-only closure
        WHEN b.raw_status = 'A'        THEN 'Active'
        WHEN b.raw_status IN ('D','I') THEN 'Death'
        ELSE b.raw_status
    END                                             AS loan_status,
    -- TRUE = in the LIVE active book (open as of the data date). Live-book reports
    -- (Current Outstanding / Ageing / exec summary) filter on this; the movement
    -- reports ignore it so current-month closures stay in the month-end portfolio.
    b.open_now                                      AS open_now,
    b.dpd_bucket,
    b.prev_dpd_bucket,
    b.curr_dpd_bucket,
    b.od_movement_status,
    b.bucket_movement,
    coalesce(h.zone_name,    'Unassigned')          AS zone_name,
    coalesce(h.cluster_name, 'Unassigned')          AS cluster_name,
    coalesce(h.region_name,  'Unassigned')          AS region_name,
    coalesce(h.area_name,    'Unassigned')          AS area_name,
    coalesce(h.branch_name,  'Unassigned')          AS branch_name,
    b.branch_id,
    coalesce(b.lo_id,              'N/A')            AS lo_id,
    -- ── Display labels: "<id> - <NAME>" ──────────────────────────────────────
    -- Matches the reference convention (S.Incentive notebook builds branch/area/
    -- region/cluster/zone the same way; the Excel slicer is "BRANCH ID & NAME").
    -- These are DISPLAY-ONLY, kept separate from the plain *_name columns above,
    -- which carry the access-control scope values (core/scope.py) and the shared
    -- slicer values used by every other report — those must not change format.
    coalesce(h.zone_id::text   || ' - ' || h.zone_name,    'Unassigned') AS zone_label,
    coalesce(h.cluster_id::text|| ' - ' || h.cluster_name, 'Unassigned') AS cluster_label,
    coalesce(h.region_id::text || ' - ' || h.region_name,  'Unassigned') AS region_label,
    coalesce(h.area_id::text   || ' - ' || h.area_name,    'Unassigned') AS area_label,
    coalesce(b.branch_id::text || ' - ' || h.branch_name,  'Unassigned') AS branch_label,
    coalesce(b.prod_classification,'Other')         AS prod_classification,
    coalesce(h.state_id::text,   'N/A')             AS state_id,
    coalesce(h.district_id::text,'N/A')             AS district_id,
    coalesce(b.cycle_no,         'N/A')             AS cycle_no,
    coalesce(b.disb_year,        'N/A')             AS disb_year,
    coalesce(b.purpose_id,       'N/A')             AS purpose_id,
    coalesce(b.facility_id,      'N/A')             AS facility_id,
    coalesce(b.lender_id,        'N/A')             AS lender_id,
    coalesce(b.caste,            'N/A')             AS caste,
    coalesce(b.religion,         'N/A')             AS religion,
    (SELECT prev_month_end FROM ref)                AS dpd_as_of,
    -- Was the loan in the PREV month-end portfolio (disbursed on/before 30-Jun)?
    -- The movement reports (OD Status / Bucket Movement) keep only these rows, so
    -- current-month disbursals — which have no month-end demand and can't be OD —
    -- are excluded, while current-month closures (also disbursed <= 30-Jun) stay.
    -- ::date is REQUIRED: disbursement_date is a TIMESTAMP and prev_month_end a DATE,
    -- so an uncast compare silently drops loans disbursed ON the month-end at any
    -- time past midnight (IL carries a real time-of-day; JLG is always 00:00:00).
    (b.disbursement_date::date <= (SELECT prev_month_end FROM ref)) AS onbook_prev_eom,

    count(b.loan_id)                                AS loan_count,
    round(sum(b.pos)::numeric,              2)      AS total_pos,
    -- POS at the PREVIOUS month-end — the denominator Bucket Movement / OD Status
    -- are stated in ("POS [Previous Month]" in the Excel sheet). Ties the trend
    -- engine's pos_eom for the same month-end.
    round(sum(b.prev_pos)::numeric,         2)      AS prev_pos,
    round(sum(b.sanctioned_amount)::numeric, 2)     AS total_sanctioned,
    round(sum(b.total_arrear)::numeric,     2)      AS total_arrear,
    round(sum(b.par0_pos)::numeric,  2)             AS par0_pos,
    round(sum(b.par30_pos)::numeric, 2)             AS par30_pos,
    round(sum(b.par60_pos)::numeric, 2)             AS par60_pos,
    round(sum(b.par90_pos)::numeric, 2)             AS par90_pos,
    round(sum(b.writeoff_pos)::numeric, 2)          AS writeoff_pos

FROM bucketed b
LEFT JOIN hierarchy h ON b.branch_id = h.branch_id
GROUP BY
    b.loan_source, b.business_segment, b.curr_od_status,
    b.raw_status, b.open_now, (b.disbursement_date::date <= (SELECT prev_month_end FROM ref)),
    b.dpd_bucket, b.prev_dpd_bucket, b.curr_dpd_bucket, b.od_movement_status, b.bucket_movement,
    h.zone_name, h.cluster_name, h.region_name, h.area_name, h.branch_name,
    h.zone_id, h.cluster_id, h.region_id, h.area_id,
    b.branch_id, b.lo_id, b.prod_classification,
    h.state_id, h.district_id,
    b.cycle_no, b.disb_year,
    b.purpose_id, b.facility_id, b.lender_id, b.caste, b.religion
ORDER BY
    b.business_segment, b.dpd_bucket,
    h.zone_name, h.cluster_name, h.region_name, h.area_name, h.branch_name;
