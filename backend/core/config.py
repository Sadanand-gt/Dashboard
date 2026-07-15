import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent.parent
load_dotenv(BASE_DIR / ".env")

SECRET_KEY = os.getenv("SECRET_KEY", "ananya-mis-jwt-secret-2024-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("TOKEN_EXPIRE_MINUTES", "480"))  # 8 hours

SQLITE_PATH = str(BASE_DIR / "reports.db")
USERS_DB_PATH = str(BASE_DIR / "users.db")

# ── Report store: sqlite (reports.db) or postgres (DBA-created tables) ────────
REPORT_BACKEND = os.getenv("REPORT_BACKEND", "sqlite").strip().lower()
REPORT_PG_HOST = os.getenv("REPORT_PG_HOST", "")
REPORT_PG_PORT = os.getenv("REPORT_PG_PORT", "5432")
REPORT_PG_DBNAME = os.getenv("REPORT_PG_DBNAME", "")
REPORT_PG_SCHEMA = os.getenv("REPORT_PG_SCHEMA", "public").strip() or "public"
REPORT_PG_USER = os.getenv("REPORT_PG_USER", "")
REPORT_PG_PASSWORD = os.getenv("REPORT_PG_PASSWORD", "")

CORS_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
]
