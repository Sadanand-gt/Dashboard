-- =============================================================================
-- Report  : PORTFOLIO CUTS — AS ON AN ARBITRARY MONTH-END
-- Writes  : rpt_portfolio_cuts_hist  (report_day = the as-on date)
-- Params  : {as_on}       month-end date, e.g. 2026-07-31
--           {wo_triples}  write-off master, injected by the runner
--
-- This is the TIME-TRAVELLED twin of portfolio_cuts.sql. The live file is left
-- untouched and keeps serving "today"; every difference here exists because a
-- historical cut cannot read current-state columns.
--
-- WHY A SEPARATE FILE AND NOT A PARAMETER ON THE LIVE ONE
--   The live report reads la.dpd and la.principal_outstanding — the core
--   system's CURRENT balance and CURRENT delinquency. Neither can be rewound.
--   Rebuilding them from repayment history is a materially different query, and
--   folding both paths into one file would put the daily report one typo away
--   from breaking. The two are reconciled instead: run this with
--   {as_on} = current_date - 1 and it reproduces the live table (see
--   verify_asof() in gen_portfolio_cuts_asof.py).
--
-- THE FOUR THINGS THAT MOVE WITH THE DATE
--
--   1. UNIVERSE. The live file requires status IN ('A','D','I','W') — a
--      current-state test. A loan that closed in 2024 reads 'C' today, so that
--      guard would erase it from every 2023 and 2024 month-end and the book
--      would look impossibly small in the past. Here the universe is defined by
--      DATES only: disbursed on or before {as_on}, and not closed until after
--      it. Status is used solely to drop junk ('R') and to label the row.
--
--   2. POS. Recomputed as disbursed-so-far minus principal collected through
--      {as_on}. IL staged (tranched) loans take disbursed-so-far from
--      loan_account_il_audit, NOT total_loan_amount — the sanction would report
--      undisbursed money as outstanding; on 2026-07-31 that was four loans and
--      Rs 2,57,829. JLG has no staging and is measured at a zero gap, so it uses
--      total_loan_amount. Identical basis to aum_loans.sql's prev_pos and to the
--      trend engine, so the three agree by construction.
--
--   3. DPD. Recomputed as the age of the OLDEST instalment whose cumulative
--      demand was still not covered by cash received by {as_on} — the same
--      cash-vs-due method as aum_status.sql's EOM DPD and od_slippage.sql. One
--      DPD method across the warehouse; see report-consistency-rules.
--
--   4. WRITE-OFF STATUS. A loan written off AFTER {as_on} was NOT written off
--      at {as_on}, so the write-off master is joined on wo_date <= {as_on}. The
--      "last 3 months" window is the three calendar months ending at {as_on},
--      not the three ending today.
--
-- Residual-tenure bands already key off the anchor, so they follow the date for
-- free. Ticket, ROI, original tenure, purpose, cycle, caste, religion and
-- geography are loan attributes and do not move.
-- =============================================================================

WITH

anchor AS (
    SELECT DATE '{as_on}'                                                    AS d,
           date_trunc('month', DATE '{as_on}')::date                         AS month_start,
           (date_trunc('month', DATE '{as_on}') - interval '2 months')::date AS wo_from
),

-- Write-off master, UNFILTERED. The "had it happened by {as_on}" test cannot be
-- applied here any more, because the effective write-off date is
--     coalesce(la.writeoff_date, w.wo_date)
-- and la.writeoff_date is only visible once the loan tables are joined.
--
-- WHY THE COALESCE. Neither source covers the whole history on its own:
--     core la.writeoff_date   2011-03-17 .. 2025-03-31   (14,340 JLG, 111 IL)
--     writeoff_master         2023-09-01 .. 2026-06-01   (30,661 loans)
-- Using the master alone left every month before Mar-2024 with a write-off book
-- of ZERO while rpt_trend_full showed thousands, because the core had written
-- them off years before the master begins. trend_full_jlg.sql already resolves
-- it this way; this now matches, so the two engines answer the same question.
wo_master AS (
    SELECT v.loan_id::bigint AS loan_id, v.wo_date::date AS wo_date,
           v.writeoff_amount::numeric AS wo_amount
    FROM (VALUES {wo_triples}) AS v(loan_id, wo_date, writeoff_amount)
),

