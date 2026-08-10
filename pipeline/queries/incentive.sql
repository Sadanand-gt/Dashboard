-- =============================================================================
-- Report : INCENTIVE  —  BM track, current FY, month-wise
--          ***STILL UNVERIFIED — see the verification block at the bottom.***
--
-- SOURCES (extracted, nothing inferred):
--   References/All Incentive Policy/Grade_Manual_DAX.txt          (57 measures)
--   References/All Incentive Policy/Incentive_Slabs_Extracted.txt (6 slab files)
--
-- RULES ENCODED
--   Grade       plain band lookup on 0-BUCKET POS (DAX "Grade", verbatim):
--                 < 3 Cr = C, < 6 Cr = B, < 9 Cr = A, >= 9 Cr = A+
--   Pre_Grade   the SAME bands on the PREVIOUS month's 0-bucket POS
--   Paid on     PREVIOUS grade                    (decision 2026-08-10)
--   CE %        0B collections / 0B demand        (DAX "CE %", verbatim)
--   Recovery    1-60 coll * 0.02 + 60+ coll * 0.04 (DAX, verbatim; paid
--               independently — never multiplied by anything)
--   Final       Core Matrix + Recovery + Upgrade  (DAX, ADDITION)
--   LAP Booster NOT APPLIED                       (decision 2026-08-10)
--   Eligibility STRICT — any exit_date disqualifies EVERY month of the FY,
--               including months actually worked  (decision 2026-08-10)
--   Centre      transfer on/before the 5th counts for the NEW owner that month
--   Window      current FY (Apr-Mar), month-wise
--
-- MATRIX ALIGNMENT — the bug this file previously had.
--   The published rows carry SEVEN columns, not six. The leading "–" is a
--   "< 98.51%" column that pays NOTHING; the six paying bands follow it:
--     idx 1 = 98.51-98.99   2 = 99.00-99.24   3 = 99.25-99.49
--     idx 4 = 99.50-99.69   5 = 99.70-99.99   6 = 100.00
--   An earlier draft mapped the first paying value to 99.00-99.24, shifting
--   every cell one band left and systematically UNDER-paying. Slab errors do
--   not raise — they return a plausible figure — so the alignment is spelled
--   out here rather than left to the reader.
--
-- NOT YET BUILT (absent on purpose, never guessed):
--   * DM / SH / BCM / LO tracks — their DAX chains carry a CE multiplier this
--     track does not have.
--   * Yellow / Red branch states, which use CE Base Payout, not the Core Matrix.
--   * Upgrade Paid Bonus — the DAX exists, its slab has not been read. Emitted
--     as NULL and excluded from final_incentive.
--   * IL side of CE% and disbursement: JLG only below.
--   * Centre-level attribution — centre_owner is built but this attributes by
--     branch.
--
-- NOTE, not a defect to "fix": Grade A and Grade A+ publish IDENTICAL matrices.
-- Encoded as published. Confirm with the policy owner that A+ is genuinely paid
-- at Grade A rates.
--
-- SOURCING / OPEN DESIGN QUESTION
--   Pipeline SQL runs on the REPLICA; rpt_trend_full lives in the report
--   Postgres and cannot be joined across databases. This file therefore
--   RECOMPUTES the monthly branch measures. If those definitions drift from
--   trend_full's, incentive stops tying the dashboards — the same class of
--   problem fixed elsewhere this month. The alternative is building it in
--   pandas in runner.py from rpt_trend_full. Decide before go-live.
-- =============================================================================

WITH

fy AS (
    SELECT CASE WHEN extract(month FROM current_date) >= 4
                THEN make_date(extract(year FROM current_date)::int, 4, 1)
                ELSE make_date(extract(year FROM current_date)::int - 1, 4, 1)
           END AS fy_start
),
months AS (
    SELECT date_trunc('month', gs)::date                                AS month_start,
           (date_trunc('month', gs) + interval '1 month - 1 day')::date  AS month_end
    FROM fy, generate_series(fy.fy_start,
                             (date_trunc('month', current_date) - interval '1 day')::date,
                             interval '1 month') gs
),

