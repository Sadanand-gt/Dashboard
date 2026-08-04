from fastapi import APIRouter, HTTPException, Depends, Query
from datetime import datetime, timedelta, timezone
from jose import jwt
import bcrypt
import pandas as pd
from .models import LoginRequest, Token, UserOut, UserCreate, UserUpdate
from .deps import get_current_user, require_admin, require_manager_or_above
from core.config import SECRET_KEY, ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES
from core.db import users_conn, init_users_db, reports_conn
from core.reports_catalog import REPORT_CATALOG, REPORT_KEYS
from core.scope import LEVEL_COL, SCOPE_LEVELS

router = APIRouter()


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _verify(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())

ROLES = ["admin", "manager", "officer", "branch_user"]


def _create_token(user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": str(user_id), "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def _allowed_reports(user_id: int, role: str) -> list[str]:
    """Report whitelist for a user. ["*"] = all (admin, or no rows stored)."""
    if role == "admin":
        return ["*"]
    with users_conn() as conn:
        keys = [r[0] for r in conn.execute(
            "SELECT report_key FROM user_reports WHERE user_id=?", (user_id,)
        )]
    return keys if keys else ["*"]


def _save_reports(user_id: int, reports: list[str]) -> None:
    """Persist a report whitelist. Empty list clears it (= all allowed)."""
    bad = [k for k in reports if k not in REPORT_KEYS]
    if bad:
        raise HTTPException(status_code=400, detail=f"Unknown report keys: {bad}")
    with users_conn() as conn:
        conn.execute("DELETE FROM user_reports WHERE user_id=?", (user_id,))
        conn.executemany(
            "INSERT INTO user_reports (user_id, report_key) VALUES (?,?)",
            [(user_id, k) for k in reports],
        )
        conn.commit()


def _row_to_user(row: dict) -> UserOut:
    return UserOut(
        id=row["id"],
        username=row["username"],
        full_name=row["full_name"],
        role=row["role"],
        scope_level=row.get("scope_level"),
        scope_value=row.get("scope_value"),
        allowed_reports=_allowed_reports(row["id"], row["role"]),
        cluster_id=row.get("cluster_id"),
        region_id=row.get("region_id"),
        area_id=row.get("area_id"),
        branch_id=row.get("branch_id"),
        is_active=bool(row["is_active"]),
        last_login=row.get("last_login"),
    )


@router.post("/login", response_model=Token)
def login(req: LoginRequest):
    with users_conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username=? COLLATE NOCASE AND is_active=1",
            (req.username.strip(),),
        ).fetchone()

    if not row or not _verify(req.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    row = dict(row)
    with users_conn() as conn:
        conn.execute(
            "UPDATE users SET last_login=? WHERE id=?",
            (datetime.now(timezone.utc).isoformat(), row["id"]),
        )
        conn.commit()

    return Token(access_token=_create_token(row["id"]), user=_row_to_user(row))


@router.get("/me", response_model=UserOut)
def me(user: dict = Depends(get_current_user)):
    return _row_to_user(user)


# ── User Management (admin only) ──────────────────────────────────────────────

@router.get("/users", response_model=list[UserOut])
def list_users(_: dict = Depends(require_admin)):
    with users_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM users ORDER BY id"
        ).fetchall()
    return [_row_to_user(dict(r)) for r in rows]


