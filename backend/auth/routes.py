from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials

from core.reports_catalog import REPORT_CATALOG, REPORT_KEYS
from .deps import bearer, get_current_user, require_admin
from .identity import (
    IdentityStoreError,
    authenticate,
    display_name,
    effective_user,
    get_profile,
    get_profiles,
)
from .models import LoginRequest, Token, UserCreate, UserOut, UserUpdate
from .store import (
    MisStoreError,
    audit_login,
    create_session,
    create_user as store_create_user,
    get_user,
    get_user_by_username,
    list_users as store_list_users,
    revoke_session,
    update_user as store_update_user,
)

router = APIRouter()
ROLES = ["admin", "manager", "officer", "branch_user"]


def _client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return forwarded or (request.client.host if request.client else None)


def _validate_reports(reports: list[str] | None) -> list[str] | None:
    if reports is None:
        return None
    bad = sorted(set(reports) - set(REPORT_KEYS))
    if bad:
        raise HTTPException(status_code=400, detail=f"Unknown report keys: {bad}")
    return sorted(set(reports))


def _as_out(mis_user: dict, profile: dict) -> UserOut:
    user = effective_user(mis_user, profile)
    user["is_active"] = bool(mis_user.get("is_active") and profile.get("is_active"))
    if user.get("last_login") is not None:
        user["last_login"] = user["last_login"].isoformat()
    return UserOut(**user)


@router.post("/login", response_model=Token)
def login(body: LoginRequest, request: Request):
    username = body.username.strip()
    ip = _client_ip(request)
    try:
        profile = authenticate(username, body.password)
        if not profile:
            audit_login(username, False, "invalid_identity_credentials", ip)
            raise HTTPException(status_code=401, detail="Invalid username or password")

        mis_user = get_user_by_username(profile["username"])
        if not mis_user or not mis_user.get("is_active"):
            audit_login(username, False, "mis_access_not_assigned", ip)
            raise HTTPException(status_code=403, detail="MIS access is not assigned. Contact the MIS administrator.")

        token = create_session(
            mis_user["id"], ip, request.headers.get("user-agent")
        )
        audit_login(username, True, "success", ip)
        return Token(access_token=token, user=_as_out(mis_user, profile))
    except HTTPException:
        raise
    except (IdentityStoreError, MisStoreError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/logout", status_code=204)
def logout(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    _: dict = Depends(get_current_user),
):
    try:
        revoke_session(creds.credentials)
    except MisStoreError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/me", response_model=UserOut)
def me(user: dict = Depends(get_current_user)):
    if user.get("last_login") is not None and not isinstance(user["last_login"], str):
        user["last_login"] = user["last_login"].isoformat()
    return UserOut(**user)


@router.get("/users", response_model=list[UserOut])
def list_users(_: dict = Depends(require_admin)):
    try:
        users = store_list_users()
        profiles = get_profiles(user["username"] for user in users)
        result = []
        for user in users:
            profile = profiles.get(user["username"].lower())
            if profile:
                result.append(_as_out(user, profile))
            else:
                result.append(UserOut(
                    id=user["id"], username=user["username"],
                    full_name=user.get("full_name") or user["username"], role=user["role"],
                    scope_level="branch", scope_value="__NO_SCOPE__",
                    allowed_reports=user.get("allowed_reports") or ["*"],
                    is_active=False,
                    last_login=user["last_login"].isoformat() if user.get("last_login") else None,
                ))
        return result
    except (IdentityStoreError, MisStoreError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, _: dict = Depends(require_admin)):
    if body.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Choose: {ROLES}")
    reports = _validate_reports(body.reports) or []
    try:
        profile = get_profile(body.username)
        if not profile:
            raise HTTPException(status_code=404, detail="Username not found in Ananya Sathi")
        if not profile.get("is_active"):
            raise HTTPException(status_code=400, detail="Ananya Sathi user is inactive")
        mis_user = store_create_user(
            profile["username"], display_name(profile), body.role, reports
        )
        return _as_out(mis_user, profile)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except HTTPException:
        raise
    except (IdentityStoreError, MisStoreError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.put("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, _: dict = Depends(require_admin)):
    if body.role is not None and body.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Choose: {ROLES}")
    reports = _validate_reports(body.reports)
    updates = body.model_dump(exclude_unset=True, exclude={"reports"})
    if not updates and reports is None:
        raise HTTPException(status_code=400, detail="No updates provided")
    try:
        mis_user = store_update_user(user_id, updates, reports)
        if not mis_user:
            raise HTTPException(status_code=404, detail="User not found")
        profile = get_profile(mis_user["username"])
        if not profile:
            raise HTTPException(status_code=409, detail="Ananya Sathi identity no longer exists")
        return _as_out(mis_user, profile)
    except HTTPException:
        raise
    except (IdentityStoreError, MisStoreError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.delete("/users/{user_id}")
def deactivate_user(user_id: int, current: dict = Depends(require_admin)):
    if user_id == current["id"]:
        raise HTTPException(status_code=400, detail="Cannot deactivate yourself")
    try:
        if not get_user(user_id):
            raise HTTPException(status_code=404, detail="User not found")
        store_update_user(user_id, {"is_active": False}, None)
        return {"message": "User deactivated and active sessions revoked"}
    except HTTPException:
        raise
    except MisStoreError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/reports")
def report_catalog(_: dict = Depends(get_current_user)):
    return REPORT_CATALOG