hierarchy AS (
    SELECT bm.branch_id, bm.branch_name, bm.state_id, bm.district_id,
           a.area_name,
           reg.branch_name AS region_name,
           clus.area_name  AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON a.area_id     = bm.area_id
    LEFT JOIN public.brnch_master reg  ON reg.branch_id = a.region_id
    LEFT JOIN public.area_master  clus ON clus.area_id  = reg.area_id
    WHERE bm.active = 'Y' AND bm.is_region = 'N' AND bm.branch_name <> 'DEMO'
),

-- ═════════════════════════════════════════════════════════════════════════════
-- CASH RECEIVED THROUGH {as_on}  — the basis for both POS and DPD
-- ═════════════════════════════════════════════════════════════════════════════
il_cash AS (
    SELECT loan_id,
           sum(principal_collected) AS prin_coll,
           sum(principal_collected + interest_collected) AS paid
    FROM public.repayment_detail_il
    WHERE status IN ('A','V')
      AND collection_date_time::date <= (SELECT d FROM anchor)
    GROUP BY loan_id
),
jlg_cash AS (
    SELECT loan_id,
           sum(principal_collected) AS prin_coll,
           sum(principal_collected + interest_collected) AS paid
    FROM public.repayment_detail
    WHERE status IN ('A','V')
      AND collection_date::date <= (SELECT d FROM anchor)
    GROUP BY loan_id
),

-- Disbursed-so-far at {as_on} for STAGED IL loans only. The inner subquery
-- narrows the audit scan to loans that were ever part-disbursed; single-tranche
-- loans never enter, so this is a no-op for the rest of the book.
il_disb_asof AS MATERIALIZED (
    SELECT DISTINCT ON (a.loan_id)
           a.loan_id, a.principal_total AS disbursed
    FROM public.loan_account_il_audit a
    WHERE a.principal_total IS NOT NULL
      AND coalesce(a.modified_on, a.created_on) IS NOT NULL
      AND coalesce(a.modified_on, a.created_on)::date <= (SELECT d FROM anchor)
      AND a.loan_id IN (
          SELECT loan_id FROM public.loan_account_il_audit
          WHERE principal_total IS NOT NULL AND total_loan_amount IS NOT NULL
          GROUP BY loan_id HAVING bool_or(principal_total <> total_loan_amount))
    ORDER BY a.loan_id, coalesce(a.modified_on, a.created_on) DESC
),

-- ═════════════════════════════════════════════════════════════════════════════
-- DPD AT {as_on} — age of the oldest instalment not covered by cash by then.
-- Rs 0.50 tolerance absorbs the instalment principal/interest split rounding.
-- ═════════════════════════════════════════════════════════════════════════════
il_dpd AS (
    SELECT rs.loan_id,
           ((SELECT d FROM anchor) - min(rs.demand_date)::date) + 1 AS dpd
    FROM public.repayment_schedule_il rs
    LEFT JOIN il_cash c ON c.loan_id = rs.loan_id
    WHERE rs.demand_date::date <= (SELECT d FROM anchor)
      AND (rs.cumulative_principal_due + rs.cumulative_interest_due)
          > coalesce(c.paid, 0) + 0.5
    GROUP BY rs.loan_id
),
jlg_dpd AS (
    SELECT rs.loan_id,
           ((SELECT d FROM anchor) - min(rs.demand_date)::date) + 1 AS dpd
    FROM public.repayment_schedule rs
    LEFT JOIN jlg_cash c ON c.loan_id = rs.loan_id
    WHERE rs.demand_date::date <= (SELECT d FROM anchor)
      AND (rs.cumulative_principal_due + rs.cumulative_interest_due)
          > coalesce(c.paid, 0) + 0.5
    GROUP BY rs.loan_id
),

