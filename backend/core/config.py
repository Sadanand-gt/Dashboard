import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent.parent
load_dotenv(BASE_DIR / ".env")

# Sliding idle timeout. Every authenticated API call extends the session by this
# amount; no request for this long expires it server-side.
SESSION_TIMEOUT_MINUTES = max(1, int(os.getenv("SESSION_TIMEOUT_MINUTES", "15")))

SQLITE_PATH = str(BASE_DIR / "reports.db")

# ── Report store: sqlite (reports.db) or postgres (DBA-created tables) ────────
REPORT_BACKEND = os.getenv("REPORT_BACKEND", "sqlite").strip().lower()
REPORT_PG_HOST = os.getenv("REPORT_PG_HOST", "")
REPORT_PG_PORT = os.getenv("REPORT_PG_PORT", "5432")
REPORT_PG_DBNAME = os.getenv("REPORT_PG_DBNAME", "")
REPORT_PG_SCHEMA = os.getenv("REPORT_PG_SCHEMA", "public").strip() or "public"
REPORT_PG_USER = os.getenv("REPORT_PG_USER", "")
REPORT_PG_PASSWORD = os.getenv("REPORT_PG_PASSWORD", "")

# Shared Ananya Sathi identity store (read-only from this application).
IDENTITY_PG_HOST = os.getenv("IDENTITY_PG_HOST", os.getenv("PG_HOST", ""))
IDENTITY_PG_PORT = os.getenv("IDENTITY_PG_PORT", os.getenv("PG_PORT", "5432"))
IDENTITY_PG_DBNAME = os.getenv("IDENTITY_PG_DBNAME", "Ananya_app_prod")
IDENTITY_PG_SCHEMA = os.getenv("IDENTITY_PG_SCHEMA", "public").strip() or "public"
IDENTITY_PG_USER = os.getenv("IDENTITY_PG_USER", os.getenv("PG_USER", ""))
IDENTITY_PG_PASSWORD = os.getenv("IDENTITY_PG_PASSWORD", os.getenv("PG_PASSWORD", ""))

# MIS-only authorization and session store. Passwords are never copied here.
MIS_PG_HOST = os.getenv("MIS_PG_HOST", os.getenv("REPORT_PG_HOST", os.getenv("PG_HOST", "")))
MIS_PG_PORT = os.getenv("MIS_PG_PORT", os.getenv("REPORT_PG_PORT", os.getenv("PG_PORT", "5432")))
MIS_PG_DBNAME = os.getenv("MIS_PG_DBNAME", "ananya_mis_dashboard")
MIS_PG_SCHEMA = os.getenv("MIS_PG_SCHEMA", "public").strip() or "public"
MIS_PG_USER = os.getenv("MIS_PG_USER", os.getenv("REPORT_PG_USER", os.getenv("PG_USER", "")))
MIS_PG_PASSWORD = os.getenv("MIS_PG_PASSWORD", os.getenv("REPORT_PG_PASSWORD", os.getenv("PG_PASSWORD", "")))
MIS_BOOTSTRAP_ADMIN_USERNAME = os.getenv("MIS_BOOTSTRAP_ADMIN_USERNAME", "").strip()

CORS_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
]
