"""
runner.py — Pipeline orchestrator.

Runs SQL files against PostgreSQL and stores results in SQLite (reports.db).
All business logic lives in SQL. Python only orchestrates and stores.

Usage:
    python -m pipeline.runner                        # run all reports
    python -m pipeline.runner --report pos_par       # run one report only
    python -m pipeline.runner --report aum_status
    python -m pipeline.runner --report daily_collection
    python -m pipeline.runner --report mtd_collection
    python -m pipeline.runner --report disbursement
    python -m pipeline.runner --report writeoff
"""

import sys
import os
import logging
import argparse
from datetime import datetime
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.db import run_sql_file, run_query
from pipeline.sqlite_writer import write_report, write_pipeline_log, archive_report
from pipeline.load_writeoff_master import get_writeoff_ids, writeoff_values_literal, writeoff_triples_literal

# Reports whose SQL needs the write-off master ids injected (placeholder {wo_ids}).
WRITEOFF_AWARE = {"aum_status", "collection_fact", "od_list", "od_slippage", "dq_category", "writeoff",
                  "aum_live", "delinquencies", "pos_par", "cashless_collection"}  # {wo_ids}/{wo_pairs} override; writeoff uses {wo_triples} (master-based)

# ── Logging ───────────────────────────────────────────────────────────────────
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)

fh = logging.FileHandler(
    os.path.join(LOG_DIR, "pipeline.log"), encoding="utf-8"
)
fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
log.addHandler(fh)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass

sh = logging.StreamHandler(sys.stdout)
sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
log.addHandler(sh)


# ── Report Registry ───────────────────────────────────────────────────────────
# Each tuple: (report_key, sql_file, sqlite_table_name)
REPORTS = [
    # Core portfolio snapshot — EOM + LIVE + PAR buckets
    ("pos_par",           "pos_par.sql",           "rpt_pos_par"),

    # Current AUM with DPD buckets + business segment (our PBI-aligned version)
    ("aum_status",        "aum_status.sql",        "rpt_aum_status"),

    # Live AUM — reads core-banking dpd column directly (branch × product grain)
    ("aum_live",          "aum_live.sql",          "rpt_aum_live"),

    # Disbursement — previous month (full) + current month MTD
    ("disbursement",      "disbursement.sql",      "rpt_disbursement"),

    # Collection fact — feeds BOTH T-1 Collection & MTD Collection pages
    # (per-dimension demand/collection/on-time/FTOD, full AP + risk dims)
    ("collection_fact",   "collection_fact.sql",   "rpt_collection"),

    # Daily disbursement history — feeds the Disbursement trend "Day" view
    ("disb_daily",        "disb_daily.sql",        "rpt_disb_daily"),

    # OD List — loan-level detail of OD-relevant loans (feeds the OD List page)
    ("od_list",           "od_list.sql",           "rpt_od_list"),

    # OD Slippage — current OD-slippage loans + previous-slippage (12M) count
    ("od_slippage",       "od_slippage.sql",       "rpt_od_slippage"),

    # DQ Category — Early/Infant delinquency (eligible/count/POS by dimension)
    ("dq_category",       "dq_category.sql",       "rpt_dq_category"),

    # Daily collection efficiency — prev month + current month, day by day
    ("daily_collection",  "daily_collection.sql",  "rpt_daily_collection"),

    # MTD collection efficiency — with opening advance logic
    ("mtd_collection",    "collection_eff.sql",    "rpt_mtd_collection"),

    # Cashless / digital collection mix
    ("cashless_collection", "cashless_collection.sql", "rpt_cashless_collection"),

    # Delinquencies — PAR tracking, OD borrower movement, fresh slippage
    ("delinquencies",     "delinquencies.sql",     "rpt_delinquencies"),

    # Case movement — origination funnel (T-1 + MTD), CB approval ratios
    ("case_movement",     "case_movement.sql",     "rpt_case_movement"),

    # Write-off portfolio — written-off loans + post-WO recovery
    ("writeoff",          "writeoff.sql",          "rpt_writeoff"),

    # AML Risk Category — active-book compliance monitoring (borrower AML risk,
    # PEP / work-abroad / LUC flags) with full hierarchy + segment dims
    ("aml",               "aml_risk.sql",          "rpt_aml"),
    ("ots",               "ots.sql",               "rpt_ots"),
]