-- ── EMPLOYEES + STRICT EXIT GATE ─────────────────────────────────────────────
exits AS (
    SELECT employee_id::bigint AS employee_id, min(exit_date)::date AS exit_date
    FROM public.employee_master_audit
    WHERE exit_date IS NOT NULL
    GROUP BY 1
),
emp AS (
    SELECT e.employee_id::bigint                        AS employee_id,
           e.employee_name, e.designation_name, e.grade_name,
           coalesce(e.current_branch_id, e.branch_id)   AS branch_id,
           e.active, x.exit_date
    FROM public.home_employee_master e
    LEFT JOIN exits x ON x.employee_id = e.employee_id::bigint
    WHERE e.employee_id IS NOT NULL
),

-- ── CENTRE OWNERSHIP PER MONTH (the 5th-of-month rule) ───────────────────────
-- Built and kept for the centre-level attribution still to come. The owner for
-- a month is the latest revision effective on or before the 5th, so a transfer
-- landing after the 5th takes effect the FOLLOWING month.
centre_owner AS (
    SELECT DISTINCT ON (m.month_end, a.center_id)
           m.month_end, a.center_id,
           a.assigned_to::text AS employee_id_txt, a.branch_id
    FROM months m
    JOIN public.center_master_audit a
      ON a.modified_on::date <= (m.month_start + interval '4 days')::date
    ORDER BY m.month_end, a.center_id, a.modified_on DESC
),

-- ── 0-BUCKET POS PER BRANCH PER MONTH (the grading AUM) ─────────────────────
-- "AUM = 0-Bucket outstanding portfolio" per the policy — NOT total POS.
jlg_pos AS (
    SELECT m.month_end, cm.branch_id,
           sum(CASE WHEN coalesce(la.dpd,0) = 0 THEN la.prin_os ELSE 0 END) AS zero_bucket_pos
    FROM months m
    JOIN public.home_loan_account la
      ON la.disbursement_date::date <= m.month_end
     AND (la.closure_date IS NULL OR la.closure_date::date > m.month_end)
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    WHERE la.status IN ('A','D','I','W') AND la.loan_id >= 10000000
    GROUP BY 1,2
),
il_pos AS (
    SELECT m.month_end, la.branch_id,
           sum(CASE WHEN coalesce(la.dpd,0) = 0 THEN la.principal_outstanding ELSE 0 END) AS zero_bucket_pos
    FROM months m
    JOIN public.loan_account_il la
      ON la.disbursement_date::date <= m.month_end
     AND (la.closure_date IS NULL OR la.closure_date::date > m.month_end)
    WHERE la.status IN ('A','D','I','W') AND la.loan_id >= 10000000
    GROUP BY 1,2
),
branch_month AS (
    SELECT month_end, branch_id, sum(zero_bucket_pos) AS zero_bucket_pos
    FROM (SELECT * FROM jlg_pos UNION ALL SELECT * FROM il_pos) u
    GROUP BY 1,2
),
graded AS (
    SELECT b.*,
           lag(b.zero_bucket_pos) OVER (PARTITION BY b.branch_id ORDER BY b.month_end)
               AS zero_bucket_pos_prev,
           CASE WHEN b.zero_bucket_pos <  30000000 THEN 'Grade C'
                WHEN b.zero_bucket_pos <  60000000 THEN 'Grade B'
                WHEN b.zero_bucket_pos <  90000000 THEN 'Grade A'
                ELSE                                    'Grade A+' END AS grade
    FROM branch_month b
),
graded2 AS (
    SELECT g.*,
           CASE WHEN g.zero_bucket_pos_prev IS NULL     THEN NULL
                WHEN g.zero_bucket_pos_prev < 30000000  THEN 'Grade C'
                WHEN g.zero_bucket_pos_prev < 60000000  THEN 'Grade B'
                WHEN g.zero_bucket_pos_prev < 90000000  THEN 'Grade A'
                ELSE                                         'Grade A+' END AS prev_grade
    FROM graded g
),

