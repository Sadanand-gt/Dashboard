import sqlite3
import pandas as pd
from .config import (
    SQLITE_PATH, USERS_DB_PATH,
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
                                     " -c statement_timeout=120000"},
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=5,
        )
    return _pg_engine


def reports_conn():
    """Connection to the report store (context-manager, pd.read_sql-ready)."""
    if _use_postgres():
        return _get_pg_engine().connect()
    return sqlite3.connect(SQLITE_PATH, check_same_thread=False)


def users_conn():
    conn = sqlite3.connect(USERS_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


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


def init_users_db() -> None:
    with users_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT    UNIQUE NOT NULL,
                password_hash TEXT    NOT NULL,
                full_name     TEXT    NOT NULL,
                role          TEXT    NOT NULL DEFAULT 'analyst',
                cluster_id    TEXT,
                region_id    TEXT,
                area_id       TEXT,
                branch_id     TEXT,
                is_active     INTEGER NOT NULL DEFAULT 1,
                created_at    TEXT    DEFAULT (datetime('now')),
                last_login    TEXT
            )
        """)
        # ── migrations (idempotent) ──────────────────────────────────────────
        # Data scope: hierarchy level (ho/zone/cluster/region/area/branch/lo)
        # + value(s, comma-separated). Replaces the legacy per-level columns.
        existing = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
        if "scope_level" not in existing:
            conn.execute("ALTER TABLE users ADD COLUMN scope_level TEXT")
        if "scope_value" not in existing:
            conn.execute("ALTER TABLE users ADD COLUMN scope_value TEXT")
        # Report visibility whitelist: no rows for a user = all reports allowed.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_reports (
                user_id    INTEGER NOT NULL,
                report_key TEXT    NOT NULL,
                PRIMARY KEY (user_id, report_key)
            )
        """)
        conn.commit()
