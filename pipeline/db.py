"""
db.py — PostgreSQL connection via SQLAlchemy.
Handles special characters in passwords via URL encoding.
Includes retry logic for RDS replica conflict errors.
"""

import os
import time
import logging
import pandas as pd
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


# ── SQL file execution with retry ─────────────────────────────────────────────
def run_sql_file(filename: str, params: dict = None, subs: dict = None,
                 max_retries: int = 3, retry_delay: int = 60) -> pd.DataFrame:
    """
    Read a .sql file and execute against PostgreSQL.
    Auto-retries on replica conflict (error 40001) up to max_retries times.

    subs: optional {placeholder: text} map for literal string substitution into
    the SQL before execution (e.g. injecting a large id list as an array literal).
    Use only with trusted, internally-generated values.
    """
    filepath = os.path.join(QUERY_DIR, filename)
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"SQL file not found: {filepath}")

    with open(filepath, "r", encoding="utf-8") as f:
        sql = f.read()

    if subs:
        for key, val in subs.items():
            sql = sql.replace("{" + key + "}", val)

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

            if "conflict with recovery" in err_str or "40001" in err_str:
                if attempt < max_retries:
                    log.warning(
                        f"    Replica conflict on attempt {attempt}. "
                        f"Retrying in {retry_delay}s ..."
                    )
                    time.sleep(retry_delay)
                    continue
                else:
                    log.error(
                        f"    Replica conflict persists after {max_retries} attempts."
                    )
            else:
                raise  # non-replica error — fail immediately

    raise RuntimeError(
        f"Query failed after {max_retries} attempts: {last_error}"
    )


# ── Raw query helper ──────────────────────────────────────────────────────────
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