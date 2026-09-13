-- =============================================================================
-- Report  : MTD Current Collection Efficiency
-- PBI Page: "MTD Current collection efficiency"
-- Tables  : loan_account_il/home_loan_account
--           repayment_schedule_il/repayment_schedule
--           repayment_detail_il/repayment_detail
-- Metrics (exact DAX):
--   Demand MTD        : SUM(total_amt_due) WHERE demand_date in (prev_month_end, yesterday]
--                       AND (closure_date IS NULL OR closure_date::date >= demand_date)
--   Collection MTD    : opening_advance + sum(amount_collected this month), capped at Demand MTD
--                       Opening advance = MAX(prev_month_collected - prev_month_due, 0)
--                       [PBI splits into Opening Principal + Opening Interest]
--   Efficiency MTD%   : Collection MTD / Demand MTD
--   CE till PMSD%     : collection_till_pmsd / demand_till_pmsd
--                       PMSD period = (2 months ago end, same day last month]
--   On-time CE%       : collection where collection_date <= demand_date / MTD Demand
--   On-time CE PMSD%  : same for PMSD period
-- Slicers: Cluster, Region, Area, Branch, Product
-- =============================================================================

WITH

params AS (
    SELECT
        current_date - 1                                                     AS yesterday,
        date_trunc('month', current_date)::date                              AS curr_month_start,
        (date_trunc('month', current_date) - interval '1 day')::date         AS prev_month_end,
        date_trunc('month', current_date - interval '1 month')::date         AS prev_month_start,
        (date_trunc('month', current_date - interval '1 month')
         - interval '1 day')::date                                            AS two_months_ago_end,
        -- PMSD date: same day-number in previous month (capped at prev_month_end)
        LEAST(
            make_date(
                EXTRACT(year  FROM (date_trunc('month', current_date) - interval '1 day'))::int,
                EXTRACT(month FROM (date_trunc('month', current_date) - interval '1 day'))::int,
                EXTRACT(day   FROM (current_date - 1))::int
            ),
            (date_trunc('month', current_date) - interval '1 day')::date
        )                                                                    AS pmsd_date
),

hierarchy AS (
    SELECT
        bm.branch_id,
        bm.branch_name,
        a.area_name,
        reg.branch_name AS region_name,
        clus.area_name  AS cluster_name
    FROM public.brnch_master bm
    LEFT JOIN public.area_master  a    ON a.area_id    = bm.area_id
    LEFT JOIN public.brnch_master reg  ON reg.branch_id = a.region_id
    LEFT JOIN public.area_master  clus ON clus.area_id  = reg.area_id
    WHERE bm.active = 'Y'
      AND bm.is_region = 'N'
      AND bm.branch_name <> 'DEMO'
),

-- ─────────────────────────────────────────────────────────────────────────────
-- IL SECTION
-- ─────────────────────────────────────────────────────────────────────────────

-- MTD Demand (current month up to yesterday, closure filter)
il_mtd_demand AS (
    SELECT rs.loan_id,
        sum(rs.total_amt_due) AS demand_mtd
    FROM public.repayment_schedule_il rs
    JOIN public.loan_account_il la ON la.loan_id = rs.loan_id
    CROSS JOIN params p
    WHERE rs.demand_date::date >  p.prev_month_end
      AND rs.demand_date::date <= p.yesterday
      AND (la.closure_date IS NULL OR la.closure_date::date >= rs.demand_date)
      AND la.status NOT IN ('X', 'R')
    GROUP BY rs.loan_id
),

-- Opening advance = MAX(prev_month_total_collected - prev_month_total_due, 0)
-- PBI uses principal+interest components separately then sums — result is same
il_opening_advance AS (
    SELECT loan_id,
        greatest(
            sum(CASE WHEN demand_date::date <= (SELECT prev_month_end FROM params)
                     THEN total_amt_collected ELSE 0 END)
            - sum(CASE WHEN demand_date::date <= (SELECT prev_month_end FROM params)
                       THEN total_amt_due ELSE 0 END),
            0
        ) AS opening_advance
    FROM public.repayment_schedule_il
    GROUP BY loan_id
),

-- MTD collection from repayment_detail (current month up to yesterday)
il_mtd_collection AS (
    SELECT loan_id,
        sum(amount_collected) AS collection_raw
    FROM public.repayment_detail_il
    CROSS JOIN params p
    WHERE status = 'A'
      AND collection_date_time::date >  p.prev_month_end
      AND collection_date_time::date <= p.yesterday
    GROUP BY loan_id
),

