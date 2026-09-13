from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from core.reports_catalog import report_for_path
from .identity import IdentityStoreError, effective_user, get_profile
from .store import MisStoreError, session_user

bearer = HTTPBearer()


def get_current_user(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    try:
        mis_user = session_user(creds.credentials)
        if not mis_user:
            raise HTTPException(status_code=401, detail="Invalid or expired session")
        profile = get_profile(mis_user["username"])
    except (IdentityStoreError, MisStoreError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if not profile or not profile.get("is_active"):
        raise HTTPException(status_code=401, detail="Ananya Sathi account is inactive or unavailable")
    return effective_user(mis_user, profile)


def require_role(*allowed_roles: str):
    def _dep(user: dict = Depends(get_current_user)) -> dict:
        if user["role"] not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail=f"Access denied. Required: {', '.join(allowed_roles)}",
            )
        return user
    return _dep


require_admin = require_role("admin")
require_manager_or_above = require_role("admin", "manager")
require_officer_or_above = require_role("admin", "manager", "officer")


def require_export(user: dict = Depends(get_current_user)) -> dict:
    """Allow download endpoints only when an MIS admin granted CSV export."""
    if not user.get("can_export"):
        raise HTTPException(status_code=403, detail="CSV export is not enabled for your account")
    return user


async def report_gate(request: Request, user: dict = Depends(get_current_user)) -> dict:
    """Apply report grants and install the Sathi-derived row scope."""
    from core.request_ctx import current_user

    current_user.set(user)
    needed = report_for_path(request.url.path)
    if needed is None:
        return user
    allowed = set(user.get("allowed_reports") or ["*"])
    if "*" in allowed or needed & allowed:
        return user
    raise HTTPException(status_code=403, detail="This report is not enabled for your account")