# Split reports — IL and JLG run as separate DB calls, combined in Python.
BUCKET_MOVEMENT_FILES = ["bucket_movement_il.sql", "bucket_movement_jlg.sql"]
TREND_MONTHLY_FILES   = ["trend_monthly_il.sql", "trend_monthly_jlg.sql"]

# Reports that get a "<lo_id> - <NAME>" display column mapped in after the SQL.
# Deliberately NOT a SQL join: home_employee_master is tiny (4,689 rows) but
# joining it inside aum_status.sql makes the planner assume a 23x fan-out on top
# of its 70M grouped-row estimate (actual ~40k) and total cost goes 150M -> 5,192M.
LO_NAME_REPORTS = {"aum_status", "aml"}


def _add_lo_name(df):
    """Map lo_id -> "<lo_id> - <NAME>" into a new lo_name column.

    Falls back to the bare id when an officer is absent from the employee master
    (currently none — IL 81/81 and JLG 500/500 ids resolve).
    """
    if df is None or df.empty or "lo_id" not in df.columns:
        return df
    names = run_query(
        "SELECT employee_id::text AS lo_id, btrim(employee_name) AS nm "
        "FROM public.home_employee_master WHERE employee_id IS NOT NULL"
    )
    lookup = dict(zip(names["lo_id"], names["nm"]))
    ids = df["lo_id"].astype(str)
    df["lo_name"] = [
        f"{i} - {lookup[i]}" if i in lookup and lookup[i] else i for i in ids
    ]
    matched = sum(1 for i in ids.unique() if i in lookup)
    log.info(f"    lo_name: {matched}/{ids.nunique()} officer ids resolved")
    return df


# ── Runner ────────────────────────────────────────────────────────────────────
def run_report(report_key: str, sql_file: str, table_name: str) -> bool:
    log.info(f"[START] {report_key}")
    try:
        subs = None
        if report_key in WRITEOFF_AWARE:
            ids = get_writeoff_ids()
            subs = {"wo_ids": ",".join(str(i) for i in ids),
                    "wo_pairs": writeoff_values_literal(),
                    "wo_triples": writeoff_triples_literal()}
            log.info(f"    injecting {len(ids)} write-off ids from writeoff_master")
        df = run_sql_file(sql_file, subs=subs)
        if report_key in LO_NAME_REPORTS:
            df = _add_lo_name(df)
        write_report(df, table_name, mode="replace")
        archive_report(df, table_name)          # retain a dated copy → <table>_hist
        write_pipeline_log(report_key, "SUCCESS")
        log.info(f"[OK]    {report_key} → {table_name} ({len(df)} rows)")
        return True
    except FileNotFoundError:
        msg = f"SQL file not found: {sql_file} — skipping"
        log.warning(f"[SKIP]  {msg}")
        write_pipeline_log(report_key, "SKIPPED", msg)
        return False
    except Exception as e:
        log.error(f"[FAIL]  {report_key} — {e}")
        write_pipeline_log(report_key, "FAILED", str(e))
        return False