-- On-time collection: collection_date <= yesterday (on/before demand date)
-- Same as il_mtd_collection since yesterday IS the demand reference date
-- (PBI "Collection on the same day1": collection_date <= demand_date)
il_ontime_collection AS (
    SELECT rd.loan_id,
        sum(rd.amount_collected) AS ontime_collection
    FROM public.repayment_detail_il rd
    JOIN public.loan_account_il la ON la.loan_id = rd.loan_id
    CROSS JOIN params p
    WHERE rd.status = 'A'
      AND rd.collection_date_time::date >  p.prev_month_end
      AND rd.collection_date_time::date <= p.yesterday
      -- "on or before demand date" — collection_date <= this_month_demand_date
      -- demand_date is last_demand_date, collection must be <= it (already covered above)
    GROUP BY rd.loan_id
),

-- PMSD demand: demand_date in (two_months_ago_end, pmsd_date]
il_pmsd_demand AS (
    SELECT rs.loan_id,
        sum(rs.total_amt_due) AS demand_pmsd
    FROM public.repayment_schedule_il rs
    JOIN public.loan_account_il la ON la.loan_id = rs.loan_id
    CROSS JOIN params p
    WHERE rs.demand_date::date >  p.two_months_ago_end
      AND rs.demand_date::date <= p.pmsd_date
      AND (la.closure_date IS NULL OR la.closure_date::date >= rs.demand_date)
    GROUP BY rs.loan_id
),

-- PMSD collection: collection in (two_months_ago_end, pmsd_date]
-- PBI "Collection for PMSD": same month as last month, day <= day(TODAY()-1)
il_pmsd_collection AS (
    SELECT loan_id,
        sum(amount_collected) AS collection_pmsd
    FROM public.repayment_detail_il
    CROSS JOIN params p
    WHERE status = 'A'
      AND collection_date_time::date >  p.two_months_ago_end
      AND collection_date_time::date <= p.pmsd_date
    GROUP BY loan_id
),

-- On-time PMSD: collection_date <= pmsd_date (on/before demand date in prev month)
il_pmsd_ontime AS (
    SELECT rd.loan_id,
        sum(rd.amount_collected) AS ontime_pmsd
    FROM public.repayment_detail_il rd
    CROSS JOIN params p
    WHERE rd.status = 'A'
      AND rd.collection_date_time::date >  p.two_months_ago_end
      AND rd.collection_date_time::date <= p.pmsd_date
    GROUP BY rd.loan_id
),

il_ce AS (
    SELECT
        CASE
            WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
              OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
              -- %SECURED% belongs with LAP. Omitting it put SECURED_TOP_UP loans
              -- in IEL, so this file disagreed with aum_status.sql and Excel
              -- (LAP 88 vs 91). Verified 2026-08-08: 10038007, 10039190, 10040094.
              OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
            THEN 'LAP'
            ELSE 'IEL'
        END                                    AS loan_source,
        la.loan_id,
        la.branch_id,
        la.product_id::text                         AS product_id,
        la.status                                   AS loan_status,
        coalesce(d.demand_mtd, 0)                   AS demand_mtd,
        coalesce(oa.opening_advance, 0)             AS opening_advance,
        coalesce(mc.collection_raw, 0)              AS collection_raw,
        -- Collection capped at demand (PBI: IF(c >= demand, demand, c))
        least(
            coalesce(mc.collection_raw, 0) + coalesce(oa.opening_advance, 0),
            coalesce(d.demand_mtd, 0)
        )                                           AS collection_mtd,
        coalesce(oc.ontime_collection, 0)           AS ontime_collection,
        coalesce(pd.demand_pmsd, 0)                 AS demand_pmsd,
        coalesce(pc.collection_pmsd, 0)             AS collection_pmsd,
        coalesce(po.ontime_pmsd, 0)                 AS ontime_pmsd
    FROM public.loan_account_il la
    LEFT JOIN il_mtd_demand       d   ON d.loan_id   = la.loan_id
    LEFT JOIN il_opening_advance  oa  ON oa.loan_id  = la.loan_id
    LEFT JOIN il_mtd_collection   mc  ON mc.loan_id  = la.loan_id
    LEFT JOIN il_ontime_collection oc ON oc.loan_id  = la.loan_id
    LEFT JOIN il_pmsd_demand      pd  ON pd.loan_id  = la.loan_id
    LEFT JOIN il_pmsd_collection  pc  ON pc.loan_id  = la.loan_id
    LEFT JOIN il_pmsd_ontime      po  ON po.loan_id  = la.loan_id
    WHERE la.status NOT IN ('X', 'R')
      AND (la.status != 'W' OR la.principal_outstanding > 0)
      AND (d.demand_mtd IS NOT NULL OR pd.demand_pmsd IS NOT NULL)
),

