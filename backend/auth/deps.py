from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from core.config import SECRET_KEY, ALGORITHM
from core.db import users_conn
from core.reports_catalog import report_for_path

bearer = HTTPBearer()

ROLE_HIERARCHY = ["branch_user", "analyst", "manager", "admin"]


def get_current_user(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: int = int(payload.get("sub"))
    except (JWTError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    with users_conn() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE id=? AND is_active=1", (user_id,)
        ).fetchone()

    if not row:
        raise HTTPException(status_code=401, detail="User not found or inactive")

    return dict(row)


def require_role(*allowed_roles: str):
    def _dep(user: dict = Depends(get_current_user)) -> dict:
        if user["role"] not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail=f"Access denied. Required: {', '.join(allowed_roles)}"
            )
        return user
    return _dep


require_admin = require_role("admin")
require_manager_or_above = require_role("admin", "manager")
require_analyst_or_above = require_role("admin", "manager", "analyst")


async def report_gate(request: Request, user: dict = Depends(get_current_user)) -> dict:
    """Runs before every /api endpoint (router-wide dependency in main.py).

    1. Stores the user in core.request_ctx so read_report applies the
       row-level data scope automatically.
       (Must be async: a sync dependency runs in a threadpool with a COPY
       of the context, and the contextvar set would be lost.)
    2. Rejects calls to reports outside the user's whitelist: the request
       path maps to a report key (core/reports_catalog.PATH_REPORT_MAP)
       that must intersect the whitelist. Admins and users with no
       whitelist rows pass everything; unmapped paths (filters, health)
       stay open to authenticated users.
    """
    from core.request_ctx import current_user
    current_user.set(user)

    if user["role"] == "admin":
        return user
    needed = report_for_path(request.url.path)
    if needed is None:
        return user
    with users_conn() as conn:
        allowed = {r[0] for r in conn.execute(
            "SELECT report_key FROM user_reports WHERE user_id=?", (user["id"],)
        )}
    if not allowed or needed & allowed:   # no rows stored = all reports allowed
        return user
    raise HTTPException(status_code=403, detail="This report is not enabled for your account")
