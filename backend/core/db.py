import sqlite3
import pandas as pd
from .config import (
    SQLITE_PATH,
    REPORT_BACKEND, REPORT_PG_HOST, REPORT_PG_PORT, REPORT_PG_DBNAME,
    REPORT_PG_SCHEMA, REPORT_PG_USER, REPORT_PG_PASSWORD,
)

# ── Report store ───────────────────────────────────────────────────────────────
# REPORT_BACKEND=postgres → read reports from the DBA-created Postgres tables;
# anything else → the local SQLite reports.db. Every caller does
#   with reports_conn() as conn: pd.read_sql(sql, conn)
# which works identically for sqlite3 and SQLAlchemy connections.

_pg_engine = None


def _use_postgres() -> bool:
    return REPORT_BACKEND == "postgres" and bool(REPORT_PG_HOST)


def _get_pg_engine():
    global _pg_engine
    if _pg_engine is None:
        from urllib.parse import quote_plus
        from sqlalchemy import create_engine
        url = (
            f"postgresql+psycopg2://"
            f"{quote_plus(REPORT_PG_USER)}:{quote_plus(REPORT_PG_PASSWORD)}"
            f"@{REPORT_PG_HOST}:{REPORT_PG_PORT}/{REPORT_PG_DBNAME}"
        )
        _pg_engine = create_engine(
            url,
            connect_args={"options": f"-c search_path={REPORT_PG_SCHEMA}"
                                     " -c statement_timeout=120000",
                          # TCP keepalives so an idle connection is kept warm and a
                          # dropped one surfaces fast instead of hanging on read.
                          "keepalives": 1, "keepalives_idle": 30,
                          "keepalives_interval": 10, "keepalives_count": 5},
            # pre_ping checks a pooled connection on checkout (recycles if dead);
            # pool_recycle retires it proactively before the RDS/NAT idle timeout
            # drops it (the "SSL SYSCALL error: connection reset by peer" class).
            pool_pre_ping=True,
            pool_recycle=280,
            pool_size=5,
            max_overflow=5,
        )
    return _pg_engine


def reports_conn():
    """Connection to the report store (context-manager, pd.read_sql-ready)."""
    if _use_postgres():
        return _get_pg_engine().connect()
    return sqlite3.connect(SQLITE_PATH, check_same_thread=False)


# Report tables carry day-by-day rows in Postgres (report_day = run date);
# the dashboard always reads the LATEST day. Cache which tables have the
# column so we probe information_schema only once per table per process.
_DAY_COL = "report_day"
_day_col_cache: dict = {}


def _has_day_col(table: str) -> bool:
    if table not in _day_col_cache:
        try:
            with reports_conn() as conn:
                n = pd.read_sql(
                    "SELECT 1 FROM information_schema.columns "
                    f"WHERE table_schema = '{REPORT_PG_SCHEMA}' "
                    f"AND table_name = '{table}' AND column_name = '{_DAY_COL}'",
                    conn,
                )
            _day_col_cache[table] = not n.empty
        except Exception:
            _day_col_cache[table] = False
    return _day_col_cache[table]


def read_report(table: str) -> pd.DataFrame:
    """Read a report table, automatically restricted to the requesting
    user's data scope (see core/scope.py). report_gate stores the user in
    core.request_ctx at the start of every /api request, so every endpoint
    — current and future — is scoped without threading `user` around.

    In Postgres mode the tables accumulate day-by-day rows; the dashboard
    reads only the most recent report_day."""
    sql = f"SELECT * FROM {table}"
    if _use_postgres() and _has_day_col(table):
        sql += (f" WHERE {_DAY_COL} = (SELECT MAX({_DAY_COL}) FROM {table})")
    try:
        with reports_conn() as conn:
            df = pd.read_sql(sql, conn)
        if _DAY_COL in df.columns:
            df = df.drop(columns=[_DAY_COL])
    except Exception:
        return pd.DataFrame()

    from .request_ctx import current_user
    user = current_user.get()
    if user is not None:
        from .scope import scope_df
        df = scope_df(df, user)
    return df

def report_days(table: str) -> list[str]:
    """Every report_day stored for a table, oldest first.

    The day-stamped tables ARE the history, so this exposes which daily
    snapshots exist (used to find true month-end snapshots for the trend).
    Returns [] outside Postgres mode or when the table has no day column.
    """
    if not (_use_postgres() and _has_day_col(table)):
        return []
    try:
        with reports_conn() as conn:
            df = pd.read_sql(
                f"SELECT DISTINCT {_DAY_COL} FROM {table} ORDER BY {_DAY_COL}", conn)
        return [str(d) for d in pd.to_datetime(df[_DAY_COL]).dt.date]
    except Exception:
        return []


def read_report_at_days(table: str, days: list[str]) -> pd.DataFrame:
    """Read specific daily snapshots of a report table, scoped like read_report.

    Unlike read_report (which returns only the latest day) this keeps report_day
    so the caller can tell the snapshots apart.
    """
    if not days or not (_use_postgres() and _has_day_col(table)):
        return pd.DataFrame()
    placeholders = ", ".join(f"'{d}'" for d in days if str(d).replace("-", "").isdigit())
    if not placeholders:
        return pd.DataFrame()
    try:
        with reports_conn() as conn:
            df = pd.read_sql(
                f"SELECT * FROM {table} WHERE {_DAY_COL} IN ({placeholders})", conn)
    except Exception:
        return pd.DataFrame()

    from .request_ctx import current_user
    user = current_user.get()
    if user is not None:
        from .scope import scope_df
        df = scope_df(df, user)
    return df