def run_credit_bureau() -> bool:
    """Credit Bureau & Sourcing — the ONLY report sourced from a different
    DATABASE (cb_engine), so it cannot use run_sql_file / the core engine.

    The bureau facts are keyed by branch NAME while the hierarchy lives in the
    core DB; Postgres cannot join across databases, so the merge happens here in
    pandas. Branches the bureau reports but the core master does not carry
    (partner branches, Corporate Office, closed branches — ~6% of pulls) resolve
    to 'Unassigned', matching every other report's convention.
    """
    key, table = "credit_bureau", "rpt_credit_bureau"
    log.info(f"[START] {key}")
    try:
        import os
        from sqlalchemy import text as _sql_text
        from pipeline.db import get_cb_engine, _get_engine, QUERY_DIR

        sql = open(os.path.join(QUERY_DIR, "credit_bureau.sql"), encoding="utf-8").read()
        with get_cb_engine().connect() as conn:
            df = pd.read_sql(_sql_text(sql), conn)
        log.info(f"    cb_engine returned {len(df)} rows")
        if df.empty:
            raise RuntimeError("credit_bureau produced no rows — refusing to write")

        with _get_engine().connect() as conn:
            hier = pd.read_sql(_sql_text("""
                SELECT bm.branch_id, bm.branch_name, a.area_name,
                       reg.branch_name AS region_name, clus.area_name AS cluster_name,
                       z.area_name AS zone_name, bm.state_id, bm.district_id
                FROM public.brnch_master bm
                LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
                LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
                LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
                LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id
                WHERE bm.active = 'Y' AND bm.is_region = 'N'
                  AND bm.branch_name <> 'DEMO' AND bm.closing_date IS NULL
            """), conn)

        # Case/space-insensitive name match — the two systems disagree on casing.
        df["_k"] = df["cb_branch"].astype(str).str.strip().str.upper()
        hier["_k"] = hier["branch_name"].astype(str).str.strip().str.upper()
        merged = df.merge(hier.drop_duplicates("_k"), on="_k", how="left").drop(columns=["_k"])

        matched = merged["branch_id"].notna().sum()
        log.info(f"    branch match: {matched}/{len(merged)} rows "
                 f"({100 * matched / max(len(merged), 1):.1f}%)")

        merged["branch_name"] = merged["branch_name"].fillna(merged["cb_branch"])
        for c in ["zone_name", "cluster_name", "region_name", "area_name"]:
            merged[c] = merged[c].fillna("Unassigned")
        merged["branch_id"] = merged["branch_id"].fillna("N/A")
        for c in ["state_id", "district_id"]:
            merged[c] = merged[c].astype("object").where(merged[c].notna(), "N/A").astype(str)

        write_report(merged, table, mode="replace")
        archive_report(merged, table)
        write_pipeline_log(key, "SUCCESS")
        log.info(f"[OK]    {key} → {table} ({len(merged)} rows)")
        return True
    except Exception as e:
        log.error(f"[FAIL]  {key} — {e}")
        write_pipeline_log(key, "FAILED", str(e))
        return False


# ── Split reports (IL + JLG run separately, combined in Python) ────────────────
def run_bucket_movement() -> bool:
    """Bucket movement — run IL + JLG queries and stack the rows."""
    key, table = "bucket_movement", "rpt_bucket_movement"
    log.info(f"[START] {key} (IL + JLG)")
    try:
        parts = [run_sql_file(f) for f in BUCKET_MOVEMENT_FILES]
        combined = pd.concat(parts, ignore_index=True)
        write_report(combined, table, mode="replace")
        archive_report(combined, table)         # retain a dated copy → <table>_hist
        write_pipeline_log(key, "SUCCESS")
        log.info(f"[OK]    {key} → {table} ({len(combined)} rows)")
        return True
    except Exception as e:
        log.error(f"[FAIL]  {key} — {e}")
        write_pipeline_log(key, "FAILED", str(e))
        return False


def run_trend_monthly() -> bool:
    """Trend monthly — run IL + JLG, sum numeric columns per month, derive ratios."""
    key, table = "trend_monthly", "rpt_trend_monthly"
    log.info(f"[START] {key} (IL + JLG)")
    try:
        il  = run_sql_file("trend_monthly_il.sql").set_index("m_key")
        jlg = run_sql_file("trend_monthly_jlg.sql").set_index("m_key")
        num_cols = [
            "demand", "collection", "disb_count", "disb_amount",
            "total_loans", "total_pos", "par0_count", "par0_pos",
            "par30_count", "par30_pos", "par90_count", "par90_pos",
        ]
        combined = il[["m_label", "m_offset"]].copy()
        for col in num_cols:
            combined[col] = il[col].fillna(0) + jlg[col].fillna(0)
        combined["ce_pct"] = combined.apply(
            lambda r: round(min(r["collection"], r["demand"]) * 100.0 / r["demand"], 2)
            if r["demand"] > 0 else 0.0, axis=1)
        for n in (0, 30, 90):
            combined[f"par{n}_pct"] = combined.apply(
                lambda r: round(r[f"par{n}_pos"] / r["total_pos"] * 100, 2)
                if r["total_pos"] else 0.0, axis=1)
        combined = combined.reset_index()
        write_report(combined, table, mode="replace")
        write_pipeline_log(key, "SUCCESS")
        log.info(f"[OK]    {key} → {table} ({len(combined)} rows)")
        return True
    except Exception as e:
        log.error(f"[FAIL]  {key} — {e}")
        write_pipeline_log(key, "FAILED", str(e))
        return False


