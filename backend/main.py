"""
Ananya Finance MIS — FastAPI Backend
Run: uvicorn main:app --reload --port 8000
"""

import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from core.config import CORS_ORIGINS
from core.db import init_users_db
from auth.deps import report_gate
from auth.routes import router as auth_router, _hash, users_conn
from api.aum import router as aum_router
from api.collection import router as collection_router
from api.disbursement import router as disbursement_router
from api.ageing import router as ageing_router
from api.bucket_movement import router as bucket_movement_router
from api.od_status import router as od_status_router
from api.dq_category import router as dq_category_router
from api.pos_par import router as pos_par_router
from api.writeoff import router as writeoff_router
from api.filters import router as filters_router
from api.operations import router as operations_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: init DB and seed default admin
    init_users_db()
    with users_conn() as conn:
        count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if count == 0:
            conn.execute(
                "INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)",
                ("admin", _hash("admin123"), "Administrator", "admin"),
            )
            conn.commit()
            print("✓ Default admin created — username: admin, password: admin123")
    yield


app = FastAPI(
    title="Ananya Finance MIS API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://192.168.1.237:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/auth", tags=["Auth"])

# All data routers pass through report_gate: a user only reaches endpoints
# of reports enabled for their account (see core/reports_catalog.py).
_gated = [Depends(report_gate)]
app.include_router(aum_router, prefix="/api", tags=["AUM"], dependencies=_gated)
app.include_router(collection_router, prefix="/api", tags=["Collection"], dependencies=_gated)
app.include_router(disbursement_router, prefix="/api", tags=["Disbursement"], dependencies=_gated)
app.include_router(ageing_router, prefix="/api", tags=["Ageing"], dependencies=_gated)
app.include_router(bucket_movement_router, prefix="/api", tags=["Bucket Movement"], dependencies=_gated)
app.include_router(od_status_router, prefix="/api", tags=["OD Status"], dependencies=_gated)
app.include_router(dq_category_router, prefix="/api", tags=["DQ Category"], dependencies=_gated)
app.include_router(pos_par_router, prefix="/api", tags=["POS & PAR"], dependencies=_gated)
app.include_router(writeoff_router, prefix="/api", tags=["Write-Off"], dependencies=_gated)
app.include_router(filters_router, prefix="/api", tags=["Filters"], dependencies=_gated)
app.include_router(operations_router, prefix="/api", tags=["Operations"], dependencies=_gated)


@app.get("/health")
def health():
    return {"status": "ok", "service": "Ananya Finance MIS API"}