def _clean_scope(level, value):
    """Normalize a scope pair. 'ho'/blank level = unrestricted (both NULL)."""
    level = (level or "").strip().lower()
    if level in ("", "ho", "all"):
        return None, None
    if level not in LEVEL_COL:
        raise HTTPException(
            status_code=400, detail=f"Invalid scope_level. Choose: {SCOPE_LEVELS}")
    value = (value or "").strip()
    if not value:
        raise HTTPException(
            status_code=400, detail=f"scope_value is required for scope_level '{level}'")
    return level, value


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, _: dict = Depends(require_admin)):
    if body.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Choose: {ROLES}")
    scope_level, scope_value = _clean_scope(body.scope_level, body.scope_value)

    hashed = _hash(body.password)
    with users_conn() as conn:
        try:
            conn.execute(
                """INSERT INTO users
                   (username, password_hash, full_name, role,
                    scope_level, scope_value,
                    cluster_id, region_id, area_id, branch_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (body.username, hashed, body.full_name, body.role,
                 scope_level, scope_value,
                 body.cluster_id, body.region_id, body.area_id, body.branch_id),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM users WHERE username=?", (body.username,)
            ).fetchone()
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=409, detail="Username already exists")

    if body.reports is not None:
        _save_reports(row["id"], body.reports)
    return _row_to_user(dict(row))


@router.put("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, _: dict = Depends(require_admin)):
    updates: dict = {}
    if body.full_name is not None:
        updates["full_name"] = body.full_name
    if body.role is not None:
        if body.role not in ROLES:
            raise HTTPException(status_code=400, detail=f"Invalid role. Choose: {ROLES}")
        updates["role"] = body.role
    if body.is_active is not None:
        updates["is_active"] = int(body.is_active)
    if body.password is not None:
        updates["password_hash"] = _hash(body.password)
    if body.scope_level is not None:
        # "" or "ho" clears the scope entirely
        lvl, val = _clean_scope(body.scope_level, body.scope_value)
        updates["scope_level"] = lvl
        updates["scope_value"] = val
    elif body.scope_value is not None:
        updates["scope_value"] = body.scope_value.strip() or None
    if body.cluster_id is not None:
        updates["cluster_id"] = body.cluster_id
    if body.region_id is not None:
        updates["region_id"] = body.region_id
    if body.area_id is not None:
        updates["area_id"] = body.area_id
    if body.branch_id is not None:
        updates["branch_id"] = body.branch_id

    if not updates and body.reports is None:
        raise HTTPException(status_code=400, detail="No updates provided")

    with users_conn() as conn:
        if updates:
            set_clause = ", ".join(f"{k}=?" for k in updates)
            conn.execute(
                f"UPDATE users SET {set_clause} WHERE id=?",
                (*updates.values(), user_id),
            )
            conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    if body.reports is not None:
        _save_reports(user_id, body.reports)
    return _row_to_user(dict(row))


@router.delete("/users/{user_id}")
def deactivate_user(user_id: int, current: dict = Depends(require_admin)):
    if user_id == current["id"]:
        raise HTTPException(status_code=400, detail="Cannot deactivate yourself")
    with users_conn() as conn:
        conn.execute("UPDATE users SET is_active=0 WHERE id=?", (user_id,))
        conn.commit()
    return {"message": "User deactivated"}


# ── Access-control metadata (admin UI) ────────────────────────────────────────

@router.get("/reports")
def report_catalog(_: dict = Depends(get_current_user)):
    """The full report catalog (for the admin report-visibility checkboxes)."""
    return REPORT_CATALOG


@router.get("/scope-options")
def scope_options(
    level: str = Query(..., description="zone|cluster|region|area|branch|lo"),
    _: dict = Depends(require_admin),
):
    """Distinct values for a hierarchy level (populates the scope dropdown).
    Branches return value=branch_id with a name label; LOs return lo_id."""
    level = level.strip().lower()
    col = LEVEL_COL.get(level)
    if not col:
        raise HTTPException(
            status_code=400, detail=f"Invalid level. Choose: {list(LEVEL_COL)}")
    try:
        with reports_conn() as conn:
            if level == "branch":
                df = pd.read_sql(
                    "SELECT DISTINCT branch_id AS value, branch_name AS label "
                    "FROM rpt_aum_status WHERE branch_id IS NOT NULL", conn)
            else:
                df = pd.read_sql(
                    f"SELECT DISTINCT {col} AS value FROM rpt_aum_status "
                    f"WHERE {col} IS NOT NULL", conn)
                df["label"] = df["value"]
    except Exception:
        return []
    df["value"] = df["value"].astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
    df["label"] = df["label"].astype(str).str.strip()
    if level == "branch":
        df["label"] = df["value"] + " — " + df["label"]
    df = df[df["value"].ne("") & df["value"].ne("None")].drop_duplicates("value")
    return df.sort_values("label")[["value", "label"]].to_dict("records")