-- ═════════════════════════════════════════════════════════════════════════════
-- IL
-- ═════════════════════════════════════════════════════════════════════════════
il_loans AS (
    SELECT
        CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
               OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
               OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
             THEN 'LAP' ELSE 'IEL' END          AS business_segment,
        la.loan_id,
        la.branch_id,
        la.loan_officer::varchar                AS lo_id,
        greatest(coalesce(de.disbursed, la.total_loan_amount, 0)
                 - coalesce(ic.prin_coll, 0), 0)  AS pos,
        coalesce(d.dpd, 0)                      AS dpd,
        -- Written off ONLY if the write-off had happened by {as_on}. la.status
        -- 'W' is a current-state flag and is therefore not sufficient on its own.
        -- Written off ONLY if the write-off had happened by {as_on}, measured on
        -- the effective date: the core's own writeoff_date when it has one, else
        -- the master's. la.status = 'W' is a current-state flag and says nothing
        -- about that date, so it is deliberately not consulted.
        CASE WHEN coalesce(la.writeoff_date::date, w.wo_date)
                  <= (SELECT d FROM anchor)      THEN 'W'
             WHEN la.status IN ('D','I')         THEN la.status
             ELSE 'A' END                       AS status,
        la.tenure_in_months::numeric            AS orig_tenure_m,
        la.last_demand_date::date               AS maturity_date,
        la.interest_rate::numeric               AS roi,
        coalesce(la.total_loan_amount, 0)       AS ticket,
        nullif(trim(la.purpose_id::text), '')   AS purpose,
        la.cycle::numeric                       AS cycle_no,
        la.repayment_frequency::text            AS repay_freq,
        nullif(trim(b.caste::text), '')         AS caste,
        nullif(trim(b.religion::text), '')      AS religion
    FROM public.loan_account_il la
    LEFT JOIN wo_master     w  ON w.loan_id  = la.loan_id
    LEFT JOIN il_cash       ic ON ic.loan_id = la.loan_id
    LEFT JOIN il_disb_asof  de ON de.loan_id = la.loan_id
    LEFT JOIN il_dpd        d  ON d.loan_id  = la.loan_id
    LEFT JOIN public.brrwroth_il b ON b.cust_id = la.cust_id
    WHERE la.status <> 'R'
      AND la.loan_id >= 10000000
      -- On the book AT {as_on}: disbursed by then, not closed until after.
      AND la.disbursement_date::date <= (SELECT d FROM anchor)
      AND (la.closure_date IS NULL
           OR la.closure_date::date > (SELECT d FROM anchor)
           -- A write-off IS a closure in the core system, so the guard above
           -- would erase the written-off book from every historical cut: at
           -- 2026-03-31 it dropped 1,540 loans and left the With/Excl W-O toggle
           -- with nothing to move. The live file exempts them the same way, via
           -- `OR la.status = 'W'`; here the exemption has to be date-bound,
           -- because wo_master is already filtered to wo_date <= {as_on}.
           OR coalesce(la.writeoff_date::date, w.wo_date) <= (SELECT d FROM anchor))
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id = la.loan_id
            AND il.disbursement_date > la.disbursement_date
            AND il.disbursement_date::date <= (SELECT d FROM anchor))
),

