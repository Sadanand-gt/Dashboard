"""
load_writeoff_master.py — Load the Excel "Write-off Master" sheet into reports.db.

In the core-banking replica, write-off status (status='W') is NOT reliably
updated. The authoritative write-off list is the "Write-off Master" sheet in the
Excel dashboard. We store it locally and treat any loan_id present here as a
write-off for ALL report calculations (overriding the DB status).

Usage:  python -m pipeline.load_writeoff_master
"""

import os
import sqlite3
from datetime import date, timedelta

import pyxlsb

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSB = os.path.join(BASE_DIR, "References", "July, 2026 Dashboards.xlsb")
SQLITE_PATH = os.path.join(BASE_DIR, "reports.db")
SHEET = "Write-off Master"

# Excel serial date epoch (Windows): day 1 = 1900-01-01, with the 1900 leap bug
# → use 1899-12-30 as the base.
_EXCEL_EPOCH = date(1899, 12, 30)


def _excel_date(serial):
    try:
        return (_EXCEL_EPOCH + timedelta(days=int(float(serial)))).isoformat()
    except (TypeError, ValueError):
        return None


def load() -> int:
    rows = []
    with pyxlsb.open_workbook(XLSB) as wb:
        with wb.get_sheet(SHEET) as sh:
            for i, row in enumerate(sh.rows()):
                if i < 2:           # row 1 = title, row 2 = header
                    continue
                cells = {c.c: c.v for c in row}
                loan_no = cells.get(1)          # C1 = Loan No.
                final_no = cells.get(5)         # C5 = Final Loan No.
                if loan_no is None and final_no is None:
                    continue
                loan_id = final_no if final_no is not None else loan_no
                try:
                    loan_id = int(float(loan_id))
                except (TypeError, ValueError):
                    continue
                rows.append({
                    "loan_id":        loan_id,
                    "writeoff_date":  _excel_date(cells.get(2)),
                    "business_segment": (str(cells.get(3)).strip() if cells.get(3) else None),
                    "writeoff_amount": float(cells.get(4)) if cells.get(4) is not None else 0.0,
                })

    # de-dupe loan_ids (keep first)
    seen, deduped = set(), []
    for r in rows:
        if r["loan_id"] in seen:
            continue
        seen.add(r["loan_id"])
        deduped.append(r)

    from pipeline.report_store import use_postgres
    if use_postgres():
        import pandas as pd
        from sqlalchemy import text
        from pipeline.report_store import pg_engine, table_exists
        df = pd.DataFrame(deduped)
        with pg_engine().begin() as conn:
            if table_exists(conn, "writeoff_master"):
                conn.execute(text("DELETE FROM writeoff_master"))
            df.to_sql("writeoff_master", conn, if_exists="append", index=False, chunksize=5000)
        return len(deduped)

    with sqlite3.connect(SQLITE_PATH) as conn:
        conn.execute("DROP TABLE IF EXISTS writeoff_master")
        conn.execute("""
            CREATE TABLE writeoff_master (
                loan_id          INTEGER PRIMARY KEY,
                writeoff_date    TEXT,
                business_segment TEXT,
                writeoff_amount  REAL
            )
        """)
        conn.executemany(
            "INSERT OR IGNORE INTO writeoff_master "
            "(loan_id, writeoff_date, business_segment, writeoff_amount) VALUES (?,?,?,?)",
            [(r["loan_id"], r["writeoff_date"], r["business_segment"], r["writeoff_amount"])
             for r in deduped],
        )
        conn.commit()
    return len(deduped)


def get_writeoff_ids() -> list[int]:
    """Return all write-off loan_ids from the report store (empty if not loaded)."""
    from pipeline.report_store import use_postgres
    if use_postgres():
        try:
            from pipeline.report_store import pg_read
            return [int(v) for v in pg_read("SELECT loan_id FROM writeoff_master")["loan_id"]]
        except Exception:
            return []
    try:
        with sqlite3.connect(SQLITE_PATH) as conn:
            return [r[0] for r in conn.execute("SELECT loan_id FROM writeoff_master")]
    except sqlite3.OperationalError:
        return []


if __name__ == "__main__":
    n = load()
    print(f"Loaded {n:,} write-off loan_ids into reports.db (writeoff_master)")
