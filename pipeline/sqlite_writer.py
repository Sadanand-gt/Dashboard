"""
sqlite_writer.py — Write pre-computed report DataFrames to SQLite.

Each report is stored as a separate table in reports.db.
The dashboard reads ONLY from this file — zero PostgreSQL at render time.
"""

import sqlite3
import os
import pandas as pd
from datetime import datetime, date

SQLITE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),  # project root
    "reports.db"
)


# ── Write ─────────────────────────────────────────────────────────────────────
def write_report(df: pd.DataFrame, table_name: str, mode: str = "replace") -> None:
    """
    Persist a DataFrame to a SQLite table.

    Args:
        df         : The pre-computed report data.
        table_name : Target table in reports.db  (e.g. "rpt_pos_par").
        mode       : 'replace' = full refresh (default for daily batch).
                     'append'  = incremental insert (for history tables).
    """
    if df.empty:
        print(f"  ⚠️  Skipped: {table_name} — DataFrame is empty")
        return

    from pipeline.report_store import use_postgres, pg_write_report_day
    if use_postgres():
        # Postgres: day-by-day in the SAME table — rows stamped report_day=today,
        # only today's rows replaced (idempotent), earlier days untouched.
        today = date.today().isoformat()
        n, days = pg_write_report_day(df, table_name, today)
        print(f"  ✅ {table_name:<30} {n:>6} rows @ {today}  [{days} day(s) kept -> postgres]")
        return

    with sqlite3.connect(SQLITE_PATH) as conn:
        df.to_sql(table_name, conn, if_exists=mode, index=False)
        row_count = pd.read_sql(f"SELECT COUNT(*) AS n FROM {table_name}", conn).iloc[0]["n"]
        print(f"  ✅ {table_name:<30} {row_count:>6} rows  [{mode}]")


# ── Day-by-day history archive ─────────────────────────────────────────────────
def archive_report(df: pd.DataFrame, table_name: str, snapshot_date: str = None) -> None:
    """Append a dated copy of a report into its history table `<table_name>_hist`,
    so each day's report is retained instead of being overwritten.

    - Does NOT touch the live `rpt_*` table (dashboard still reads the latest).
    - Adds a leading `snapshot_date` column (the run date, YYYY-MM-DD).
    - Idempotent per day: re-running the same date replaces that date's rows
      (so multiple runs in one day don't duplicate).
    - Schema evolution: when a report gains a column, the history table is
      ALTERed to add it (old rows keep NULL) instead of skipping the archive.
    Failures here never break the pipeline — the live report is already written.
    """
    if df is None or df.empty:
        return
    snapshot_date = snapshot_date or date.today().isoformat()
    hist = f"{table_name}_hist"

    from pipeline.report_store import use_postgres
    if use_postgres():
        # Postgres keeps day-by-day history in the SAME table (report_day
        # stamped by write_report) — no _hist twin tables there.
        return

    try:
        d = df.copy()
        d.insert(0, "snapshot_date", snapshot_date)
        with sqlite3.connect(SQLITE_PATH) as conn:
            exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (hist,)
            ).fetchone()
            if exists:
                # migrate: add any new report columns to the history table
                have = {r[1] for r in conn.execute(f"PRAGMA table_info({hist})")}
                for col in d.columns:
                    if col not in have:
                        kind = d[col].dtype.kind
                        sql_type = ("INTEGER" if kind in "iub"
                                    else "REAL" if kind == "f" else "TEXT")
                        conn.execute(f'ALTER TABLE {hist} ADD COLUMN "{col}" {sql_type}')
                        print(f"     -> {hist}: added new column '{col}' ({sql_type}); older days keep NULL")
                conn.execute(f"DELETE FROM {hist} WHERE snapshot_date = ?", (snapshot_date,))
                conn.commit()
            d.to_sql(hist, conn, if_exists="append", index=False)
            conn.execute(f'CREATE INDEX IF NOT EXISTS "idx_{hist}_date" ON {hist}(snapshot_date)')
            days = conn.execute(f"SELECT COUNT(DISTINCT snapshot_date) FROM {hist}").fetchone()[0]
            conn.commit()
        print(f"     -> archived  {hist:<30} (+{len(d)} rows @ {snapshot_date}; {days} day(s) kept)")
    except Exception as e:
        print(f"     [!] archive skipped for {hist}: {str(e)[:80]}")


# ── Metadata table ─────────────────────────────────────────────────────────────
def write_pipeline_log(report_name: str, status: str, error: str = None) -> None:
    """
    Write a run record to pipeline_log table so dashboard can show
    'Last refreshed: 06 Jun 2026 06:00 AM'.
    """
    log_df = pd.DataFrame([{
        "report_name":  report_name,
        "status":       status,           # 'SUCCESS' | 'FAILED'
        "error_msg":    error or "",
        "run_at":       datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }])

    from pipeline.report_store import use_postgres, pg_write_df
    if use_postgres():
        try:
            pg_write_df(log_df, "pipeline_log", mode="append")
        except Exception as e:
            print(f"     [!] pipeline_log write failed: {str(e)[:80]}")
        return

    with sqlite3.connect(SQLITE_PATH) as conn:
        log_df.to_sql("pipeline_log", conn, if_exists="append", index=False)


# ── Read helpers (used by dashboard) ──────────────────────────────────────────
def read_report(table_name: str) -> pd.DataFrame:
    """Read a pre-computed report table from SQLite."""
    with sqlite3.connect(SQLITE_PATH) as conn:
        return pd.read_sql(f"SELECT * FROM {table_name}", conn)


def get_last_refresh(report_name: str) -> str:
    """Return the timestamp of the last successful run for a report."""
    try:
        with sqlite3.connect(SQLITE_PATH) as conn:
            df = pd.read_sql(
                """
                SELECT run_at FROM pipeline_log
                WHERE report_name = ? AND status = 'SUCCESS'
                ORDER BY run_at DESC LIMIT 1
                """,
                conn, params=(report_name,)
            )
        return df.iloc[0]["run_at"] if not df.empty else "Never"
    except Exception:
        return "Never"


def list_tables() -> list:
    """List all tables currently in reports.db."""
    with sqlite3.connect(SQLITE_PATH) as conn:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
        return [row[0] for row in cur.fetchall()]


# ── Run directly to inspect ───────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"SQLite path : {SQLITE_PATH}")
    print(f"Exists      : {os.path.exists(SQLITE_PATH)}")
    if os.path.exists(SQLITE_PATH):
        tables = list_tables()
        print(f"Tables      : {tables}")
