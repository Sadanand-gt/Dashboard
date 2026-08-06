"""Read-only access to Ananya Sathi identities and hierarchy assignments."""

from contextlib import contextmanager
from typing import Iterable

import psycopg2
from psycopg2 import sql
from psycopg2.extras import RealDictCursor

from core.config import (
    IDENTITY_PG_DBNAME,
    IDENTITY_PG_HOST,
    IDENTITY_PG_PASSWORD,
    IDENTITY_PG_PORT,
    IDENTITY_PG_SCHEMA,
    IDENTITY_PG_USER,
)
from .passwords import verify_django_password


class IdentityStoreError(RuntimeError):
    pass


@contextmanager
def identity_conn():
    try:
        conn = psycopg2.connect(
            host=IDENTITY_PG_HOST,
            port=IDENTITY_PG_PORT,
            dbname=IDENTITY_PG_DBNAME,
            user=IDENTITY_PG_USER,
            password=IDENTITY_PG_PASSWORD,
            connect_timeout=8,
            cursor_factory=RealDictCursor,
            options="-c statement_timeout=15000 -c default_transaction_read_only=on",
        )
    except psycopg2.Error as exc:
        raise IdentityStoreError("Ananya Sathi identity database is unavailable") from exc
    try:
        yield conn
    finally:
        conn.close()


def _profile_query():
    return sql.SQL("""
        SELECT p.id, p.username, p.password, p.first_name, p.last_name,
               p.is_active, p.designation_type, p.branch, p.area_id,
               p.zone_id, p.last_login, e.employee_name
          FROM {schema}.home_profile p
          LEFT JOIN {schema}.home_employee_master e ON e.employee_id = p.user_id
    """).format(schema=sql.Identifier(IDENTITY_PG_SCHEMA))


def get_profile(username: str) -> dict | None:
    username = username.strip().lower()
    try:
        with identity_conn() as conn, conn.cursor() as cur:
            cur.execute(
                _profile_query()
                + sql.SQL(" WHERE lower(p.username) = %s ORDER BY p.id LIMIT 1"),
                (username,),
            )
            row = cur.fetchone()
            return dict(row) if row else None
    except psycopg2.Error as exc:
        raise IdentityStoreError("Unable to read Ananya Sathi identity") from exc


def get_profiles(usernames: Iterable[str]) -> dict[str, dict]:
    names = sorted({str(name).strip().lower() for name in usernames if name})
    if not names:
        return {}
    try:
        with identity_conn() as conn, conn.cursor() as cur:
            cur.execute(
                _profile_query()
                + sql.SQL(" WHERE lower(p.username) = ANY(%s)"),
                (names,),
            )
            return {str(row["username"]).lower(): dict(row) for row in cur.fetchall()}
    except psycopg2.Error as exc:
        raise IdentityStoreError("Unable to read Ananya Sathi identities") from exc


def authenticate(username: str, password: str) -> dict | None:
    profile = get_profile(username)
    if not profile or not profile.get("is_active"):
        return None
    return profile if verify_django_password(password, profile.get("password", "")) else None


def _master_name(table: str, id_column: str, name_column: str, value: str) -> str | None:
    if not value:
        return None
    query = sql.SQL("SELECT {name} FROM {schema}.{table} WHERE {id_col} = %s LIMIT 1").format(
        name=sql.Identifier(name_column),
        schema=sql.Identifier(IDENTITY_PG_SCHEMA),
        table=sql.Identifier(table),
        id_col=sql.Identifier(id_column),
    )
    try:
        with identity_conn() as conn, conn.cursor() as cur:
            cur.execute(query, (str(value).strip(),))
            row = cur.fetchone()
            return str(row[name_column]).strip() if row and row.get(name_column) else None
    except psycopg2.Error as exc:
        raise IdentityStoreError("Unable to resolve Ananya Sathi hierarchy") from exc


def hierarchy_scope(profile: dict) -> tuple[str, str | None]:
    """Translate the exact Sathi designation hierarchy into dashboard scope."""
    designation = str(profile.get("designation_type") or "").strip().upper()
    if designation == "HO":
        return "ho", None

    if designation == "B":
        value = profile.get("branch")
        return "branch", str(value).strip() if value else None

    if designation == "T":
        raw = profile.get("area_id")
        name = _master_name("home_area_master", "area_id", "area_name", raw)
        return "area", name or (str(raw).strip() if raw else None)

    if designation == "R":
        raw = profile.get("branch")
        name = _master_name("home_brnch_master", "branch_id", "branch_name", raw)
        return "region", name or (str(raw).strip() if raw else None)

    if designation == "DC":
        raw = profile.get("area_id")
        name = _master_name("home_area_master", "area_id", "area_name", raw)
        return "cluster", name or (str(raw).strip() if raw else None)

    if designation == "Z":
        # Sathi has legacy Z profiles where zone_id is blank but the same Z-code
        # is present in area_id. BranchMasterView also treats the profile as zone.
        raw = profile.get("zone_id") or profile.get("area_id")
        name = _master_name("home_area_master", "area_id", "area_name", raw)
        return "zone", name or (str(raw).strip() if raw else None)

    # Unknown/missing Sathi hierarchy must never receive organisation-wide data.
    return "branch", "__NO_SCOPE__"


def display_name(profile: dict) -> str:
    name = " ".join(
        part.strip() for part in (profile.get("first_name") or "", profile.get("last_name") or "")
        if part.strip()
    )
    return name or str(profile.get("employee_name") or profile.get("username") or "User").strip()


def effective_user(mis_user: dict, profile: dict) -> dict:
    level, value = hierarchy_scope(profile)
    user = dict(mis_user)
    user.update(
        full_name=display_name(profile),
        scope_level=level,
        scope_value=value,
        designation_type=profile.get("designation_type"),
        identity_active=bool(profile.get("is_active")),
        cluster_id=None,
        region_id=None,
        area_id=profile.get("area_id"),
        branch_id=profile.get("branch"),
    )
    return user
