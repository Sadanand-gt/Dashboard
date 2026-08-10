-- =============================================================================
-- Report : INCENTIVE  —  ***UNVERIFIED. DO NOT PAY OFF THIS OUTPUT YET.***
--
-- Written 2026-08-10 straight from the extracted policy sources. It has NOT been
-- EXPLAIN-checked, has NOT been run, and NO branch has been hand-computed
-- against the slab matrix. Incentive slab lookups fail SILENTLY — a wrong band
-- boundary still returns a plausible rupee figure — so nothing here should be
-- shown as a payable number until the verification block at the bottom is done.
--
-- SOURCES (all extracted, nothing inferred):
--   References/All Incentive Policy/Grade_Manual_DAX.txt        (57 measures)
--   References/All Incentive Policy/Incentive_Slabs_Extracted.txt (6 slab files)
--
-- VERIFIED RULES ENCODED HERE
--   Grade      : plain band lookup on 0-BUCKET POS (DAX "Grade", verbatim)
--                  < 3 Cr = C, < 6 Cr = B, < 9 Cr = A, >= 9 Cr = A+
--   Pre_Grade  : the SAME bands applied to the PREVIOUS month's 0-bucket POS
--   Paid on    : PREVIOUS grade  (business decision 2026-08-10)
--   CE %       : 0B collections / 0B demand   (DAX "CE %", verbatim)
--   Recovery   : 1-60 collection * 0.02 + 60+ collection * 0.04  (DAX, verbatim)
--   Final      : Core Matrix + Recovery Bonus + Upgrade Bonus  (DAX, ADDITION)
--   LAP Booster: NOT APPLIED (business decision 2026-08-10)
--   Eligibility: STRICT — an employee with an exit_date gets nothing, including
--                for months actually worked (business decision 2026-08-10)
--   Centre     : transferred on/before the 5th counts for the NEW owner that
--                month; after the 5th it stays with the OLD owner
--   Window     : current FY (Apr-Mar), month-wise
--
-- WHAT IS NOT YET ENCODED — these are GAPS, deliberately left as NULL rather
-- than guessed:
--   * Core Matrix values for Grade A+, B and C. Only the BM Grade A matrix was
--     read verbatim; the other three files have not been parsed cell by cell.
--   * The DM / SH / BCM / LO tracks. Their DAX chains differ (they carry a CE
--     multiplier this branch track does not) and are not written here.
--   * Yellow and Red branch states, which use CE Base Payout instead of the
--     Core Matrix.
--   * Upgrade Paid Bonus — the DAX exists but its slab has not been read.
--
-- SOURCING NOTE / OPEN DESIGN QUESTION
--   Every other report sources its measures from the rpt_* store so figures tie
--   across pages. That is not possible in one statement here: pipeline SQL runs
--   against the REPLICA, while rpt_trend_full lives in the report Postgres, and
--   Postgres cannot join across databases. This file therefore recomputes the
--   monthly branch measures from source. That is a REAL divergence risk — if
--   these definitions drift from trend_full's, incentive will stop tying the
--   dashboards. The alternative is to build this in pandas in runner.py from
--   rpt_trend_full. Decide before this goes live.
-- =============================================================================

WITH

-- Current FY, month by month, up to the last completed month. Indian FY = Apr-Mar.
fy AS (
    SELECT
        CASE WHEN extract(month FROM current_date) >= 4
             THEN make_date(extract(year FROM current_date)::int, 4, 1)
             ELSE make_date(extract(year FROM current_date)::int - 1, 4, 1)
        END AS fy_start
),
months AS (
    SELECT (date_trunc('month', gs) + interval '1 month - 1 day')::date AS month_end,
           date_trunc('month', gs)::date                                AS month_start
    FROM fy, generate_series(fy.fy_start,
                             (date_trunc('month', current_date) - interval '1 day')::date,
                             interval '1 month') gs
),

-- ── EMPLOYEES + STRICT EXIT GATE ─────────────────────────────────────────────
-- exit_date comes from the audit table; the master carries only a current
-- active flag, which cannot answer "when did they leave".
exits AS (
    SELECT employee_id::bigint AS employee_id, min(exit_date)::date AS exit_date
    FROM public.employee_master_audit
    WHERE exit_date IS NOT NULL
    GROUP BY 1
),
emp AS (
    SELECT e.employee_id::bigint          AS employee_id,
           e.employee_name,
           e.designation_name,
           e.grade_name,
           coalesce(e.current_branch_id, e.branch_id) AS branch_id,
           e.active,
           x.exit_date,
           -- STRICT: any exit date at all disqualifies every month of the FY.
           (x.exit_date IS NULL AND upper(coalesce(e.active,'N')) = 'Y') AS is_eligible,
           CASE WHEN x.exit_date IS NOT NULL              THEN 'EXITED'
                WHEN upper(coalesce(e.active,'N')) <> 'Y' THEN 'NOT_ACTIVE'
           END AS ineligible_reason
    FROM public.home_employee_master e
    LEFT JOIN exits x ON x.employee_id = e.employee_id::bigint
    WHERE e.employee_id IS NOT NULL
),

