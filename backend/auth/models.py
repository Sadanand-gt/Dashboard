from typing import Optional

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: str
    scope_level: Optional[str] = None
    scope_value: Optional[str] = None
    allowed_reports: list[str] = Field(default_factory=lambda: ["*"])
    designation_type: Optional[str] = None
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
    role: str = "officer"
    reports: Optional[list[str]] = None


class UserUpdate(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None
    reports: Optional[list[str]] = None
