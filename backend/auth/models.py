from pydantic import BaseModel
from typing import Optional


class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: str
    # Data scope (hierarchy): ho/zone/cluster/region/area/branch/lo + value(s)
    scope_level: Optional[str] = None
    scope_value: Optional[str] = None
    # Report visibility: ["*"] = all reports, else whitelist of report keys
    allowed_reports: list[str] = ["*"]
    # legacy scope columns (kept for backward compatibility)
    cluster_id: Optional[str] = None
    region_id: Optional[str] = None
    area_id: Optional[str] = None
    branch_id: Optional[str] = None
    is_active: bool
    last_login: Optional[str] = None


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class UserCreate(BaseModel):
    username: str
    password: str
    full_name: str
    role: str = "analyst"
    scope_level: Optional[str] = None      # ho/zone/cluster/region/area/branch/lo
    scope_value: Optional[str] = None      # comma-separated for multi
    reports: Optional[list[str]] = None    # None/[] = all reports allowed
    cluster_id: Optional[str] = None
    region_id: Optional[str] = None
    area_id: Optional[str] = None
    branch_id: Optional[str] = None


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None
    scope_level: Optional[str] = None      # "" or "ho" clears the scope
    scope_value: Optional[str] = None
    reports: Optional[list[str]] = None    # None = unchanged; [] = all allowed
    cluster_id: Optional[str] = None
    region_id: Optional[str] = None
    area_id: Optional[str] = None
    branch_id: Optional[str] = None