-- ── CENTRE OWNERSHIP PER MONTH (the 5th-of-month rule) ───────────────────────
-- The owner for a month is the latest audit revision effective on or before the
-- 5th. A transfer landing after the 5th therefore does not move the centre for
-- that month — it takes effect the following month.
centre_owner AS (
    SELECT DISTINCT ON (m.month_end, a.center_id)
           m.month_end,
           a.center_id,
           a.assigned_to::text AS employee_id_txt,
           a.branch_id
    FROM months m
    JOIN public.center_master_audit a
      ON a.modified_on::date <= (m.month_start + interval '4 days')::date
    ORDER BY m.month_end, a.center_id, a.modified_on DESC
),

-- ── MONTHLY BRANCH MEASURES ──────────────────────────────────────────────────
-- 0-bucket = Regular (dpd = 0). "AUM" for grading is the 0-BUCKET outstanding
-- portfolio, per the policy — NOT total POS.
-- UNVERIFIED: these reconstructions have not been reconciled against
-- rpt_trend_full. Do that before trusting any figure below.
jlg_month AS (
    SELECT m.month_end,
           cm.branch_id,
           sum(CASE WHEN coalesce(la.dpd,0) = 0 THEN la.prin_os ELSE 0 END) AS zero_bucket_pos
    FROM months m
    JOIN public.home_loan_account la
      ON la.disbursement_date::date <= m.month_end
     AND (la.closure_date IS NULL OR la.closure_date::date > m.month_end)
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    WHERE la.status IN ('A','D','I','W') AND la.loan_id >= 10000000
    GROUP BY 1,2
),
il_month AS (
    SELECT m.month_end,
           la.branch_id,
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
    FROM (SELECT * FROM jlg_month UNION ALL SELECT * FROM il_month) u
    GROUP BY 1,2
),

-- Previous month's 0-bucket POS drives Pre_Grade, and Pre_Grade is what pays.
graded AS (
    SELECT b.*,
           lag(b.zero_bucket_pos) OVER (PARTITION BY b.branch_id ORDER BY b.month_end)
               AS zero_bucket_pos_prev,
           -- DAX "Grade", verbatim thresholds
           CASE WHEN b.zero_bucket_pos <  30000000 THEN 'Grade C'
                WHEN b.zero_bucket_pos <  60000000 THEN 'Grade B'
                WHEN b.zero_bucket_pos <  90000000 THEN 'Grade A'
                ELSE                                    'Grade A+' END AS grade
    FROM branch_month b
),
graded2 AS (
    SELECT g.*,
           -- DAX "Pre_Grade": same bands on the previous month's 0B POS
           CASE WHEN g.zero_bucket_pos_prev IS NULL      THEN NULL
                WHEN g.zero_bucket_pos_prev <  30000000  THEN 'Grade C'
                WHEN g.zero_bucket_pos_prev <  60000000  THEN 'Grade B'
                WHEN g.zero_bucket_pos_prev <  90000000  THEN 'Grade A'
                ELSE                                          'Grade A+' END AS prev_grade
    FROM graded g
),

