-- =============================================================================
-- Report  : Monthly Trend Metrics — IL only (last 13 completed months)
-- Split from trend_monthly.sql to avoid RDS hot-standby conflict.
-- Combined with trend_monthly_jlg.sql in runner.py → rpt_trend_monthly
-- Outputs : one row per month:
--           demand, collection, disb_count, disb_amount,
--           total_loans, total_pos, par0/30/90 count+pos
-- =============================================================================

WITH

-- Window: April of the PREVIOUS fiscal year → last completed month, so every
-- FY in the trend starts at April (Indian FY) and FY-1 is complete for YoY.
months AS (
    SELECT
        gs::date                                             AS m_start,
        (gs + interval '1 month' - interval '1 day')::date   AS m_end,
        to_char(gs, 'YYYY-MM')                               AS m_key,
        to_char(gs, 'Mon-YY')                                AS m_label,
        (extract(year  FROM age(date_trunc('month', current_date), gs)) * 12
       + extract(month FROM age(date_trunc('month', current_date), gs)))::int AS m_offset
    FROM generate_series(
        CASE WHEN extract(month FROM current_date) >= 4
             THEN make_date(extract(year FROM current_date)::int - 1, 4, 1)
             ELSE make_date(extract(year FROM current_date)::int - 2, 4, 1) END,
        (date_trunc('month', current_date) - interval '1 month')::date,
        interval '1 month'
    ) AS gs
),

-- Pre-filter: IL loans active at any point in our 13-month window.
-- Dramatically reduces rows in schedule and collection CTEs.
il_active AS (
    SELECT loan_id
    FROM public.loan_account_il
    WHERE status IN ('A', 'D', 'I', 'W')
      AND disbursement_date::date <= (SELECT max(m_end) FROM months)
      -- W kept past closure: written-off loans stay in the book at frozen POS
      AND (status = 'W' OR closure_date IS NULL
           OR closure_date::date >= (SELECT min(m_start) FROM months))
),

-- ── Collection Efficiency ─────────────────────────────────────────────────────
il_ce AS (
    SELECT
        to_char(rs.demand_date, 'YYYY-MM')                                  AS m_key,
        sum(rs.total_amt_due)                                               AS demand,
        coalesce(sum(rd.amount_collected) FILTER (WHERE rd.status = 'A'), 0) AS collection
    FROM public.repayment_schedule_il rs
    JOIN il_active a ON a.loan_id = rs.loan_id
    LEFT JOIN public.repayment_detail_il rd
        ON rd.loan_id = rs.loan_id
        AND to_char(rd.collection_date_time::date, 'YYYY-MM')
            = to_char(rs.demand_date, 'YYYY-MM')
    WHERE rs.demand_date >= (SELECT min(m_start) FROM months)
      AND rs.demand_date <= (SELECT max(m_end)   FROM months)
    GROUP BY to_char(rs.demand_date, 'YYYY-MM')
),

-- ── Disbursements ─────────────────────────────────────────────────────────────
il_disb AS (
    SELECT
        to_char(la.disbursement_date, 'YYYY-MM') AS m_key,
        count(la.loan_id)                         AS disb_count,
        sum(la.total_loan_amount)                 AS disb_amount
    FROM public.loan_account_il la
    WHERE la.disbursement_date >= (SELECT min(m_start) FROM months)
      AND la.disbursement_date <= (SELECT max(m_end)   FROM months)
      AND la.product_id NOT ILIKE '%TOPUP%'
      AND la.status != 'V'
    GROUP BY to_char(la.disbursement_date, 'YYYY-MM')
),

-- ── PAR — Step 1: monthly collection buckets (active loans only) ──────────────
il_coll_mon AS (
    SELECT
        loan_id,
        date_trunc('month', collection_date_time::date)::date AS coll_month,
        sum(principal_collected)                              AS pc
    FROM public.repayment_detail_il
    WHERE status IN ('A', 'V')
      AND loan_id IN (SELECT loan_id FROM il_active)
    GROUP BY loan_id, date_trunc('month', collection_date_time::date)::date
),

-- ── PAR — Step 2: cumulative collections per loan up to each month-end ────────
il_cum_coll AS (
    SELECT m.m_key, c.loan_id, sum(c.pc) AS cum_pc
    FROM months m
    JOIN il_coll_mon c ON c.coll_month <= m.m_end
    GROUP BY m.m_key, c.loan_id
),