-- ── CE %, DISBURSEMENT, BUCKET COLLECTIONS ──────────────────────────────────
-- status='A' only: 'V' rows carry zero amount and 'R' rows are reversals —
-- tested against Excel on the write-off recovery measure (A alone was closest).
demand_m AS (
    SELECT m.month_end, cm.branch_id,
           -- total_amt_due is the per-instalment demand on repayment_schedule
           -- (there is no demand_amount column). Principal + interest.
           sum(coalesce(rs.total_amt_due,0)) AS zero_bucket_demand
    FROM months m
    JOIN public.repayment_schedule rs
      ON rs.demand_date BETWEEN m.month_start AND m.month_end
    JOIN public.home_loan_account la  ON la.loan_id   = rs.loan_id
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    GROUP BY 1,2
),
coll_m AS (
    SELECT m.month_end, cm.branch_id,
           sum(coalesce(rd.principal_collected,0)+coalesce(rd.interest_collected,0)) AS zero_bucket_coll,
           sum(CASE WHEN coalesce(la.dpd,0) BETWEEN 1 AND 60
                    THEN coalesce(rd.principal_collected,0)+coalesce(rd.interest_collected,0)
                    ELSE 0 END) AS coll_1_60,
           sum(CASE WHEN coalesce(la.dpd,0) > 60
                    THEN coalesce(rd.principal_collected,0)+coalesce(rd.interest_collected,0)
                    ELSE 0 END) AS coll_60_plus
    FROM months m
    JOIN public.repayment_detail rd
      ON rd.collection_date BETWEEN m.month_start AND m.month_end
     AND rd.status = 'A'
    JOIN public.home_loan_account la  ON la.loan_id   = rd.loan_id
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    GROUP BY 1,2
),
disb_m AS (
    SELECT m.month_end, cm.branch_id,
           sum(coalesce(la.total_loan_amount,0)) AS disb_amount,
           count(*)                              AS disb_count
    FROM months m
    JOIN public.home_loan_account la
      ON la.disbursement_date::date BETWEEN m.month_start AND m.month_end
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    WHERE la.loan_id >= 10000000
    GROUP BY 1,2
),