-- ─────────────────────────────────────────────────────────────────────────────
-- JLG SECTION (home_loan_account, repayment_schedule, repayment_detail)
-- ─────────────────────────────────────────────────────────────────────────────
jlg_mtd_demand AS (
    SELECT rs.loan_id,
        sum(rs.total_amt_due) AS demand_mtd
    FROM public.repayment_schedule rs
    JOIN public.home_loan_account la ON la.loan_id = rs.loan_id
    CROSS JOIN params p
    WHERE rs.demand_date::date >  p.prev_month_end
      AND rs.demand_date::date <= p.yesterday
      AND (la.closure_date IS NULL OR la.closure_date::date >= rs.demand_date)
      AND la.status NOT IN ('X', 'R')
    GROUP BY rs.loan_id
),

jlg_opening_advance AS (
    SELECT loan_id,
        greatest(
            sum(CASE WHEN demand_date::date <= (SELECT prev_month_end FROM params)
                     THEN total_amt_collected ELSE 0 END)
            - sum(CASE WHEN demand_date::date <= (SELECT prev_month_end FROM params)
                       THEN total_amt_due ELSE 0 END),
            0
        ) AS opening_advance
    FROM public.repayment_schedule
    GROUP BY loan_id
),

jlg_mtd_collection AS (
    SELECT loan_id,
        sum(amount_collected) AS collection_raw
    FROM public.repayment_detail
    CROSS JOIN params p
    WHERE status = 'A'
      AND collection_date_time::date >  p.prev_month_end
      AND collection_date_time::date <= p.yesterday
    GROUP BY loan_id
),

jlg_ontime_collection AS (
    SELECT loan_id,
        sum(amount_collected) AS ontime_collection
    FROM public.repayment_detail
    CROSS JOIN params p
    WHERE status = 'A'
      AND collection_date_time::date >  p.prev_month_end
      AND collection_date_time::date <= p.yesterday
    GROUP BY loan_id
),

jlg_pmsd_demand AS (
    SELECT rs.loan_id,
        sum(rs.total_amt_due) AS demand_pmsd
    FROM public.repayment_schedule rs
    JOIN public.home_loan_account la ON la.loan_id = rs.loan_id
    CROSS JOIN params p
    WHERE rs.demand_date::date >  p.two_months_ago_end
      AND rs.demand_date::date <= p.pmsd_date
      AND (la.closure_date IS NULL OR la.closure_date::date >= rs.demand_date)
    GROUP BY rs.loan_id
),

jlg_pmsd_collection AS (
    SELECT loan_id,
        sum(amount_collected) AS collection_pmsd
    FROM public.repayment_detail
    CROSS JOIN params p
    WHERE status = 'A'
      AND collection_date_time::date >  p.two_months_ago_end
      AND collection_date_time::date <= p.pmsd_date
    GROUP BY loan_id
),

jlg_pmsd_ontime AS (
    SELECT loan_id,
        sum(amount_collected) AS ontime_pmsd
    FROM public.repayment_detail
    CROSS JOIN params p
    WHERE status = 'A'
      AND collection_date_time::date >  p.two_months_ago_end
      AND collection_date_time::date <= p.pmsd_date
    GROUP BY loan_id
),