# The JLG trend is CHUNKED by loan_id to survive the replica's cancellation
# window. Run whole, it is one ~2-min query on a single connection and the replica
# drops it under load ("SSL connection has been closed unexpectedly") — an error
# that (before the db.py fix) failed the whole run with no retry. Every measure in
# the query is per-loan and additive, so N balanced loan_id chunks (~22s each,
# mod(loan_id,N)) produce the identical result once re-aggregated. IL is small
# (~4s) and runs whole. Tunable without a code change via TREND_JLG_CHUNKS.
# 10 (not 6) since the day-level-DPD reframe makes each chunk heavier (~57s at
# N=6, in the replica's cancel window); N=10 keeps each chunk ~34s with margin.
TREND_JLG_CHUNKS = int(os.getenv("TREND_JLG_CHUNKS", "10"))

# rpt_trend_full dimension columns (everything else is a summable measure). The
# re-aggregation groups by these, so EVERY dimension must be listed or its grain
# is silently summed away.
_TREND_DIMS = ["month_end", "loan_source", "business_segment", "zone_name",
               "cluster_name", "region_name", "area_name", "branch_name",
               "branch_id", "lo_id", "state_id", "district_id",
               "disb_year", "cycle_no", "prod_classification"]


def _reaggregate_trend(df: pd.DataFrame) -> pd.DataFrame:
    """Collapse to one row per (month × segment × branch × lo).

    Chunking JLG by loan_id splits each group across passes — a branch's loans
    land in different loan_id chunks — so the same (month, branch, lo) appears
    once per chunk and the components must be summed. IL rows are already
    one-per-group, so this is a no-op for them. Keeps rpt_trend_full clean (one
    row per group) for the dashboard and for manual pgAdmin validation.
    """
    if df.empty:
        return df
    dims = [c for c in _TREND_DIMS if c in df.columns]
    measures = [c for c in df.columns if c not in dims]
    df[measures] = df[measures].apply(pd.to_numeric, errors="coerce").fillna(0)
    return df.groupby(dims, as_index=False, dropna=False)[measures].sum()


def _freeze_write_trend(combined, table: str) -> int:
    """FROZEN HISTORY write: replace ONLY the last completed month; every earlier
    month keeps the value it was last published with.

    Why: the engine recomputes all history from today's source state, so any
    later-arriving fact (a death flag, a write-off added to the master, a
    back-dated correction) would silently RESTATE months that were already
    published — e.g. July's OD Slippage changing weeks after month close.
    Only the newest completed month stays open (it keeps absorbing late-posted
    collections all through the following month); once the month rolls over it
    is frozen. Use --full-rebuild to deliberately restate everything after a
    logic change.
    """
    from pipeline.report_store import pg_engine
    from sqlalchemy import text
    if combined is None or combined.empty:
        # Never delete stored months on an empty result — that would silently wipe
        # the newest month. Fail loudly instead; the caller logs it and history stays.
        raise RuntimeError("trend_full produced no rows — refusing to touch stored history")
    boundary = pd.to_datetime(combined["month_end"]).max().date()
    recent = combined[pd.to_datetime(combined["month_end"]).dt.date >= boundary]
    eng = pg_engine()
    with eng.begin() as conn:
        conn.execute(text(f"DELETE FROM {table} WHERE month_end >= :b"), {"b": boundary})
        recent.to_sql(table, conn, if_exists="append", index=False, chunksize=5000)
        total = conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()
        frozen = conn.execute(text(
            f"SELECT COUNT(DISTINCT month_end) FROM {table} WHERE month_end < :b"), {"b": boundary}).scalar()
    log.info(f"    frozen history: {frozen} earlier month(s) preserved; "
             f"recomputed {boundary} only ({len(recent)} rows)")
    return total


