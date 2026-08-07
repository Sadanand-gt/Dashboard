-- =============================================================================
-- Report  : PORTFOLIO CUTS
-- Source  : "August, 2026 Dashboards.xlsb" sheets 28-39
--           ("Portfolio Cuts - Business Seg" ... "Portfolio Cuts - Religion")
--
-- Every one of those sheets is the SAME table: a dimension down the side and,
-- across the top, # Loans by DPD bucket / Rs POS by DPD bucket / PAR % /
-- write-off in the last 3 months. Only the side dimension changes. So this
-- builds ONE tall table: the live book is scanned once and unpivoted into
-- (cut_type, cut_value) pairs, and the dashboard picks a cut_type.
--
-- Universe: the LIVE book, identical to aum_live.sql / Current Outstanding —
--           same closure guard, same junk-id floor, same later-disbursement
--           dedupe. POS is principal_outstanding (the core system's balance).
--
-- Write-off measures are a SEPARATE universe on the same row: loans written off
-- in the last 3 calendar months, carrying their own cut values. They are not in
-- the live book, so they are counted through wo_3m only and never in n_*/pos_*.
--
-- Location Type (Rural/Semi-Urban/Urban) is NOT built. Excel sources it from the
-- AUM Loandump's RURAL/URBAN column; the replica has no equivalent. area_master
-- .area_type holds TM/ZM/CR (hierarchy codes, not habitat) and
-- village_master.rural_flag is empty. Confirmed 2026-08-07.
-- =============================================================================

WITH

anchor AS (
    -- T-1: the warehouse holds data through yesterday.
    SELECT (current_date - 1)::date AS d,
    -- "Write-off in Last 3 Months" = this calendar month plus the previous two.
           (date_trunc('month', current_date - 1) - interval '2 months')::date AS wo_from
),

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
-- IL
-- ═════════════════════════════════════════════════════════════════════════════
il_loans AS (
    SELECT
        CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
               OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
             THEN 'LAP' ELSE 'IEL' END          AS business_segment,
        la.loan_id,
        la.branch_id,
        la.loan_officer::varchar                AS lo_id,
        coalesce(la.principal_outstanding, 0)   AS pos,
        coalesce(la.dpd, 0)                     AS dpd,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END        AS status,
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
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    LEFT JOIN public.brrwroth_il b ON b.cust_id = la.cust_id
    WHERE la.status IN ('A','D','I','W')
      AND la.loan_id >= 10000000
      AND (la.closure_date IS NULL
           OR la.closure_date::date > current_date - 1
           OR la.status = 'W')
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id = la.loan_id
            AND il.status IN ('A','D','I','W')
            AND il.disbursement_date > la.disbursement_date)
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
        coalesce(la.prin_os, 0)                 AS pos,
        coalesce(la.dpd, 0)                     AS dpd,
        CASE WHEN la.status = 'W' OR (w.loan_id IS NOT NULL
                  AND (w.wo_date IS NULL OR la.disbursement_date::date <= w.wo_date))
             THEN 'W' ELSE la.status END        AS status,
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
    LEFT JOIN wo_master w ON w.loan_id = la.loan_id
    LEFT JOIN public.home_brrwr_misc b ON b.cust_id = la.cust_id
    -- Universe guards identical to aum_live.sql's jlg_loans, so Portfolio Cuts
    -- totals tie to Current Outstanding rather than drifting from it.
    WHERE la.status IN ('A','D','I','W')
      AND la.loan_id >= 10000000
      AND (la.status != 'W' OR la.prin_os > 0)
      AND (la.closure_date IS NULL
           OR la.closure_date::date > current_date - 1
           OR la.status = 'W')
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id = la.loan_id
            AND il.status IN ('A','D','I','W')
            AND il.disbursement_date > la.disbursement_date)
),

all_loans AS (
    SELECT * FROM il_loans
    UNION ALL
    SELECT * FROM jlg_loans
),

-- ═════════════════════════════════════════════════════════════════════════════
-- Per-loan cut values. Bands follow the Excel sheets exactly; the 21,000-50,000
-- ticket band was not visible in the saved (filtered) workbook and is included
-- to complete the ladder. Codes are expanded to the Excel labels 1:1.
-- ═════════════════════════════════════════════════════════════════════════════
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

        -- Residual tenure from last_demand_date for BOTH books (the final
        -- scheduled instalment is the effective maturity).
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

-- One row per (loan, cut). cut_rank drives display order so bands never sort
-- alphabetically ("1 - 12 M" before "> 36 M").
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
    c.cluster_name, c.region_name, c.area_name, c.branch_name,
    c.branch_id,
    coalesce(c.lo_id, 'N/A')                  AS lo_id,
    c.state_id, c.district_id,

    -- LIVE BOOK — # loans and POS by DPD bucket. Write-offs are excluded from
    -- these by loan_status, exactly as the Excl-W/O view works elsewhere.
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

    -- PAR numerators. Percentages are derived in the backend from these sums so
    -- they stay correct under any grouping (a ratio cannot be summed).
    round(sum(c.pos) FILTER (WHERE c.dpd >=  1)::numeric, 2)               AS par0_pos,
    round(sum(c.pos) FILTER (WHERE c.dpd >  30)::numeric, 2)               AS par30_pos,
    round(sum(c.pos) FILTER (WHERE c.dpd >  90)::numeric, 2)               AS par90_pos,
    -- par60_pos exists because the Excel sheet's "PAR > 90 %" column is
    -- arithmetically POS in 61-90 and above over total POS, i.e. DPD > 60.
    -- Checked against sheet 28's own printed buckets on 2026-08-07: IEL prints
    -- 3.80%, and (1,895,109 + 5,104,207 + 2,895,270) / 260,365,636 = 3.80%,
    -- while a true DPD > 90 gives 3.07%. JLG prints 1.17% and DPD > 60 gives
    -- 1.17% against 1.05% for DPD > 90. par90_pos is the literal PAR > 90;
    -- par60_pos reproduces the Excel column. Both are stored so switching
    -- between them is a display choice, not a pipeline rebuild.
    round(sum(c.pos) FILTER (WHERE c.dpd >  60)::numeric, 2)               AS par60_pos,

    -- WRITE-OFF IN LAST 3 MONTHS — separate universe, same cut value.
    count(*) FILTER (WHERE c.wo_date >= (SELECT wo_from FROM anchor))      AS wo3m_count,
    round(coalesce(sum(c.wo_amount) FILTER (
             WHERE c.wo_date >= (SELECT wo_from FROM anchor)), 0)::numeric, 2) AS wo3m_amount

FROM cuts c
GROUP BY c.cut_type, c.cut_value, c.business_segment, c.loan_status,
         c.cluster_name, c.region_name, c.area_name, c.branch_name,
         c.branch_id, c.lo_id, c.state_id, c.district_id
