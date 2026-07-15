"""One-time migration: copy every table from reports.db (SQLite) into the
Postgres report store (REPORT_PG_* in .env), preserving DBA-created DDL.

- Tables the DBA already created: DELETE + append (their types/keys/indexes
  survive); any missing columns are ALTERed in (e.g. lo_id).
- Tables the DBA didn't create (e.g. *_hist, pipeline_log): created on the
  fly from the DataFrame.
- Verifies row counts per table afterwards.

Run:  python -m pipeline.migrate_reports_to_pg
Safe to re-run (idempotent full copies).
"""
import os
import sqlite3
from datetime import datetime

import pandas as pd

from pipeline.report_store import pg_engine, pg_write_df, pg_schema

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQLITE_PATH = os.path.join(BASE_DIR, "reports.db")


def main():
    if not os.getenv("REPORT_PG_HOST"):
        raise SystemExit("REPORT_PG_HOST is not set in .env — fill the REPORT_PG_* block first.")

    src = sqlite3.connect(SQLITE_PATH)
    tables = [r[0] for r in src.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    print(f"Migrating {len(tables)} tables  reports.db -> "
          f"{os.getenv('REPORT_PG_DBNAME')}.{pg_schema()}  "
          f"[{datetime.now():%H:%M:%S}]\n")

    results, failures = [], []
    for t in tables:
        df = pd.read_sql(f"SELECT * FROM {t}", src)
        try:
            n_pg = pg_write_df(df, t, mode="replace")
            ok = n_pg == len(df)
            results.append((t, len(df), n_pg, ok))
            print(f"  {'OK  ' if ok else 'DIFF'}  {t:<32} sqlite={len(df):>7,}  pg={n_pg:>7,}")
            if not ok:
                failures.append(t)
        except Exception as e:
            failures.append(t)
            print(f"  FAIL  {t:<32} {str(e)[:100]}")

    print()
    if failures:
        print(f"FAILURES ({len(failures)}): {failures}")
    else:
        print(f"ALL {len(results)} TABLES MIGRATED & COUNT-VERIFIED")


if __name__ == "__main__":
    main()