-- ═════════════════════════════════════════════════════════════════════════════
-- JLG
-- ═════════════════════════════════════════════════════════════════════════════
jlg_loans AS (
    SELECT
        'JLG'                                   AS business_segment,
        la.loan_id,
        cm.branch_id,
        cm.assigned_to::varchar                 AS lo_id,
        greatest(coalesce(la.total_loan_amount, 0)
                 - coalesce(jc.prin_coll, 0), 0)  AS pos,
        coalesce(d.dpd, 0)                      AS dpd,
        -- Written off ONLY if the write-off had happened by {as_on}, measured on
        -- the effective date: the core's own writeoff_date when it has one, else
        -- the master's. la.status = 'W' is a current-state flag and says nothing
        -- about that date, so it is deliberately not consulted.
        CASE WHEN coalesce(la.writeoff_date::date, w.wo_date)
                  <= (SELECT d FROM anchor)      THEN 'W'
             WHEN la.status IN ('D','I')         THEN la.status
             ELSE 'A' END                       AS status,
        la.loan_tenure::numeric                 AS orig_tenure_m,
        la.last_demand_date::date               AS maturity_date,
        la.int_rate::numeric                    AS roi,
        coalesce(la.total_loan_amount, 0)       AS ticket,
        nullif(trim(la.purpose_id::text), '')   AS purpose,
        la.cycle::numeric                       AS cycle_no,
        la.repayment_frequency::text            AS repay_freq,
        nullif(trim(b.caste::text), '')         AS caste,
        nullif(trim(b.religion::text), '')      AS religion
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN wo_master  w  ON w.loan_id  = la.loan_id
    LEFT JOIN jlg_cash   jc ON jc.loan_id = la.loan_id
    LEFT JOIN jlg_dpd    d  ON d.loan_id  = la.loan_id
    LEFT JOIN public.home_brrwr_misc b ON b.cust_id = la.cust_id
    WHERE la.status <> 'R'
      AND la.loan_id >= 10000000
      AND la.disbursement_date::date <= (SELECT d FROM anchor)
      AND (la.closure_date IS NULL
           OR la.closure_date::date > (SELECT d FROM anchor)
           -- A write-off IS a closure in the core system, so the guard above
           -- would erase the written-off book from every historical cut: at
           -- 2026-03-31 it dropped 1,540 loans and left the With/Excl W-O toggle
           -- with nothing to move. The live file exempts them the same way, via
           -- `OR la.status = 'W'`; here the exemption has to be date-bound,
           -- because wo_master is already filtered to wo_date <= {as_on}.
           OR coalesce(la.writeoff_date::date, w.wo_date) <= (SELECT d FROM anchor))
      -- Mirrors the live file's `(la.status != 'W' OR la.prin_os > 0)`: a
      -- write-off carrying nothing outstanding at the cut is not part of the
      -- write-off book. Measured against the recomputed balance, not prin_os,
      -- which is a current-state column.
      AND (coalesce(la.writeoff_date::date, w.wo_date) > (SELECT d FROM anchor)
           OR coalesce(la.writeoff_date::date, w.wo_date) IS NULL
           OR greatest(coalesce(la.total_loan_amount, 0)
                       - coalesce(jc.prin_coll, 0), 0) > 0)
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id = la.loan_id
            AND il.disbursement_date > la.disbursement_date
            AND il.disbursement_date::date <= (SELECT d FROM anchor))
),

all_loans AS (
    SELECT * FROM il_loans
    UNION ALL
    SELECT * FROM jlg_loans
),