def run_trend_full(full_rebuild: bool = False) -> bool:
    """Full-history monthly trend engine (IL whole + JLG chunked) → rpt_trend_full.

    Monthly grain (one row per month_end × segment × branch × lo) with
    additive measure components for the 13 Trend reports.

    History is FROZEN: only the last completed month is rewritten on a normal
    run (see _freeze_write_trend). Pass full_rebuild=True (CLI --full-rebuild)
    to restate every month — required after any calc change, and for the very
    first run that establishes the frozen baseline.
    """
    key, table = "trend_full", "rpt_trend_full"
    log.info(f"[START] {key} (IL whole + JLG in {TREND_JLG_CHUNKS} chunks, full history)")
    try:
        ids = get_writeoff_ids()
        base = {"wo_ids": ",".join(str(i) for i in ids) or "0",
                "wo_pairs": writeoff_values_literal()}

        # IL: whole book (fast). trend_full_il.sql has no {chunk_pred}; the empty
        # sub is a harmless no-op.
        il = run_sql_file("trend_full_il.sql", subs={**base, "chunk_pred": ""},
                          max_retries=2, retry_delay=20)
        log.info(f"    IL: {len(il)} rows")

        # JLG: N balanced loan_id chunks, each short enough to complete; a stalled
        # chunk retries in ~22s instead of discarding a 2-min whole-book run.
        parts = [il]
        for k in range(TREND_JLG_CHUNKS):
            pred = f"AND mod(la.loan_id, {TREND_JLG_CHUNKS}) = {k}"
            part = run_sql_file("trend_full_jlg.sql",
                                subs={**base, "chunk_pred": pred},
                                max_retries=4, retry_delay=20)
            log.info(f"    JLG chunk {k + 1}/{TREND_JLG_CHUNKS}: {len(part)} rows")
            parts.append(part)

        combined = _reaggregate_trend(pd.concat(parts, ignore_index=True))

        from pipeline.report_store import use_postgres, pg_write_df, pg_engine, table_exists
        if use_postgres():
            # Empty table (or an explicit restatement) => write every month;
            # otherwise keep published history frozen and rewrite only the last month.
            first_load = full_rebuild
            if not first_load:
                try:
                    from sqlalchemy import text as _t
                    with pg_engine().connect() as c:
                        first_load = (not table_exists(c, table)) or \
                            (c.execute(_t(f"SELECT COUNT(*) FROM {table}")).scalar() or 0) == 0
                except Exception:
                    first_load = True
            if first_load:
                n = pg_write_df(combined, table, mode="replace")
                print(f"  ✅ {table:<30} {n:>6} rows  [FULL REBUILD -> postgres]")
            else:
                n = _freeze_write_trend(combined, table)
                print(f"  ✅ {table:<30} {n:>6} rows  [frozen history -> postgres]")
        else:
            write_report(combined, table, mode="replace")
        write_pipeline_log(key, "SUCCESS")
        log.info(f"[OK]    {key} → {table} ({len(combined)} rows)")
        return True
    except Exception as e:
        log.error(f"[FAIL]  {key} — {e}")
        write_pipeline_log(key, "FAILED", str(e))
        return False


# ── MTD flow (current partial month) for the trend's July point ────────────────
_MTD_FLOW_DIMS = ["loan_source", "business_segment", "cluster_name", "region_name",
                  "area_name", "branch_name", "branch_id", "lo_id"]