-- ── CORE MATRIX — all four growth grades, seven columns, six paying bands ────
-- payouts[1..6] = 98.51-98.99, 99.00-99.24, 99.25-99.49, 99.50-99.69,
--                 99.70-99.99, 100.00.  Below 98.51% pays nothing (hard cliff).
core_matrix(grade, disb_lo, disb_hi, payouts) AS (
    VALUES
    ('Grade A+',       0::numeric,  3000000::numeric, ARRAY[ 500, 1000, 1500, 3000, 4000, 5000]),
    ('Grade A+', 3000000,  3500000, ARRAY[1000, 1500, 3000, 4500, 6000, 7500]),
    ('Grade A+', 3500000,  4000000, ARRAY[1500, 2000, 4500, 6000, 8000,10000]),
    ('Grade A+', 4000000,  4500000, ARRAY[2000, 3000, 6000, 8000,10000,12500]),
    ('Grade A+', 4500000,  5000000, ARRAY[2500, 3500, 7500,10000,12500,15000]),
    ('Grade A+', 5000000,  5500000, ARRAY[3000, 4000, 9000,12000,15000,17500]),
    ('Grade A+', 5500000,  6000000, ARRAY[3500, 5000,10500,14000,17500,20000]),
    ('Grade A+', 6000000, 99999999999, ARRAY[4000, 6000,12000,16000,20000,22500]),

    ('Grade A',        0,  3000000, ARRAY[ 500, 1000, 1500, 3000, 4000, 5000]),
    ('Grade A',  3000000,  3500000, ARRAY[1000, 1500, 3000, 4500, 6000, 7500]),
    ('Grade A',  3500000,  4000000, ARRAY[1500, 2000, 4500, 6000, 8000,10000]),
    ('Grade A',  4000000,  4500000, ARRAY[2000, 3000, 6000, 8000,10000,12500]),
    ('Grade A',  4500000,  5000000, ARRAY[2500, 3500, 7500,10000,12500,15000]),
    ('Grade A',  5000000,  5500000, ARRAY[3000, 4000, 9000,12000,15000,17500]),
    ('Grade A',  5500000,  6000000, ARRAY[3500, 5000,10500,14000,17500,20000]),
    ('Grade A',  6000000, 99999999999, ARRAY[4000, 6000,12000,16000,20000,22500]),

    ('Grade B',        0,  2500000, ARRAY[ 500, 1000, 1500, 2500, 3500, 4000]),
    ('Grade B',  2500000,  3000000, ARRAY[1000, 1500, 2500, 4000, 5000, 6500]),
    ('Grade B',  3000000,  3500000, ARRAY[1500, 2000, 4000, 5000, 7000, 8500]),
    ('Grade B',  3500000,  4000000, ARRAY[1750, 2500, 5000, 7000, 8500,10500]),
    ('Grade B',  4000000,  4500000, ARRAY[2000, 3000, 6500, 8500,10500,13000]),
    ('Grade B',  4500000,  5000000, ARRAY[2500, 3500, 7500,10000,13000,15000]),
    ('Grade B',  5000000,  5500000, ARRAY[3000, 4000, 9000,12000,15000,17000]),
    ('Grade B',  5500000, 99999999999, ARRAY[3500, 5000,10000,13500,17000,19000]),

    ('Grade C',        0,  2000000, ARRAY[ 500,  750, 1000, 2000, 2500, 3500]),
    ('Grade C',  2000000,  2500000, ARRAY[ 750, 1000, 2000, 3000, 4000, 5000]),
    ('Grade C',  2500000,  3000000, ARRAY[1000, 1500, 3000, 4000, 5500, 6500]),
    ('Grade C',  3000000,  3500000, ARRAY[1500, 2000, 4000, 5500, 6500, 8000]),
    ('Grade C',  3500000,  4000000, ARRAY[1750, 2500, 5000, 6500, 8000,10000]),
    ('Grade C',  4000000,  4500000, ARRAY[2000, 3000, 6000, 8000,10000,11500]),
    ('Grade C',  4500000,  5000000, ARRAY[2500, 3500, 7000, 9500,11500,13000]),
    ('Grade C',  5000000, 99999999999, ARRAY[3000, 4000, 8000,10500,13000,14500])
),

metrics AS (
    SELECT g.month_end, g.branch_id, g.zero_bucket_pos, g.grade, g.prev_grade,
           coalesce(dm.zero_bucket_demand,0) AS zero_bucket_demand,
           coalesce(cm.zero_bucket_coll,0)   AS zero_bucket_coll,
           CASE WHEN coalesce(dm.zero_bucket_demand,0) > 0
                THEN round((cm.zero_bucket_coll / dm.zero_bucket_demand)::numeric, 4)
           END                               AS ce_pct,
           coalesce(dz.disb_amount,0)        AS disb_amount,
           coalesce(dz.disb_count,0)         AS disb_count,
           coalesce(cm.coll_1_60,0)          AS coll_1_60,
           coalesce(cm.coll_60_plus,0)       AS coll_60_plus
    FROM graded2 g
    LEFT JOIN demand_m dm ON dm.month_end = g.month_end AND dm.branch_id = g.branch_id
    LEFT JOIN coll_m   cm ON cm.month_end = g.month_end AND cm.branch_id = g.branch_id
    LEFT JOIN disb_m   dz ON dz.month_end = g.month_end AND dz.branch_id = g.branch_id
),

-- The CE band index, computed once so the matrix lookup and the final total can
-- never disagree about which band applied.
priced AS (
    SELECT m.*,
           CASE WHEN m.ce_pct >= 1.0000 THEN 6
                WHEN m.ce_pct >= 0.9970 THEN 5
                WHEN m.ce_pct >= 0.9950 THEN 4
                WHEN m.ce_pct >= 0.9925 THEN 3
                WHEN m.ce_pct >= 0.9900 THEN 2
                WHEN m.ce_pct >= 0.9851 THEN 1
           END AS ce_band
    FROM metrics m
)

