"""MIS-local authorization, report grants, login audit, and sessions."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import secrets

import psycopg2
from psycopg2 import sql
from psycopg2.extras import RealDictCursor

from core.config import (
    MIS_PG_DBNAME,
    MIS_PG_HOST,
    MIS_PG_PASSWORD,
    MIS_PG_PORT,
    MIS_PG_SCHEMA,
    MIS_PG_USER,
    SESSION_TIMEOUT_MINUTES,
)


class MisStoreError(RuntimeError):
    pass


REQUIRED_TABLES = {"mis_users", "mis_user_reports", "mis_sessions", "mis_login_audit"}


@contextmanager
def mis_conn():
    try:
        conn = psycopg2.connect(
            host=MIS_PG_HOST,
            port=MIS_PG_PORT,
            dbname=MIS_PG_DBNAME,
            user=MIS_PG_USER,
            password=MIS_PG_PASSWORD,
            connect_timeout=8,
            cursor_factory=RealDictCursor,
            options="-c statement_timeout=15000",
        )
    except psycopg2.Error as exc:
        raise MisStoreError("MIS authorization database is unavailable") from exc
    try:
        yield conn
    except psycopg2.errors.UniqueViolation:
        conn.rollback()
        raise
    except psycopg2.Error as exc:
        conn.rollback()
        raise MisStoreError("MIS authorization database operation failed") from exc
    finally:
        conn.close()


def _table(name: str):
    return sql.Identifier(MIS_PG_SCHEMA, name)


def verify_schema() -> None:
    try:
        with mis_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema=%s AND table_name=ANY(%s)",
                (MIS_PG_SCHEMA, list(REQUIRED_TABLES)),
            )
            found = {row["table_name"] for row in cur.fetchall()}
    except psycopg2.Error as exc:
        raise MisStoreError("Unable to verify MIS authorization schema") from exc
    missing = REQUIRED_TABLES - found
    if missing:
        raise MisStoreError(
            "MIS authorization schema is missing. Apply backend/auth/schema.sql first."
        )


def _with_reports(row: dict, cur) -> dict:
    user = dict(row)
    if user["role"] == "admin":
        user["allowed_reports"] = ["*"]
    else:
        cur.execute(
            sql.SQL("SELECT report_key FROM {} WHERE user_id=%s ORDER BY report_key").format(
                _table("mis_user_reports")
            ),
            (user["id"],),
        )
        keys = [r["report_key"] for r in cur.fetchall()]
        user["allowed_reports"] = keys if keys else ["*"]
    return user


def get_user_by_username(username: str) -> dict | None:
    with mis_conn() as conn, conn.cursor() as cur:
        cur.execute(
            sql.SQL("SELECT * FROM {} WHERE lower(username)=lower(%s)").format(_table("mis_users")),
            (username.strip(),),
        )
        row = cur.fetchone()
        return _with_reports(row, cur) if row else None


def get_user(user_id: int) -> dict | None:
    with mis_conn() as conn, conn.cursor() as cur:
        cur.execute(sql.SQL("SELECT * FROM {} WHERE id=%s").format(_table("mis_users")), (user_id,))
        row = cur.fetchone()
        return _with_reports(row, cur) if row else None


def list_users() -> list[dict]:
    with mis_conn() as conn, conn.cursor() as cur:
        cur.execute(sql.SQL("SELECT * FROM {} ORDER BY id").format(_table("mis_users")))
        return [_with_reports(row, cur) for row in cur.fetchall()]


def _save_reports(cur, user_id: int, reports: list[str]) -> None:
    cur.execute(sql.SQL("DELETE FROM {} WHERE user_id=%s").format(_table("mis_user_reports")), (user_id,))
    if reports:
        cur.executemany(
            sql.SQL("INSERT INTO {} (user_id, report_key) VALUES (%s,%s)").format(
                _table("mis_user_reports")
            ),
            [(user_id, key) for key in reports],
        )


def create_user(username: str, full_name: str, role: str, reports: list[str]) -> dict:
    try:
        with mis_conn() as conn, conn.cursor() as cur:
            cur.execute(
                sql.SQL("""INSERT INTO {} (username, full_name, role)
                            VALUES (lower(%s),%s,%s) RETURNING *""").format(_table("mis_users")),
                (username.strip(), full_name, role),
            )
            row = cur.fetchone()
            _save_reports(cur, row["id"], reports)
            conn.commit()
            return _with_reports(row, cur)
    except psycopg2.errors.UniqueViolation as exc:
        raise ValueError("User already has MIS access") from exc
    except psycopg2.Error as exc:
        raise MisStoreError("Unable to create MIS user") from exc


def update_user(user_id: int, updates: dict, reports: list[str] | None) -> dict | None:
    allowed = {"role", "is_active", "full_name"}
    clean = {key: value for key, value in updates.items() if key in allowed}
    with mis_conn() as conn, conn.cursor() as cur:
        if clean:
            assignments = sql.SQL(", ").join(
                sql.SQL("{}=%s").format(sql.Identifier(key)) for key in clean
            )
            cur.execute(
                sql.SQL("UPDATE {} SET {}, updated_at=now() WHERE id=%s RETURNING *").format(
                    _table("mis_users"), assignments
                ),
                (*clean.values(), user_id),
            )
            row = cur.fetchone()
        else:
            cur.execute(sql.SQL("SELECT * FROM {} WHERE id=%s").format(_table("mis_users")), (user_id,))
            row = cur.fetchone()
        if not row:
            return None
        if reports is not None:
            _save_reports(cur, user_id, reports)
        if clean.get("is_active") is False:
            cur.execute(
                sql.SQL("UPDATE {} SET revoked_at=now() WHERE user_id=%s AND revoked_at IS NULL").format(
                    _table("mis_sessions")
                ),
                (user_id,),
            )
        conn.commit()
        return _with_reports(row, cur)


def create_session(user_id: int, ip_address: str | None, user_agent: str | None) -> str:
    token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expires = datetime.now(timezone.utc) + timedelta(minutes=SESSION_TIMEOUT_MINUTES)
    with mis_conn() as conn, conn.cursor() as cur:
        cur.execute(
            sql.SQL("DELETE FROM {} WHERE expires_at < now()-interval '30 days'").format(
                _table("mis_sessions")
            )
        )
        cur.execute(
            sql.SQL("""INSERT INTO {} (token_hash,user_id,expires_at,ip_address,user_agent)
                        VALUES (%s,%s,%s,%s,%s)""").format(_table("mis_sessions")),
            (token_hash, user_id, expires, ip_address, (user_agent or "")[:500]),
        )
        cur.execute(sql.SQL("UPDATE {} SET last_login=now() WHERE id=%s").format(_table("mis_users")), (user_id,))
        conn.commit()
    return token


def session_user(token: str) -> dict | None:
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with mis_conn() as conn, conn.cursor() as cur:
        cur.execute(
            sql.SQL("""SELECT u.* FROM {} s JOIN {} u ON u.id=s.user_id
                         WHERE s.token_hash=%s AND s.revoked_at IS NULL
                           AND s.expires_at>now()
                           AND s.last_seen_at > now()-(%s * interval '1 minute')
                           AND u.is_active=true""").format(
                _table("mis_sessions"), _table("mis_users")
            ),
            (token_hash, SESSION_TIMEOUT_MINUTES),
        )
        row = cur.fetchone()
        if row:
            cur.execute(
                sql.SQL("""UPDATE {} SET last_seen_at=now(),
                            expires_at=now()+(%s * interval '1 minute')
                            WHERE token_hash=%s""").format(
                    _table("mis_sessions")
                ),
                (SESSION_TIMEOUT_MINUTES, token_hash),
            )
            conn.commit()
            return _with_reports(row, cur)
        return None


def revoke_session(token: str) -> None:
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with mis_conn() as conn, conn.cursor() as cur:
        cur.execute(
            sql.SQL("UPDATE {} SET revoked_at=now() WHERE token_hash=%s AND revoked_at IS NULL").format(
                _table("mis_sessions")
            ),
            (token_hash,),
        )
        conn.commit()


def audit_login(username: str, success: bool, reason: str, ip_address: str | None) -> None:
    try:
        with mis_conn() as conn, conn.cursor() as cur:
            cur.execute(
                sql.SQL("INSERT INTO {} (username,success,reason,ip_address) VALUES (lower(%s),%s,%s,%s)").format(
                    _table("mis_login_audit")
                ),
                (username.strip(), success, reason[:100], ip_address),
            )
            conn.commit()
    except MisStoreError:
        raise
    except psycopg2.Error:
        # Audit failure must not reveal internals or replace the real auth outcome.
        pass