def run_mtd_flow() -> bool:
    """Current partial-month flow measures no live report table carries — post
    write-off recovery + collections from prev-EOM PAR>60 loans — into
    rpt_mtd_flow, keyed like the trend so the backend appends the July (MTD,
    partial) point for wo_recovery / par60_collection. IL whole + JLG chunked
    (the prev-EOM DPD over ~440k JLG loans is the heavy part), then re-aggregated
    (a branch's loans span all chunks)."""
    key, table = "mtd_flow", "rpt_mtd_flow"
    log.info(f"[START] {key} (IL whole + JLG in {TREND_JLG_CHUNKS} chunks)")
    try:
        base = {"wo_pairs": writeoff_values_literal()}
        il = run_sql_file("mtd_flow_il.sql", subs={**base, "chunk_pred": ""},
                          max_retries=2, retry_delay=20)
        log.info(f"    IL: {len(il)} rows")
        parts = [il]
        for k in range(TREND_JLG_CHUNKS):
            pred = f"AND mod(la.loan_id, {TREND_JLG_CHUNKS}) = {k}"
            part = run_sql_file("mtd_flow_jlg.sql", subs={**base, "chunk_pred": pred},
                                max_retries=4, retry_delay=20)
            log.info(f"    JLG chunk {k + 1}/{TREND_JLG_CHUNKS}: {len(part)} rows")
            parts.append(part)
        df = pd.concat(parts, ignore_index=True)
        dims = [c for c in _MTD_FLOW_DIMS if c in df.columns]
        meas = [c for c in df.columns if c not in dims]
        df[meas] = df[meas].apply(pd.to_numeric, errors="coerce").fillna(0)
        combined = df.groupby(dims, as_index=False, dropna=False)[meas].sum()

        from pipeline.report_store import use_postgres, pg_write_df
        if use_postgres():
            n = pg_write_df(combined, table, mode="replace")
            print(f"  ✅ {table:<30} {n:>6} rows  [replace -> postgres]")
        else:
            write_report(combined, table, mode="replace")
        write_pipeline_log(key, "SUCCESS")
        log.info(f"[OK]    {key} → {table} ({len(combined)} rows)")
        return True
    except Exception as e:
        log.error(f"[FAIL]  {key} — {e}")
        write_pipeline_log(key, "FAILED", str(e))
        return False


# ── Monthly DPD snapshot (persistent, accumulates real month-ends over time) ───
def run_dpd_snapshot() -> bool:
    """Harvest the last completed month-end's OD set from rpt_od_list and append it
    to the persistent rpt_dpd_snapshot table (deduped by snapshot_month_end).

    rpt_od_list.prev_slippage = 1 marks loans that were OD at the previous month-end
    (computed from repayment history). Persisting one row per (month_end, loan) each
    run lets the 12-month previous-slippage analysis move from recompute toward real
    recorded monthly buckets as months accrue. No extra DB load — reads reports.db.
    """
    import sqlite3
    from datetime import date, timedelta
    from pipeline.sqlite_writer import SQLITE_PATH

    key = "dpd_snapshot"
    log.info(f"[START] {key}")
    try:
        month_end = (date.today().replace(day=1) - timedelta(days=1)).isoformat()  # last completed month-end

        from pipeline.report_store import use_postgres
        if use_postgres():
            from sqlalchemy import text
            from pipeline.report_store import pg_engine, table_exists
            with pg_engine().begin() as conn:
                od = pd.read_sql_query(text(
                    "SELECT loan_id, business_segment FROM rpt_od_list "
                    "WHERE prev_slippage = 1 "
                    "AND report_day = (SELECT MAX(report_day) FROM rpt_od_list)"
                ), conn)
                od = od.drop_duplicates("loan_id")
                od.insert(0, "snapshot_month_end", month_end)
                if table_exists(conn, "rpt_dpd_snapshot"):
                    conn.execute(text(
                        "DELETE FROM rpt_dpd_snapshot WHERE snapshot_month_end = :m"
                    ), {"m": month_end})
                od.to_sql("rpt_dpd_snapshot", conn, if_exists="append", index=False)
                months = conn.execute(text(
                    "SELECT COUNT(DISTINCT snapshot_month_end) FROM rpt_dpd_snapshot"
                )).scalar()
            write_pipeline_log(key, "SUCCESS")
            log.info(f"[OK]    {key} → rpt_dpd_snapshot ({len(od)} OD loans @ {month_end}; {months} month(s) stored) [postgres]")
            return True

        with sqlite3.connect(SQLITE_PATH) as conn:
            od = pd.read_sql(
                "SELECT loan_id, business_segment FROM rpt_od_list WHERE prev_slippage = 1",
                conn,
            )
            od = od.drop_duplicates("loan_id")
            od.insert(0, "snapshot_month_end", month_end)
            # idempotent per month: clear this month, then append
            cur = conn.cursor()
            cur.execute(
                "CREATE TABLE IF NOT EXISTS rpt_dpd_snapshot "
                "(snapshot_month_end TEXT, loan_id REAL, business_segment TEXT)"
            )
            cur.execute("DELETE FROM rpt_dpd_snapshot WHERE snapshot_month_end = ?", (month_end,))
            conn.commit()
            od.to_sql("rpt_dpd_snapshot", conn, if_exists="append", index=False)
            months = pd.read_sql(
                "SELECT COUNT(DISTINCT snapshot_month_end) m FROM rpt_dpd_snapshot", conn
            ).iloc[0]["m"]
        write_pipeline_log(key, "SUCCESS")
        log.info(f"[OK]    {key} → rpt_dpd_snapshot ({len(od)} OD loans @ {month_end}; {months} month(s) stored)")
        return True
    except Exception as e:
        log.error(f"[FAIL]  {key} — {e}")
        write_pipeline_log(key, "FAILED", str(e))
        return False