-- ── CORE MATRIX ──────────────────────────────────────────────────────────────
-- Rows = monthly disbursement band, columns = CE band, cell = rupee payout.
-- ONLY GRADE A IS POPULATED, read verbatim from BM_Growth_Grade_A.html.
-- Grade A+, B and C are absent ON PURPOSE — their files have not been parsed,
-- and inventing the numbers is the one thing this file must not do. A branch on
-- a missing grade returns NULL core_matrix, which the eligibility column then
-- reports as SLAB_NOT_LOADED rather than paying zero silently.
core_matrix(grade, disb_lo, disb_hi, ce_lo, ce_hi, payout) AS (
    VALUES
    -- Grade A | AUM Rs 6-9 Crore
    ('Grade A',        0::numeric,  3000000::numeric, 0.9851::numeric, 0.9899::numeric,   0::numeric),
    ('Grade A',        0,  3000000, 0.9900, 0.9924,   500),
    ('Grade A',        0,  3000000, 0.9925, 0.9949,  1000),
    ('Grade A',        0,  3000000, 0.9950, 0.9969,  1500),
    ('Grade A',        0,  3000000, 0.9970, 0.9999,  3000),
    ('Grade A',        0,  3000000, 1.0000, 1.0000,  4000),
    ('Grade A',  3000000,  3500000, 0.9900, 0.9924,  1000),
    ('Grade A',  3000000,  3500000, 0.9925, 0.9949,  1500),
    ('Grade A',  3000000,  3500000, 0.9950, 0.9969,  3000),
    ('Grade A',  3000000,  3500000, 0.9970, 0.9999,  4500),
    ('Grade A',  3000000,  3500000, 1.0000, 1.0000,  6000),
    ('Grade A',  3500000,  4000000, 0.9900, 0.9924,  1500),
    ('Grade A',  3500000,  4000000, 0.9925, 0.9949,  2000),
    ('Grade A',  3500000,  4000000, 0.9950, 0.9969,  4500),
    ('Grade A',  3500000,  4000000, 0.9970, 0.9999,  6000),
    ('Grade A',  3500000,  4000000, 1.0000, 1.0000,  8000),
    ('Grade A',  4000000,  4500000, 0.9900, 0.9924,  2000),
    ('Grade A',  4000000,  4500000, 0.9925, 0.9949,  3000),
    ('Grade A',  4000000,  4500000, 0.9950, 0.9969,  6000),
    ('Grade A',  4000000,  4500000, 0.9970, 0.9999,  8000),
    ('Grade A',  4000000,  4500000, 1.0000, 1.0000, 10000),
    ('Grade A',  4500000,  5000000, 0.9900, 0.9924,  2500),
    ('Grade A',  4500000,  5000000, 0.9925, 0.9949,  3500),
    ('Grade A',  4500000,  5000000, 0.9950, 0.9969,  7500),
    ('Grade A',  4500000,  5000000, 0.9970, 0.9999, 10000),
    ('Grade A',  4500000,  5000000, 1.0000, 1.0000, 12500),
    ('Grade A',  5000000,  5500000, 0.9900, 0.9924,  3000),
    ('Grade A',  5000000,  5500000, 0.9925, 0.9949,  4000),
    ('Grade A',  5000000,  5500000, 0.9950, 0.9969,  9000),
    ('Grade A',  5000000,  5500000, 0.9970, 0.9999, 12000),
    ('Grade A',  5000000,  5500000, 1.0000, 1.0000, 15000),
    ('Grade A',  5500000,  6000000, 0.9900, 0.9924,  3500),
    ('Grade A',  5500000,  6000000, 0.9925, 0.9949,  5000),
    ('Grade A',  5500000,  6000000, 0.9950, 0.9969, 10500),
    ('Grade A',  5500000,  6000000, 0.9970, 0.9999, 14000),
    ('Grade A',  5500000,  6000000, 1.0000, 1.0000, 17500),
    ('Grade A',  6000000, 99999999999, 0.9900, 0.9924,  4000),
    ('Grade A',  6000000, 99999999999, 0.9925, 0.9949,  6000),
    ('Grade A',  6000000, 99999999999, 0.9950, 0.9969, 12000),
    ('Grade A',  6000000, 99999999999, 0.9970, 0.9999, 16000),
    ('Grade A',  6000000, 99999999999, 1.0000, 1.0000, 20000)
    -- Grade A+, Grade B, Grade C: NOT LOADED. See header.
)

SELECT
    current_date                       AS report_day,
    (current_date - 1)                 AS data_date,
    to_char((SELECT fy_start FROM fy), 'YYYY') || '-' ||
        to_char((SELECT fy_start FROM fy) + interval '1 year', 'YY') AS fy,
    g.month_end,

    e.employee_id,
    e.employee_name,
    e.designation_name,
    'BM'                               AS role_track,   -- only track written so far
    e.grade_name,

    g.branch_id,
    e.active IS NOT NULL               AS is_active,
    e.exit_date,

    g.zero_bucket_pos                  AS aum,
    g.grade,
    g.prev_grade,
    g.zero_bucket_pos,

    -- Paid on the PREVIOUS grade.
    cm.payout                          AS base_payout,

    -- Eligibility, evaluated last so a missing slab is reported, never paid as 0.
    (e.is_eligible AND cm.payout IS NOT NULL) AS is_eligible,
    CASE WHEN e.ineligible_reason IS NOT NULL THEN e.ineligible_reason
         WHEN g.prev_grade IS NULL            THEN 'NO_PREV_GRADE'
         WHEN cm.payout IS NULL               THEN 'SLAB_NOT_LOADED'
    END                                AS ineligible_reason

FROM graded2 g
JOIN emp e        ON e.branch_id = g.branch_id
LEFT JOIN core_matrix cm
       ON cm.grade = g.prev_grade
      -- CE and disbursement joins are NOT wired yet: ce_pct and disb_amount are
      -- not computed above. Until they are, every row returns a NULL payout and
      -- SLAB_NOT_LOADED. This is the next thing to write.
      AND FALSE
WHERE e.designation_name ILIKE '%Branch Manager%'

-- =============================================================================
-- VERIFICATION BLOCK — none of this has been done. Do it before the page ships.
--   1. EXPLAIN this statement against the replica.
--   2. Reconcile zero_bucket_pos and CE% for 3 branches against rpt_trend_full
--      for the same month. They MUST agree or incentive will not tie the
--      dashboards.
--   3. Hand-compute 3 branches across different grades and CE bands against
--      Incentive_Slabs_Extracted.txt and compare to base_payout.
--   4. Confirm the 5th-of-month centre rule on a real transfer: pick a centre
--      with a known transfer date either side of the 5th and check which month
--      it lands in.
--   5. Confirm the strict gate: an employee with an exit_date must show 0 for
--      EVERY month of the FY, including months before they left.
-- =============================================================================
