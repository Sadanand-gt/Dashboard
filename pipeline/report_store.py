"""
report_store.py — where the computed reports live (the "report DB").

Two backends, switched by REPORT_BACKEND in .env:
    sqlite    -> reports.db in the project root (the original setup)
    postgres  -> the writable Postgres where the DBA created the rpt_* tables
                 (REPORT_PG_HOST / PORT / DBNAME / USER / PASSWORD / SCHEMA)

NB: this is the report STORE (write target + dashboard read source) — distinct
from the source warehouse replica in pipeline/db.py (PG_* vars), which stays
read-only for the heavy report queries.

Design rule for Postgres writes: NEVER drop/recreate tables — the DBA owns the
DDL (types, keys, indexes). Full refresh = DELETE + append inside one
transaction; schema evolution = ALTER TABLE ADD COLUMN for new report columns.
"""

import os
from urllib.parse import quote_plus

import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

_env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
load_dotenv(_env_path)

_engine = None


def use_postgres() -> bool:
    return os.getenv("REPORT_BACKEND", "sqlite").strip().lower() == "postgres"


def pg_schema() -> str:
    return os.getenv("REPORT_PG_SCHEMA", "public").strip() or "public"


def pg_engine():
    """Cached SQLAlchemy engine for the report store (writable Postgres)."""
    global _engine
    if _engine is None:
        user = os.getenv("REPORT_PG_USER", "")
        pwd = os.getenv("REPORT_PG_PASSWORD", "")
        host = os.getenv("REPORT_PG_HOST", "localhost")
        port = os.getenv("REPORT_PG_PORT", "5432")
        db = os.getenv("REPORT_PG_DBNAME", "report_db")
        _engine = create_engine(
            f"postgresql+psycopg2://{quote_plus(user)}:{quote_plus(pwd)}@{host}:{port}/{db}",
            connect_args={"options": f"-c search_path={pg_schema()} -c statement_timeout=600000"},
            pool_pre_ping=True,
            pool_size=2,
            max_overflow=2,
        )
    return _engine


def table_exists(conn, table: str) -> bool:
    return conn.execute(
        text("SELECT to_regclass(:t)"), {"t": f"{pg_schema()}.{table}"}
    ).scalar() is not None


def _pg_type_for(dtype) -> str:
    kind = dtype.kind
    if kind in "iu":
        return "BIGINT"
    if kind == "f":
        return "DOUBLE PRECISION"
    if kind == "b":
        return "BOOLEAN"
    if kind == "M":
        return "TIMESTAMP"
    return "TEXT"


def ensure_columns(conn, table: str, df: pd.DataFrame) -> None:
    """ALTER TABLE ADD COLUMN for report columns missing in the PG table
    (schema evolution — e.g. the lo_id rollout). Existing rows keep NULL."""
    have = {
        r[0] for r in conn.execute(
            text("SELECT column_name FROM information_schema.columns "
                 "WHERE table_schema = :s AND table_name = :t"),
            {"s": pg_schema(), "t": table},
        )
    }
    for col in df.columns:
        if col not in have:
            conn.execute(text(
                f'ALTER TABLE {table} ADD COLUMN "{col}" {_pg_type_for(df[col].dtype)}'
            ))
            print(f"     -> {table}: added new column '{col}'; existing rows keep NULL")


def pg_write_df(df: pd.DataFrame, table: str, mode: str = "replace") -> int:
    """Write a DataFrame to the PG report store.

    mode='replace': DELETE all rows + append, atomically (the DBA's DDL,
                    keys and indexes survive; readers never see a half-load).
    mode='append' : plain append.
    Returns the table's row count after the write.
    """
    eng = pg_engine()
    with eng.begin() as conn:
        if table_exists(conn, table):
            ensure_columns(conn, table, df)
            if mode == "replace":
                conn.execute(text(f"DELETE FROM {table}"))
        df.to_sql(table, conn, if_exists="append", index=False, chunksize=5000)
        return conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()


DAY_COL = "report_day"   # uniform run-day column on every report table


def pg_write_report_day(df: pd.DataFrame, table: str, day: str) -> tuple[int, int]:
    """Day-by-day write into the SAME table (the agreed Postgres design):

    - stamps every row with report_day = <day> (the run date),
    - deletes only that day's rows first (idempotent re-runs, other days
      untouched — the table IS the history; never truncated),
    - appends inside one transaction so readers never see a half-day,
    - ALTERs the report_day column / any missing report column in if absent
      (raises with a clear message if the DB user lacks the privilege).

    Returns (rows written for the day, distinct days now stored).
    """
    d = df.copy()
    d.insert(0, DAY_COL, day)
    eng = pg_engine()
    with eng.begin() as conn:
        if not table_exists(conn, table):
            raise RuntimeError(
                f"{table} does not exist in the report DB — ask the DBA to create it")
        try:
            ensure_columns(conn, table, d)
        except Exception as e:
            raise RuntimeError(
                f"{table} is missing column(s) and ALTER failed ({str(e)[:80]}) — "
                f"ask the DBA to add them (see dba_add_report_day.sql)") from e
        conn.execute(text(f"DELETE FROM {table} WHERE {DAY_COL} = :d"), {"d": day})
        d.to_sql(table, conn, if_exists="append", index=False, chunksize=5000)
        days = conn.execute(text(
            f"SELECT COUNT(DISTINCT {DAY_COL}) FROM {table}")).scalar()

    # Index is normally DBA-created (dba_add_report_day.sql); best-effort here,
    # in its own transaction so a privilege error never fails the data write.
    try:
        with eng.begin() as conn:
            conn.execute(text(
                f'CREATE INDEX IF NOT EXISTS "idx_{table}_day" ON {table}({DAY_COL})'))
    except Exception:
        pass
    return len(d), days


def pg_read(sql: str, params: dict = None) -> pd.DataFrame:
    with pg_engine().connect() as conn:
        return pd.read_sql_query(text(sql), conn, params=params)