# Split reports dispatched by key (not part of the simple REPORTS loop).
SPLIT_REPORTS = {
    "bucket_movement": run_bucket_movement,
    "trend_monthly":   run_trend_monthly,
    "trend_full":      run_trend_full,
    "mtd_flow":        run_mtd_flow,
    "dpd_snapshot":    run_dpd_snapshot,
    "credit_bureau":   run_credit_bureau,   # sourced from the cb_engine DATABASE
}


def run_pipeline(target: str = None, full_rebuild: bool = False) -> None:
    start = datetime.now()
    log.info("=" * 60)
    log.info(f"Pipeline started  [{start:%Y-%m-%d %H:%M:%S}]")
    log.info("=" * 60)

    # A single split-report target (bucket_movement / trend_monthly)
    if target in SPLIT_REPORTS:
        fn = SPLIT_REPORTS[target]
        ok = fn(full_rebuild=full_rebuild) if fn is run_trend_full else fn()
        elapsed = (datetime.now() - start).seconds
        log.info("=" * 60)
        log.info(f"Pipeline complete in {elapsed}s  |  OK={int(ok)}  FAIL={int(not ok)}")
        log.info("=" * 60)
        return

    reports_to_run = (
        [r for r in REPORTS if r[0] == target] if target else REPORTS
    )

    if not reports_to_run:
        valid = [r[0] for r in REPORTS] + list(SPLIT_REPORTS)
        log.error(f"Unknown report key: '{target}'. Valid keys: {valid}")
        return

    success = failed = 0
    for report_key, sql_file, table_name in reports_to_run:
        if run_report(report_key, sql_file, table_name):
            success += 1
        else:
            failed += 1

    # When running everything, also run the split (IL+JLG) reports
    if not target:
        for fn in SPLIT_REPORTS.values():
            if fn():
                success += 1
            else:
                failed += 1

    elapsed = (datetime.now() - start).seconds
    log.info("=" * 60)
    log.info(
        f"Pipeline complete in {elapsed}s  |  "
        f"OK={success}  FAIL={failed}"
    )
    log.info("=" * 60)


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ananya MIS Pipeline Runner")
    parser.add_argument(
        "--report", "-r", type=str, default=None,
        help=f"Run a single report. Options: {[r[0] for r in REPORTS]}"
    )
    parser.add_argument(
        "--full-rebuild", action="store_true",
        help="trend_full: RESTATE every month instead of keeping published history "
             "frozen. Required after a calc change and for the first baseline load."
    )
    args = parser.parse_args()
    run_pipeline(target=args.report, full_rebuild=args.full_rebuild)