-- ── PAR — Step 3: cumulative due at m_end / m_end-30 / m_end-90 ──────────────
-- Bounded to active loans; explicit upper bound helps planner use index on demand_date.
il_cum_due AS (
    SELECT
        m.m_key,
        rs.loan_id,
        max(rs.cumulative_principal_due)
            FILTER (WHERE rs.demand_date::date <= m.m_end)        AS cum_due_0,
        max(rs.cumulative_principal_due)
            FILTER (WHERE rs.demand_date::date <= m.m_end - 30)   AS cum_due_30,
        max(rs.cumulative_principal_due)
            FILTER (WHERE rs.demand_date::date <= m.m_end - 90)   AS cum_due_90
    FROM months m
    JOIN public.repayment_schedule_il rs
        ON rs.demand_date::date <= m.m_end
    JOIN il_active a ON a.loan_id = rs.loan_id
    GROUP BY m.m_key, rs.loan_id
),

-- ── PAR — Step 4: per-loan PAR flag per month ─────────────────────────────────
-- Driven from loan_account (not the schedule join) so freshly-disbursed loans
-- with no matured demand yet still count in the book (matches headline AUM).
il_loan_par AS (
    SELECT
        m.m_key,
        la.loan_id,
        la.principal_outstanding                                              AS pos,
        CASE WHEN coalesce(d.cum_due_0, 0)  > coalesce(c.cum_pc, 0) THEN 1 ELSE 0 END AS par0,
        CASE WHEN coalesce(d.cum_due_30, 0) > coalesce(c.cum_pc, 0) THEN 1 ELSE 0 END AS par30,
        CASE WHEN coalesce(d.cum_due_90, 0) > coalesce(c.cum_pc, 0) THEN 1 ELSE 0 END AS par90
    FROM public.loan_account_il la
    JOIN il_active a ON a.loan_id = la.loan_id
    CROSS JOIN months m
    LEFT JOIN il_cum_due  d ON d.m_key = m.m_key AND d.loan_id = la.loan_id
    LEFT JOIN il_cum_coll c ON c.m_key = m.m_key AND c.loan_id = la.loan_id
    WHERE la.disbursement_date::date <= m.m_end
      AND la.status IN ('A', 'D', 'I', 'W')
      AND (la.status = 'W' OR la.closure_date IS NULL
           OR la.closure_date::date > m.m_start)
),

il_par_agg AS (
    SELECT
        m_key,
        count(loan_id)      AS total_loans,
        sum(pos)            AS total_pos,
        sum(par0)           AS par0_count,
        sum(par0 * pos)     AS par0_pos,
        sum(par30)          AS par30_count,
        sum(par30 * pos)    AS par30_pos,
        sum(par90)          AS par90_count,
        sum(par90 * pos)    AS par90_pos
    FROM il_loan_par
    GROUP BY m_key
)

SELECT
    m.m_key,
    m.m_label,
    m.m_offset,
    coalesce(ce.demand,        0)   AS demand,
    coalesce(ce.collection,    0)   AS collection,
    coalesce(d.disb_count,     0)   AS disb_count,
    round(coalesce(d.disb_amount, 0)::numeric, 2)  AS disb_amount,
    coalesce(p.total_loans,    0)   AS total_loans,
    round(coalesce(p.total_pos, 0)::numeric, 2)    AS total_pos,
    coalesce(p.par0_count,     0)   AS par0_count,
    round(coalesce(p.par0_pos,  0)::numeric, 2)    AS par0_pos,
    coalesce(p.par30_count,    0)   AS par30_count,
    round(coalesce(p.par30_pos, 0)::numeric, 2)    AS par30_pos,
    coalesce(p.par90_count,    0)   AS par90_count,
    round(coalesce(p.par90_pos, 0)::numeric, 2)    AS par90_pos
FROM months m
LEFT JOIN il_ce      ce ON ce.m_key = m.m_key
LEFT JOIN il_disb    d  ON d.m_key  = m.m_key
LEFT JOIN il_par_agg p  ON p.m_key  = m.m_key
ORDER BY m.m_key ASC;