-- Identical labelling to portfolio_cuts.sql. Kept verbatim so a historical cut
-- and today's cut band a loan the same way.
labelled AS (
    SELECT
        al.*,
        coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
        coalesce(h.region_name,  'Unassigned') AS region_name,
        coalesce(h.area_name,    'Unassigned') AS area_name,
        coalesce(h.branch_name,  'Unassigned') AS branch_name,
        h.state_id, h.district_id,
        CASE al.status WHEN 'A' THEN 'Active' WHEN 'W' THEN 'Write-off'
                       WHEN 'D' THEN 'Death'  WHEN 'I' THEN 'Death'
                       ELSE al.status END                       AS loan_status,

        CASE WHEN al.orig_tenure_m IS NULL      THEN 'Unknown'
             WHEN al.orig_tenure_m <= 12        THEN '1 - 12 M'
             WHEN al.orig_tenure_m <= 24        THEN '13 - 24 M'
             WHEN al.orig_tenure_m <= 36        THEN '25 - 36 M'
             ELSE                                    '> 36 M' END AS orig_tenure_band,

        CASE WHEN al.maturity_date IS NULL                                    THEN 'Unknown'
             WHEN al.maturity_date <= (SELECT d FROM anchor)                  THEN 'Matured'
             WHEN al.maturity_date <= (SELECT d FROM anchor) + 90             THEN '1 - 3 M'
             WHEN al.maturity_date <= (SELECT d FROM anchor) + 180            THEN '4 - 6 M'
             WHEN al.maturity_date <= (SELECT d FROM anchor) + 365            THEN '7 - 12 M'
             WHEN al.maturity_date <= (SELECT d FROM anchor) + 547            THEN '13 - 18 M'
             WHEN al.maturity_date <= (SELECT d FROM anchor) + 730            THEN '19 - 24 M'
             WHEN al.maturity_date <= (SELECT d FROM anchor) + 1095           THEN '25 - 36 M'
             ELSE                                                                  '> 36 M' END AS resid_tenure_band,

        CASE WHEN al.roi IS NULL OR al.roi <= 0 THEN 'Unknown'
             WHEN al.roi < 21                   THEN '< 21.00 %'
             WHEN al.roi <= 23                  THEN '21.00 - 23.00 %'
             WHEN al.roi <= 26                  THEN '24.00 - 26.00 %'
             WHEN al.roi <= 28                  THEN '27.00 - 28.00 %'
             ELSE                                    '> 28.00 %' END AS roi_band,

        CASE WHEN al.ticket <=   20000 THEN '<= 20,000'
             WHEN al.ticket <=   50000 THEN '21,000 - 50,000'
             WHEN al.ticket <=   75000 THEN '51,000 - 75,000'
             WHEN al.ticket <=  100000 THEN '76,000 - 1,00,000'
             WHEN al.ticket <=  150000 THEN '1,01,000 - 1,50,000'
             WHEN al.ticket <=  200000 THEN '1,51,000 - 2,00,000'
             WHEN al.ticket <=  300000 THEN '2,01,000 - 3,00,000'
             WHEN al.ticket <=  500000 THEN '3,01,000 - 5,00,000'
             WHEN al.ticket <= 1000000 THEN '5,01,000 - 10,00,000'
             ELSE                           '> 10,00,000' END AS ticket_band,

        CASE WHEN al.cycle_no IS NULL THEN 'Unknown'
             WHEN al.cycle_no >= 5    THEN '5 +'
             ELSE al.cycle_no::int::text END AS cycle_band,

        CASE al.repay_freq WHEN '1' THEN 'Monthly' WHEN '7' THEN 'Weekly'
             ELSE coalesce(al.repay_freq, 'Unknown') END AS repay_freq_label,

        CASE upper(al.caste) WHEN 'GEN' THEN 'General'  WHEN 'MIN' THEN 'Minority'
                             WHEN 'OBC' THEN 'OBC'      WHEN 'SC'  THEN 'Scheduled Castes'
                             WHEN 'ST'  THEN 'Scheduled Tribe'
             ELSE coalesce(al.caste, 'Unknown') END AS caste_label,

        CASE upper(al.religion) WHEN 'HIN' THEN 'Hindu'  WHEN 'MUS' THEN 'Muslim'
                                WHEN 'CHR' THEN 'Christian' WHEN 'JN' THEN 'JAIN'
                                WHEN 'SIK' THEN 'Sikh'   WHEN 'OTH' THEN 'Other'
             ELSE coalesce(al.religion, 'Unknown') END AS religion_label,

        w.wo_date, w.wo_amount
    FROM all_loans al
    LEFT JOIN hierarchy h ON h.branch_id = al.branch_id
    LEFT JOIN wo_master w ON w.loan_id   = al.loan_id
),

cuts AS (
    SELECT l.*, c.cut_type, c.cut_value, c.cut_rank
    FROM labelled l
    CROSS JOIN LATERAL (VALUES
        ('Business Segment',  l.business_segment,
             CASE l.business_segment WHEN 'IEL' THEN 1 WHEN 'JLG' THEN 2 ELSE 3 END),
        ('Geography',         coalesce(l.state_id::text, 'Unknown'), 0),
        ('Original Tenure',   l.orig_tenure_band,
             CASE l.orig_tenure_band WHEN '1 - 12 M' THEN 1 WHEN '13 - 24 M' THEN 2
                  WHEN '25 - 36 M' THEN 3 WHEN '> 36 M' THEN 4 ELSE 9 END),
        ('Residual Tenure',   l.resid_tenure_band,
             CASE l.resid_tenure_band WHEN 'Matured' THEN 0 WHEN '1 - 3 M' THEN 1
                  WHEN '4 - 6 M' THEN 2 WHEN '7 - 12 M' THEN 3 WHEN '13 - 18 M' THEN 4
                  WHEN '19 - 24 M' THEN 5 WHEN '25 - 36 M' THEN 6 WHEN '> 36 M' THEN 7
                  ELSE 9 END),
        ('ROI',               l.roi_band,
             CASE l.roi_band WHEN '< 21.00 %' THEN 1 WHEN '21.00 - 23.00 %' THEN 2
                  WHEN '24.00 - 26.00 %' THEN 3 WHEN '27.00 - 28.00 %' THEN 4
                  WHEN '> 28.00 %' THEN 5 ELSE 9 END),
        ('Ticket Size',       l.ticket_band,
             CASE l.ticket_band WHEN '<= 20,000' THEN 1 WHEN '21,000 - 50,000' THEN 2
                  WHEN '51,000 - 75,000' THEN 3 WHEN '76,000 - 1,00,000' THEN 4
                  WHEN '1,01,000 - 1,50,000' THEN 5 WHEN '1,51,000 - 2,00,000' THEN 6
                  WHEN '2,01,000 - 3,00,000' THEN 7 WHEN '3,01,000 - 5,00,000' THEN 8
                  WHEN '5,01,000 - 10,00,000' THEN 9 ELSE 10 END),
        ('Loan Purpose',      coalesce(l.purpose, 'Unknown'), 0),
        ('Cycle',             l.cycle_band,
             CASE l.cycle_band WHEN '5 +' THEN 5 WHEN 'Unknown' THEN 9
                  ELSE l.cycle_band::int END),
        ('Repay Frequency',   l.repay_freq_label, 0),
        ('Caste',             l.caste_label, 0),
        ('Religion',          l.religion_label, 0)
    ) AS c(cut_type, cut_value, cut_rank)
)

