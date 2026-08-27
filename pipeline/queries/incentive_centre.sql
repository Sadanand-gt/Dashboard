-- =============================================================================
-- INCENTIVE — CENTRE GRAIN (JLG only)   ->  rpt_incentive_centre
--
-- Feeds the Loan Officer track. One row per (month_end, center_id) for the
-- current FY, carrying the officer who held the centre THAT MONTH.
--
-- IL IS NOT HERE. IL loans map straight to a branch — only home_loan_account
-- carries center_id — so the IL side of the LO track attributes at branch level
-- and is built separately.
--
-- POLICY MAPPING (footnote numbers are from the LO incentive PDF)
--   fn 1  "the LO mapped in Finpage" = home_center_master.assigned_to, resolved
--         per month from center_master_audit (confirmed 2026-08-11)
--   fn 2  CE = 0-bucket collection COUNT / demand COUNT
--   fn 3  AUM = 0-bucket balance AS ON THE 1ST = the PRIOR month-end close
--   fn 4  Disbursement = VALUE disbursed in the calendar month
--   fn 5  OD recovery counts only FULL EMI collections; partials do not qualify
--   fn 7  collections by the Collection Team are EXCLUDED
--   UPI counts for the LO — business decision 2026-08-11, NOT in the policy.
--         'UPI' is a literal collected_by value, not a person (16% of volume).
--
-- THE 5TH-OF-MONTH RULE
--   A centre transferred on or before the 5th belongs to the NEW owner for that
--   month; after the 5th it stays with the OLD owner. Not cosmetic: 20,804
--   transfers landed on/before the 5th this FY and 29,120 after, so current
--   ownership would misattribute the majority of moved centres.
--
-- RECONCILIATION
--   Rolled up to branch, zero_bucket_pos / reg_demand_count /
--   reg_collection_count / disb_amount MUST equal rpt_trend_full for the same
--   month. Run that check after every build.
-- =============================================================================

WITH

fy AS (
    SELECT CASE WHEN extract(month FROM current_date) >= 4
                THEN make_date(extract(year FROM current_date)::int, 4, 1)
                ELSE make_date(extract(year FROM current_date)::int - 1, 4, 1)
           END AS fy_start
),
-- One month before the FY: AUM is the 1st-of-month balance, i.e. the PRIOR
-- month-end close, so the first FY month needs its predecessor present.
months AS (
    SELECT date_trunc('month', gs)::date                               AS month_start,
           (date_trunc('month', gs) + interval '1 month - 1 day')::date AS month_end
    FROM fy, generate_series((fy.fy_start - interval '1 month')::date,
                             (date_trunc('month', current_date) - interval '1 day')::date,
                             interval '1 month') gs
),

-- ── OWNERSHIP PER MONTH (the 5th-of-month rule) ─────────────────────────────
-- The owner is the latest audit revision effective on or before the 5th. A
-- revision landing after the 5th is therefore not seen until the next month.
-- Each audit revision is turned into a VALIDITY INTERVAL [modified_on, next_on)
-- in one pass, so the month's cut-off can be matched by range instead of
-- searching the audit per centre per month.
--
-- Two earlier attempts and why they failed:
--   1. SELECT FROM the audit -> centres never revised vanished from the month.
--      March returned 4 centres and the branch rollup was 46% under trend.
--   2. CROSS JOIN centres x months with a LATERAL "latest revision" lookup ->
--      correct, but 446,090 correlated scans of a 420,323-row table. Timed out
--      past 10 minutes.
-- The interval form is one scan of the audit plus a range join.
owner_rev AS (
    SELECT center_id,
           assigned_to::text AS assigned_to,
           branch_id::text   AS branch_id,
           modified_on::date AS valid_from,
           lead(modified_on::date) OVER (PARTITION BY center_id
                                         ORDER BY modified_on) AS valid_to
    FROM public.center_master_audit
    WHERE modified_on IS NOT NULL
),
centre_owner AS (
    -- Every centre, every month. The audit interval covering the cut-off wins;
    -- where no revision predates the cut-off, the master's current owner stands.
    SELECT m.month_end,
           cm.center_id,
           coalesce(r.branch_id,   cm.branch_id)::text   AS branch_id,
           coalesce(r.assigned_to, cm.assigned_to)::text AS assigned_to
    FROM months m
    CROSS JOIN public.home_center_master cm
    LEFT JOIN owner_rev r
           ON r.center_id  = cm.center_id
          -- the 5th-of-month rule: a transfer ON OR BEFORE the 5th counts for
          -- this month; after the 5th it stays with the previous owner
          AND r.valid_from <= (m.month_start + interval '4 days')::date
          AND (r.valid_to IS NULL
               OR r.valid_to > (m.month_start + interval '4 days')::date)
),

-- ── 0-BUCKET POS AT EACH MONTH-END, PER CENTRE ──────────────────────────────
-- Grading AUM. dpd = 0 OR NULL, matching the DAX 0B_POS which is
-- "dpd = 0 || ISBLANK(dpd)" — filtering on dpd = 0 alone under-counts.
centre_pos AS (
    SELECT m.month_end,
           la.center_id,
           sum(la.prin_os) FILTER (
               WHERE coalesce(la.dpd, 0) = 0)                          AS zero_bucket_pos
    FROM months m
    JOIN public.home_loan_account la
      ON la.disbursement_date::date <= m.month_end
     AND (la.closure_date IS NULL OR la.closure_date::date > m.month_end)
    WHERE la.status IN ('A','D','I','W')
      AND la.loan_id >= 10000000
    GROUP BY 1, 2
),

