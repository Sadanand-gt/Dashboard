"""
db.py — PostgreSQL connection via SQLAlchemy.
Handles special characters in passwords via URL encoding.
Includes retry logic for RDS replica conflict errors.
"""

import os
import time
import logging
import pandas as pd
from contextlib import contextmanager
from urllib.parse import quote_plus
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

log = logging.getLogger(__name__)

# Load .env from project root
_env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
load_dotenv(_env_path)

QUERY_DIR = os.path.join(os.path.dirname(__file__), "queries")


# ── Build connection URL ───────────────────────────────────────────────────────
# quote_plus encodes special characters (@, #, %, ! etc.) in user/password.
# Without this, a password like "abc@123" breaks the URL parser.
def _get_url() -> str:
    host     = os.getenv("PG_HOST",     "localhost")
    port     = os.getenv("PG_PORT",     "5432")
    dbname   = os.getenv("PG_DBNAME",   "your_database_name")
    user     = os.getenv("PG_USER",     "your_username")
    password = os.getenv("PG_PASSWORD", "your_password")
    return (
        f"postgresql+psycopg2://"
        f"{quote_plus(user)}:{quote_plus(password)}"
        f"@{host}:{port}/{dbname}"
    )


# ── Engine ────────────────────────────────────────────────────────────────────
def _get_engine():
    return create_engine(
        _get_url(),
        connect_args={
            # Set search path + statement timeout at connection level
            # statement_timeout=600000ms = 10 minutes
            "options": "-c search_path=public -c statement_timeout=600000"
        },
        pool_pre_ping=True,
        pool_size=1,
        max_overflow=0,
    )


# ── Credit-bureau engine (separate DATABASE, same instance) ───────────────────
# The bureau decision engine writes to its own database, `cb_engine`, on the same
# server as the core replica — so host/port/user/password are shared and only the
# dbname differs. CB_* env vars override any of them if that ever stops being true.
def _get_cb_url() -> str:
    host     = os.getenv("CB_PG_HOST",     os.getenv("PG_HOST", "localhost"))
    port     = os.getenv("CB_PG_PORT",     os.getenv("PG_PORT", "5432"))
    dbname   = os.getenv("CB_PG_DBNAME",   "cb_engine")
    user     = os.getenv("CB_PG_USER",     os.getenv("PG_USER", ""))
    password = os.getenv("CB_PG_PASSWORD", os.getenv("PG_PASSWORD", ""))
    return (
        f"postgresql+psycopg2://"
        f"{quote_plus(user)}:{quote_plus(password)}"
        f"@{host}:{port}/{dbname}"
    )


def get_cb_engine():
    """Engine for the cb_engine database. equifax_history holds ~138M rows, so
    every query against it must be bounded — never scan it unfiltered."""
    return create_engine(
        _get_cb_url(),
        connect_args={"options": "-c search_path=public -c statement_timeout=600000"},
        pool_pre_ping=True,
        pool_size=1,
        max_overflow=0,
    )