SELECT
    current_date        AS report_day,
    (current_date - 1)  AS data_date,
    to_char((SELECT fy_start FROM fy), 'YYYY') || '-' ||
        to_char((SELECT fy_start FROM fy) + interval '1 year', 'YY') AS fy,
    p.month_end,

    e.employee_id, e.employee_name, e.designation_name,
    'BM'::text          AS role_track,
    e.grade_name,
    p.branch_id,
    (upper(coalesce(e.active,'N')) = 'Y')  AS is_active,
    e.exit_date,

    round(p.zero_bucket_pos::numeric, 2)    AS aum,
    p.grade,
    p.prev_grade,
    round(p.zero_bucket_pos::numeric, 2)    AS zero_bucket_pos,
    round(p.zero_bucket_demand::numeric, 2) AS zero_bucket_demand,
    round(p.zero_bucket_coll::numeric, 2)   AS zero_bucket_coll,
    p.ce_pct,
    round(p.disb_amount::numeric, 2)        AS disb_amount,
    p.disb_count,
    NULL::bigint                            AS disb_count_repeat,
    round(p.coll_1_60::numeric, 2)          AS coll_1_60,
    round(p.coll_60_plus::numeric, 2)       AS coll_60_plus,
    NULL::numeric                           AS wo_recovery,

    -- Core Matrix at PREVIOUS grade x disbursement band x CE band.
    coalesce(mx.payouts[p.ce_band], 0)::numeric        AS base_payout,
    NULL::numeric                                       AS ce_multiplier,
    round((p.coll_1_60 * 0.02 + p.coll_60_plus * 0.04)::numeric, 2) AS recovery_bonus,
    NULL::numeric                                       AS upgrade_bonus,

    -- Final = Core Matrix + Recovery. Upgrade bonus is excluded until its slab
    -- is read. The strict gate zeroes the whole row.
    CASE WHEN e.exit_date IS NOT NULL
           OR upper(coalesce(e.active,'N')) <> 'Y'
         THEN 0
         ELSE coalesce(mx.payouts[p.ce_band], 0)
            + round((p.coll_1_60 * 0.02 + p.coll_60_plus * 0.04)::numeric, 2)
    END::numeric                                        AS final_incentive,

    (e.exit_date IS NULL
       AND upper(coalesce(e.active,'N')) = 'Y'
       AND p.prev_grade IS NOT NULL
       AND p.ce_band IS NOT NULL)                       AS is_eligible,
    CASE WHEN e.exit_date IS NOT NULL              THEN 'EXITED'
         WHEN upper(coalesce(e.active,'N')) <> 'Y' THEN 'NOT_ACTIVE'
         WHEN p.prev_grade IS NULL                 THEN 'NO_PREV_GRADE'
         WHEN p.ce_pct IS NULL                     THEN 'NO_DEMAND'
         WHEN p.ce_band IS NULL                    THEN 'CE_BELOW_FLOOR'
    END                                                 AS ineligible_reason

FROM priced p
JOIN emp e ON e.branch_id = p.branch_id
LEFT JOIN core_matrix mx
       ON mx.grade = p.prev_grade
      AND p.disb_amount >= mx.disb_lo
      AND p.disb_amount <  mx.disb_hi
WHERE e.designation_name ILIKE '%Branch Manager%'

-- =============================================================================
-- VERIFICATION — NOT DONE. No figure here is payable until all five pass.
--   1. EXPLAIN, then run, against the replica.
--   2. Reconcile zero_bucket_pos / ce_pct / disb_amount for 3 branches against
--      rpt_trend_full for the same month. They MUST agree, or incentive stops
--      tying the dashboards.
--   3. Hand-compute 3 branches across different grades and CE bands against
--      Incentive_Slabs_Extracted.txt — this is the check that catches a
--      mis-aligned matrix, which nothing else will.
--   4. Test the 5th-of-month centre rule on a real transfer either side of it.
--   5. Confirm an employee with an exit_date shows 0 for EVERY month of the FY.
-- =============================================================================