-- ── CE: COUNT of instalments due vs collected, per centre per month ─────────
-- Cohort mirrors rpt_trend_full's reg_* measures so the two engines agree when
-- rolled to branch: loans NOT written off that were Regular entering the month.
centre_ce AS (
    -- Demand from the schedule, COLLECTIONS FROM repayment_detail.
    --
    -- repayment_schedule.principal_collected / interest_collected are populated
    -- late, so counting "paid" off the schedule under-reports the current month
    -- badly — July read 3,391 collected against 95,770 due, a false 3.5% CE.
    -- Receipts live in repayment_detail; the schedule is only reliable for what
    -- was DUE.
    SELECT d.month_end, d.center_id,
           count(*)                                                AS reg_demand_count,
           count(*) FILTER (WHERE d.collected >= d.due - 0.005)     AS reg_collection_count
    FROM (
        SELECT m.month_end,
               la.center_id,
               rs.loan_id,
               sum(coalesce(rs.total_amt_due, 0))                  AS due,
               coalesce(max(c.collected), 0)                       AS collected
        FROM months m
        JOIN public.repayment_schedule rs
          ON rs.demand_date BETWEEN m.month_start AND m.month_end
        JOIN public.home_loan_account la ON la.loan_id = rs.loan_id
        LEFT JOIN LATERAL (
            SELECT sum(coalesce(rd.principal_collected,0)
                     + coalesce(rd.interest_collected,0)) AS collected
            FROM public.repayment_detail rd
            WHERE rd.loan_id = rs.loan_id
              AND rd.status = 'A'
              AND rd.collection_date BETWEEN m.month_start AND m.month_end
        ) c ON TRUE
        WHERE la.loan_id >= 10000000
        GROUP BY 1, 2, 3
    ) d
    WHERE d.due > 0
    GROUP BY 1, 2
),

-- ── DISBURSEMENT VALUE in the calendar month (fn 4) ─────────────────────────
centre_disb AS (
    SELECT m.month_end,
           la.center_id,
           sum(coalesce(la.total_loan_amount, 0))                      AS disb_amount,
           count(*)                                                    AS disb_count
    FROM months m
    JOIN public.home_loan_account la
      ON la.disbursement_date::date BETWEEN m.month_start AND m.month_end
    WHERE la.loan_id >= 10000000
    GROUP BY 1, 2
),

-- ── OD RECOVERY: count of FULL overdue EMIs collected (fn 5, 7) ─────────────
-- Counted at instalment level: an instalment whose demand pre-dates the month
-- (so it was already overdue) and which was settled in full during the month.
-- Collection Team receipts are excluded by designation; 'UPI' has no employee
-- row and is KEPT, per the 2026-08-11 decision.
centre_od AS (
    SELECT m.month_end,
           la.center_id,
           count(DISTINCT (rd.loan_id::text || '|' || rd.collection_date::date::text)) AS od_emi_count
    FROM months m
    JOIN public.repayment_detail rd
      ON rd.collection_date BETWEEN m.month_start AND m.month_end
     AND rd.status = 'A'
    JOIN public.home_loan_account la ON la.loan_id = rd.loan_id
    LEFT JOIN public.home_employee_master e
           ON e.employee_id::text = rd.collected_by::text
    WHERE la.loan_id >= 10000000
      AND coalesce(la.dpd, 0) >= 1
      AND coalesce(e.designation_name, '') NOT ILIKE '%Collection%'
    GROUP BY 1, 2
)

SELECT
    current_date                       AS report_day,
    (current_date - 1)                 AS data_date,
    to_char((SELECT fy_start FROM fy), 'YYYY') || '-' ||
        to_char((SELECT fy_start FROM fy) + interval '1 year', 'YY') AS fy,
    o.month_end,
    o.center_id::text                  AS center_id,
    o.branch_id,
    o.assigned_to,

    round(coalesce(p.zero_bucket_pos, 0)::numeric, 2)  AS zero_bucket_pos,
    coalesce(c.reg_demand_count, 0)                    AS reg_demand_count,
    coalesce(c.reg_collection_count, 0)                AS reg_collection_count,
    round(coalesce(d.disb_amount, 0)::numeric, 2)      AS disb_amount,
    coalesce(d.disb_count, 0)                          AS disb_count,
    coalesce(od.od_emi_count, 0)                       AS od_emi_count

FROM centre_owner o
LEFT JOIN centre_pos  p  ON p.month_end  = o.month_end AND p.center_id  = o.center_id
LEFT JOIN centre_ce   c  ON c.month_end  = o.month_end AND c.center_id  = o.center_id
LEFT JOIN centre_disb d  ON d.month_end  = o.month_end AND d.center_id  = o.center_id
LEFT JOIN centre_od   od ON od.month_end = o.month_end AND od.center_id = o.center_id
-- Keep the pre-FY priming month: the LO engine needs it for the 1st-of-month
-- AUM and drops it from its own output.
WHERE o.month_end >= (SELECT fy_start - interval '1 month' FROM fy)
  AND (p.zero_bucket_pos IS NOT NULL
       OR c.reg_demand_count IS NOT NULL
       OR d.disb_amount IS NOT NULL
       OR od.od_emi_count IS NOT NULL)