# ── SQL file execution with retry ─────────────────────────────────────────────
def run_sql_file(filename: str, params: dict = None, subs: dict = None,
                 max_retries: int = 3, retry_delay: int = 60,
                 conn=None) -> pd.DataFrame:
    """
    Read a .sql file and execute against PostgreSQL.
    Auto-retries on replica conflict (error 40001) up to max_retries times.

    subs: optional {placeholder: text} map for literal string substitution into
    the SQL before execution (e.g. injecting a large id list as an array literal).
    Use only with trusted, internally-generated values.

    conn: optional existing connection to execute on. Used by snapshot_connection()
    so that a report and its loan-grain child read the SAME database snapshot — see
    that function. Retries are skipped when a connection is supplied, because a
    retry inside a REPEATABLE READ transaction would re-read the same aborted
    snapshot; the caller decides what to do instead.
    """
    filepath = os.path.join(QUERY_DIR, filename)
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"SQL file not found: {filepath}")

    with open(filepath, "r", encoding="utf-8") as f:
        sql = f.read()

    if subs:
        for key, val in subs.items():
            sql = sql.replace("{" + key + "}", val)

    if conn is not None:
        df = pd.read_sql_query(text(sql), conn, params=params)
        log.info(f"    DB OK (shared snapshot) — {len(df)} rows returned")
        return df

    engine = _get_engine()
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            log.info(f"    DB attempt {attempt}/{max_retries} ...")
            with engine.connect() as conn:
                df = pd.read_sql_query(text(sql), conn, params=params)
            log.info(f"    DB OK — {len(df)} rows returned")
            return df

        except Exception as e:
            last_error = e
            err_str = str(e).lower()

            # Transient, worth-retrying failures on the read replica: recovery
            # conflicts AND dropped connections. The heavy trend query gets its
            # connection cancelled under load ("SSL connection has been closed
            # unexpectedly") — a hard OperationalError that used to fail the whole
            # run with no retry. On these we must also dispose the pool, since the
            # dead connection would otherwise be handed back on the next attempt.
            retryable = (
                "conflict with recovery" in err_str
                or "40001" in err_str
                or "ssl connection has been closed" in err_str
                or "server closed the connection" in err_str
                or "connection has been closed" in err_str
                or "could not receive data from server" in err_str
                or "terminating connection" in err_str
            )
            if retryable:
                if attempt < max_retries:
                    log.warning(
                        f"    Transient DB error on attempt {attempt} "
                        f"({str(e).splitlines()[0][:70]}). Retrying in {retry_delay}s ..."
                    )
                    try:
                        engine.dispose()          # drop the stale/dead connection
                    except Exception:
                        pass
                    time.sleep(retry_delay)
                    continue
                else:
                    log.error(
                        f"    Transient DB error persists after {max_retries} attempts."
                    )
            else:
                raise  # non-transient error — fail immediately

    raise RuntimeError(
        f"Query failed after {max_retries} attempts: {last_error}"
    )


# ── Raw query helper ──────────────────────────────────────────────────────────
@contextmanager
def snapshot_connection():
    """One REPEATABLE READ transaction that several reports can share.

    WHY THIS EXISTS
        A loan-grain export copies its parent report's CTEs verbatim, so the two
        can never disagree on LOGIC. But they are two separate executions against a
        live read replica, and in a full pipeline run they are minutes apart
        (aum_status is 2nd in REPORTS, aum_loans ~14th). Anything that replicates
        in between lands in one table and not the other.

        That is not hypothetical: on 2026-08-18 rpt_aum_status held 92,788 loans
        Excl W/O while rpt_aum_loans held 92,797 — 9 loans apart on the SAME
        report_day, so the page and its CSV export disagreed.

        Under REPEATABLE READ every statement in the transaction sees the snapshot
        taken at the first one, so parent and child read identical data.

    CAVEAT — a long transaction on a hot standby is more exposed to
    "canceling statement due to conflict with recovery". The caller must be ready
    to fall back to running the reports separately; see run_snapshot_group().
    """
    engine = _get_engine()
    conn = engine.connect()
    try:
        conn.execution_options(isolation_level="REPEATABLE READ")
        trans = conn.begin()
        try:
            yield conn
            trans.rollback()          # read-only; nothing to commit
        except Exception:
            trans.rollback()
            raise
    finally:
        conn.close()
        try:
            engine.dispose()
        except Exception:
            pass


def run_query(sql: str, params: dict = None) -> pd.DataFrame:
    engine = _get_engine()
    with engine.connect() as conn:
        return pd.read_sql_query(text(sql), conn, params=params)


# ── Connection test ───────────────────────────────────────────────────────────
def test_connection() -> bool:
    try:
        engine = _get_engine()
        with engine.connect() as conn:
            result = conn.execute(text("SELECT version()"))
            version = result.fetchone()[0]
            print(f"Connected OK: {version[:60]}")
            return True
    except Exception as e:
        print(f"Connection failed: {e}")
        return False


if __name__ == "__main__":
    test_connection()