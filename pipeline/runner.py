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

from pipeline.db import run_sql_file
from pipeline.sqlite_writer import write_report, write_pipeline_log, archive_report
from pipeline.load_writeoff_master import get_writeoff_ids

# Reports whose SQL needs the write-off master ids injected (placeholder {wo_ids}).
WRITEOFF_AWARE = {"aum_status", "collection_fact", "od_list", "od_slippage", "dq_category"}  # {wo_ids} used for raw_status override (not loan inclusion)

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
]

# Split reports — IL and JLG run as separate DB calls, combined in Python.
BUCKET_MOVEMENT_FILES = ["bucket_movement_il.sql", "bucket_movement_jlg.sql"]
TREND_MONTHLY_FILES   = ["trend_monthly_il.sql", "trend_monthly_jlg.sql"]


# ── Runner ────────────────────────────────────────────────────────────────────
def run_report(report_key: str, sql_file: str, table_name: str) -> bool:
    log.info(f"[START] {report_key}")
    try:
        subs = None
        if report_key in WRITEOFF_AWARE:
            ids = get_writeoff_ids()
            subs = {"wo_ids": ",".join(str(i) for i in ids)}
            log.info(f"    injecting {len(ids)} write-off ids from writeoff_master")
        df = run_sql_file(sql_file, subs=subs)
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
    "dpd_snapshot":    run_dpd_snapshot,
}


def run_pipeline(target: str = None) -> None:
    start = datetime.now()
    log.info("=" * 60)
    log.info(f"Pipeline started  [{start:%Y-%m-%d %H:%M:%S}]")
    log.info("=" * 60)

    # A single split-report target (bucket_movement / trend_monthly)
    if target in SPLIT_REPORTS:
        ok = SPLIT_REPORTS[target]()
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
    args = parser.parse_args()
    run_pipeline(target=args.report)