jlg_ce AS (
    SELECT
        'JLG'                                       AS loan_source,
        la.loan_id,
        cm.branch_id,
        la.product_id::text                         AS product_id,
        la.status                                   AS loan_status,
        coalesce(d.demand_mtd, 0)                   AS demand_mtd,
        coalesce(oa.opening_advance, 0)             AS opening_advance,
        coalesce(mc.collection_raw, 0)              AS collection_raw,
        least(
            coalesce(mc.collection_raw, 0) + coalesce(oa.opening_advance, 0),
            coalesce(d.demand_mtd, 0)
        )                                           AS collection_mtd,
        coalesce(oc.ontime_collection, 0)           AS ontime_collection,
        coalesce(pd.demand_pmsd, 0)                 AS demand_pmsd,
        coalesce(pc.collection_pmsd, 0)             AS collection_pmsd,
        coalesce(po.ontime_pmsd, 0)                 AS ontime_pmsd
    FROM public.home_loan_account la
    JOIN public.home_center_master cm ON cm.center_id = la.center_id
    LEFT JOIN jlg_mtd_demand        d   ON d.loan_id   = la.loan_id
    LEFT JOIN jlg_opening_advance   oa  ON oa.loan_id  = la.loan_id
    LEFT JOIN jlg_mtd_collection    mc  ON mc.loan_id  = la.loan_id
    LEFT JOIN jlg_ontime_collection oc  ON oc.loan_id  = la.loan_id
    LEFT JOIN jlg_pmsd_demand       pd  ON pd.loan_id  = la.loan_id
    LEFT JOIN jlg_pmsd_collection   pc  ON pc.loan_id  = la.loan_id
    LEFT JOIN jlg_pmsd_ontime       po  ON po.loan_id  = la.loan_id
    WHERE la.status NOT IN ('X', 'R')
      AND (la.status != 'W' OR la.prin_os > 0)
      AND NOT EXISTS (
          SELECT 1 FROM public.loan_account_il il
          WHERE il.loan_id           = la.loan_id
            AND il.status            IN ('A','D','I','W')
            AND il.disbursement_date > la.disbursement_date
      )
      AND (d.demand_mtd IS NOT NULL OR pd.demand_pmsd IS NOT NULL)
),

all_ce AS (
    SELECT * FROM il_ce
    UNION ALL
    SELECT * FROM jlg_ce
)

SELECT
    ac.loan_source,
    ac.loan_status,
    coalesce(h.cluster_name, 'Unassigned') AS cluster_name,
    coalesce(h.region_name,  'Unassigned') AS region_name,
    coalesce(h.area_name,    'Unassigned') AS area_name,
    coalesce(h.branch_name,  'Unassigned') AS branch_name,
    ac.branch_id,
    ac.product_id,

    count(DISTINCT ac.loan_id)                                          AS total_loans,

    -- MTD Demand & Collection
    round(sum(ac.demand_mtd)::numeric,     2)                           AS demand_mtd,
    round(sum(ac.collection_mtd)::numeric, 2)                           AS collection_mtd,
    round(sum(ac.opening_advance)::numeric, 2)                          AS opening_advance,

    -- Efficiency MTD%
    CASE WHEN sum(ac.demand_mtd) = 0 THEN NULL
         ELSE round((sum(ac.collection_mtd)*100.0
                    /sum(ac.demand_mtd))::numeric, 2)
    END                                                                  AS efficiency_mtd_pct,

    -- On-time CE% (collection on/before demand date / MTD demand)
    round(sum(ac.ontime_collection)::numeric, 2)                        AS ontime_collection,
    CASE WHEN sum(ac.demand_mtd) = 0 THEN NULL
         ELSE round((sum(ac.ontime_collection)*100.0
                    /sum(ac.demand_mtd))::numeric, 2)
    END                                                                  AS ontime_ce_pct,

    -- CE till PMSD%
    round(sum(ac.demand_pmsd)::numeric,     2)                          AS demand_pmsd,
    round(sum(ac.collection_pmsd)::numeric, 2)                          AS collection_pmsd,
    CASE WHEN sum(ac.demand_pmsd) = 0 THEN NULL
         ELSE round((
             least(sum(ac.collection_pmsd), sum(ac.demand_pmsd))*100.0
             /sum(ac.demand_pmsd))::numeric, 2)
    END                                                                  AS ce_pmsd_pct,

    -- On-time CE PMSD%
    round(sum(ac.ontime_pmsd)::numeric, 2)                              AS ontime_pmsd,
    CASE WHEN sum(ac.demand_pmsd) = 0 THEN NULL
         ELSE round((
             least(sum(ac.ontime_pmsd), sum(ac.demand_pmsd))*100.0
             /sum(ac.demand_pmsd))::numeric, 2)
    END                                                                  AS ontime_ce_pmsd_pct,

    (SELECT yesterday  FROM params)                                      AS report_date,
    (SELECT pmsd_date  FROM params)                                      AS pmsd_date

FROM all_ce ac
LEFT JOIN hierarchy h ON h.branch_id = ac.branch_id
GROUP BY
    ac.loan_source, ac.loan_status, h.cluster_name, h.region_name, h.area_name, h.branch_name,
    ac.branch_id, ac.product_id
ORDER BY
    ac.loan_source, ac.loan_status, h.cluster_name, h.region_name, h.area_name, h.branch_name;
