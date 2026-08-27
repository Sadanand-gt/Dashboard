-- =============================================================================
-- Daily BRE / bureau decisions  ->  rpt_bre_daily        [runs against cb_engine]
--
-- JLG ONLY. IL borrowers are absent from cb_engine — 7 candidate join keys were
-- tested during the JLG Leverage Cuts work and 1 of 3,608 IL customers matched.
-- Anything built on this table must say JLG; it is not a firm-wide bureau figure.
--
-- Grain: pull date x branch x decision. One row per combination.
--
-- BOTH engine tables are unioned. They are DISJOINT IN TIME —
--   engine_output_master_v2         2025-01-24 onward
--   engine_output_master_v2_backup  2023-06-08 .. 2025-01-23
-- and only 384 references overlap, so reading v2 alone loses all earlier history.
--
-- DATE = "CREATION DATE", never DateOfIssue. DateOfIssue is corrupt on a subset:
-- it carries future dates (to 2026-12-08) and dates outside the backup table's own
-- life, with a gap to CREATION DATE of -324..+342 days (day/month swaps).
--
-- DECISION = "FINAL RECOMMENDATION" — the engine's own outcome, three values:
-- Approved / Rejected / Referred. This is the BRE stage ONLY. It is not the CGT,
-- GRT/PD or sanction decision, and its counts must not be merged with theirs.
--
-- Bounded to the last 120 days: this feeds daily and month-to-date cards, and the
-- unbounded union is ~797k rows for no benefit.
-- =============================================================================
WITH eng AS (
    SELECT "CREATION DATE"::date        AS pull_date,
           "FINAL RECOMMENDATION"       AS decision,
           btrim("BRANCH")              AS cb_branch
    FROM public.engine_output_master_v2
    WHERE "CREATION DATE"::date >= current_date - 120
    UNION ALL
    SELECT "CREATION DATE"::date, "FINAL RECOMMENDATION", btrim("BRANCH")
    FROM public.engine_output_master_v2_backup
    WHERE "CREATION DATE"::date >= current_date - 120
)
SELECT pull_date,
       coalesce(nullif(btrim(decision), ''), 'Unknown') AS decision,
       coalesce(nullif(cb_branch, ''), 'Unassigned')    AS cb_branch,
       count(*)                                         AS pulls
FROM eng
WHERE pull_date IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2;
