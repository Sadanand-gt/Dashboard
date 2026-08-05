-- =============================================================================
-- Report  : Monthly Trend Metrics — JLG only (last 13 completed months)
-- Split from trend_monthly.sql to avoid RDS hot-standby conflict.
-- Combined with trend_monthly_il.sql in runner.py → rpt_trend_monthly
-- FIX: repayment_detail (JLG) uses collection_date (date), NOT collection_date_time.
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

-- Pre-filter: JLG loans active at any point in our 13-month window.
jlg_active AS (
    SELECT loan_id
    FROM public.home_loan_account
    WHERE status IN ('A', 'D', 'I', 'W')
      AND loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND disbursement_date::date <= (SELECT max(m_end) FROM months)
      -- W kept past closure: written-off loans stay in the book at frozen POS
      AND (status = 'W' OR closure_date IS NULL
           OR closure_date::date >= (SELECT min(m_start) FROM months))
      AND (status != 'W' OR prin_os > 0)
),

-- ── Collection Efficiency ─────────────────────────────────────────────────────
-- NOTE: repayment_detail (JLG) has collection_date (date), not collection_date_time.
jlg_ce AS (
    SELECT
        to_char(rs.demand_date, 'YYYY-MM')                                  AS m_key,
        sum(rs.total_amt_due)                                               AS demand,
        coalesce(sum(rd.amount_collected) FILTER (WHERE rd.status = 'A'), 0) AS collection
    FROM public.repayment_schedule rs
    JOIN jlg_active a ON a.loan_id = rs.loan_id
    LEFT JOIN public.repayment_detail rd
        ON rd.loan_id = rs.loan_id
        AND to_char(rd.collection_date, 'YYYY-MM')
            = to_char(rs.demand_date, 'YYYY-MM')
    WHERE rs.demand_date >= (SELECT min(m_start) FROM months)
      AND rs.demand_date <= (SELECT max(m_end)   FROM months)
    GROUP BY to_char(rs.demand_date, 'YYYY-MM')
),

-- ── Disbursements ─────────────────────────────────────────────────────────────
jlg_disb AS (
    SELECT
        to_char(la.disbursement_date, 'YYYY-MM') AS m_key,
        count(la.loan_id)                         AS disb_count,
        sum(la.total_loan_amount)                 AS disb_amount
    FROM public.home_loan_account la
    -- ::date: disbursement_date is a TIMESTAMP (IL carries a real time-of-day)
    -- and the month bounds are DATEs; uncast, a loan disbursed at 17:14 on the
    -- window's last day falls outside it.
    WHERE la.disbursement_date::date >= (SELECT min(m_start) FROM months)
      AND la.disbursement_date::date <= (SELECT max(m_end)   FROM months)
      AND la.loan_id >= 10000000                 -- drop junk/test ids (e.g. 1111111)
      AND la.product_id NOT ILIKE '%TOPUP%'
      AND la.status != 'V'
    GROUP BY to_char(la.disbursement_date, 'YYYY-MM')
),

-- ── PAR — Step 1: monthly collection buckets (active loans only) ──────────────
-- NOTE: repayment_detail (JLG) uses collection_date (date column).
jlg_coll_mon AS (
    SELECT
        loan_id,
        date_trunc('month', collection_date)::date  AS coll_month,
        sum(principal_collected)                     AS pc
    FROM public.repayment_detail
    WHERE status IN ('A', 'V')
      AND loan_id IN (SELECT loan_id FROM jlg_active)
    GROUP BY loan_id, date_trunc('month', collection_date)::date
),

-- ── PAR — Step 2: cumulative collections per loan up to each month-end ────────
jlg_cum_coll AS (
    SELECT m.m_key, c.loan_id, sum(c.pc) AS cum_pc
    FROM months m
    JOIN jlg_coll_mon c ON c.coll_month <= m.m_end
    GROUP BY m.m_key, c.loan_id
),

-- ── PAR — Step 3: cumulative due at m_end / m_end-30 / m_end-90 ──────────────
jlg_cum_due AS (
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
    JOIN public.repayment_schedule rs
        ON rs.demand_date::date <= m.m_end
    JOIN jlg_active a ON a.loan_id = rs.loan_id
    GROUP BY m.m_key, rs.loan_id
),

-- ── PAR — Step 4: per-loan PAR flag per month ─────────────────────────────────
-- Driven from loan_account (not the schedule join) so freshly-disbursed loans
-- with no matured demand yet still count in the book (matches headline AUM).
jlg_loan_par AS (
    SELECT
        m.m_key,
        la.loan_id,
        la.prin_os                                                           AS pos,
        CASE WHEN coalesce(d.cum_due_0, 0)  > coalesce(c.cum_pc, 0) THEN 1 ELSE 0 END AS par0,
        CASE WHEN coalesce(d.cum_due_30, 0) > coalesce(c.cum_pc, 0) THEN 1 ELSE 0 END AS par30,
        CASE WHEN coalesce(d.cum_due_90, 0) > coalesce(c.cum_pc, 0) THEN 1 ELSE 0 END AS par90
    FROM public.home_loan_account la
    JOIN jlg_active a ON a.loan_id = la.loan_id
    CROSS JOIN months m
    LEFT JOIN jlg_cum_due  d ON d.m_key = m.m_key AND d.loan_id = la.loan_id
    LEFT JOIN jlg_cum_coll c ON c.m_key = m.m_key AND c.loan_id = la.loan_id
    WHERE la.disbursement_date::date <= m.m_end
      AND la.status IN ('A', 'D', 'I', 'W')
      AND (la.status = 'W' OR la.closure_date IS NULL
           OR la.closure_date::date > m.m_start)
      AND (la.status != 'W' OR la.prin_os > 0)
),

jlg_par_agg AS (
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
    FROM jlg_loan_par
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
LEFT JOIN jlg_ce      ce ON ce.m_key = m.m_key
LEFT JOIN jlg_disb    d  ON d.m_key  = m.m_key
LEFT JOIN jlg_par_agg p  ON p.m_key  = m.m_key
ORDER BY m.m_key ASC;