SELECT
    (SELECT d FROM anchor)                    AS data_date,
    c.cut_type,
    c.cut_value,
    max(c.cut_rank)                           AS cut_rank,
    c.business_segment,
    c.loan_status,
    c.cluster_name, c.region_name, c.area_name, c.branch_name, c.branch_id,
    c.lo_id, c.state_id, c.district_id,

    count(*) FILTER (WHERE c.dpd = 0)                                  AS n_regular,
    count(*) FILTER (WHERE c.dpd BETWEEN   1 AND  30)                  AS n_1_30,
    count(*) FILTER (WHERE c.dpd BETWEEN  31 AND  60)                  AS n_31_60,
    count(*) FILTER (WHERE c.dpd BETWEEN  61 AND  90)                  AS n_61_90,
    count(*) FILTER (WHERE c.dpd BETWEEN  91 AND 180)                  AS n_91_180,
    count(*) FILTER (WHERE c.dpd BETWEEN 181 AND 360)                  AS n_181_360,
    count(*) FILTER (WHERE c.dpd > 360)                                AS n_360_plus,
    count(*)                                                           AS n_total,

    round(sum(c.pos) FILTER (WHERE c.dpd = 0)::numeric, 2)                 AS pos_regular,
    round(sum(c.pos) FILTER (WHERE c.dpd BETWEEN   1 AND  30)::numeric, 2) AS pos_1_30,
    round(sum(c.pos) FILTER (WHERE c.dpd BETWEEN  31 AND  60)::numeric, 2) AS pos_31_60,
    round(sum(c.pos) FILTER (WHERE c.dpd BETWEEN  61 AND  90)::numeric, 2) AS pos_61_90,
    round(sum(c.pos) FILTER (WHERE c.dpd BETWEEN  91 AND 180)::numeric, 2) AS pos_91_180,
    round(sum(c.pos) FILTER (WHERE c.dpd BETWEEN 181 AND 360)::numeric, 2) AS pos_181_360,
    round(sum(c.pos) FILTER (WHERE c.dpd > 360)::numeric, 2)               AS pos_360_plus,
    round(sum(c.pos)::numeric, 2)                                          AS pos_total,

    round(sum(c.pos) FILTER (WHERE c.dpd >=  1)::numeric, 2)               AS par0_pos,
    round(sum(c.pos) FILTER (WHERE c.dpd >  30)::numeric, 2)               AS par30_pos,
    round(sum(c.pos) FILTER (WHERE c.dpd >  90)::numeric, 2)               AS par90_pos,
    round(sum(c.pos) FILTER (WHERE c.dpd >  60)::numeric, 2)               AS par60_pos,

    -- The three calendar months ending at {as_on}, not ending today.
    count(*) FILTER (WHERE c.wo_date >= (SELECT wo_from FROM anchor))      AS wo3m_count,
    round(coalesce(sum(c.wo_amount) FILTER (
             WHERE c.wo_date >= (SELECT wo_from FROM anchor)), 0)::numeric, 2) AS wo3m_amount

FROM cuts c
GROUP BY c.cut_type, c.cut_value, c.business_segment, c.loan_status,
         c.cluster_name, c.region_name, c.area_name, c.branch_name,
         c.branch_id, c.lo_id, c.state_id, c.district_id
