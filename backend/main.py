"""Ananya Finance MIS FastAPI backend."""

import os
import sys
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.ageing import router as ageing_router
from api.aml import router as aml_router
from api.aum import router as aum_router
from api.bucket_movement import router as bucket_movement_router
from api.collection import router as collection_router
from api.disbursement import router as disbursement_router
from api.dq_category import router as dq_category_router
from api.filters import router as filters_router
from api.od_status import router as od_status_router
from api.operations import router as operations_router
from api.pos_par import router as pos_par_router
from api.report_summary import router as report_summary_router
from api.trend import router as trend_router
from api.writeoff import router as writeoff_router
from auth.deps import report_gate
from auth.identity import display_name, get_profile
from auth.routes import router as auth_router
from auth.store import create_user, list_users, verify_schema
from core.config import CORS_ORIGINS, MIS_BOOTSTRAP_ADMIN_USERNAME


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Deliberately verify only. The restricted application account should not own
    # production DDL; apply backend/auth/schema.sql with the database owner first.
    verify_schema()
    users = list_users()
    if not users:
        if not MIS_BOOTSTRAP_ADMIN_USERNAME:
            raise RuntimeError(
                "No MIS users exist. Set MIS_BOOTSTRAP_ADMIN_USERNAME to an active "
                "Ananya Sathi username for the first startup."
            )
        profile = get_profile(MIS_BOOTSTRAP_ADMIN_USERNAME)
        if not profile or not profile.get("is_active"):
            raise RuntimeError("MIS_BOOTSTRAP_ADMIN_USERNAME is not an active Ananya Sathi user")
        create_user(profile["username"], display_name(profile), "admin", [])
    yield


app = FastAPI(title="Ananya Finance MIS API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/auth", tags=["Auth"])
_gated = [Depends(report_gate)]
app.include_router(aum_router, prefix="/api", tags=["AUM"], dependencies=_gated)
app.include_router(aml_router, prefix="/api", tags=["AML"], dependencies=_gated)
app.include_router(collection_router, prefix="/api", tags=["Collection"], dependencies=_gated)
app.include_router(disbursement_router, prefix="/api", tags=["Disbursement"], dependencies=_gated)
app.include_router(ageing_router, prefix="/api", tags=["Ageing"], dependencies=_gated)
app.include_router(bucket_movement_router, prefix="/api", tags=["Bucket Movement"], dependencies=_gated)
app.include_router(od_status_router, prefix="/api", tags=["OD Status"], dependencies=_gated)
app.include_router(dq_category_router, prefix="/api", tags=["DQ Category"], dependencies=_gated)
app.include_router(pos_par_router, prefix="/api", tags=["POS & PAR"], dependencies=_gated)
app.include_router(trend_router, prefix="/api", tags=["Trend"], dependencies=_gated)
app.include_router(report_summary_router, prefix="/api", tags=["Report Summary"], dependencies=_gated)
app.include_router(writeoff_router, prefix="/api", tags=["Write-Off"], dependencies=_gated)
app.include_router(filters_router, prefix="/api", tags=["Filters"], dependencies=_gated)
app.include_router(operations_router, prefix="/api", tags=["Operations"], dependencies=_gated)


@app.get("/health")
def health():
    return {"status": "ok", "service": "Ananya Finance MIS API"}
