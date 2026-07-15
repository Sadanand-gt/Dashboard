"""
scheduler.py — Daily pipeline scheduler.

Runs the full pipeline every day at 06:00 AM.
Keep this process alive on the server (or use Windows Task Scheduler / cron).

Usage:
    python scheduler.py
"""

import logging
import sys
import os
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.events import EVENT_JOB_EXECUTED, EVENT_JOB_ERROR

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.runner import run_pipeline

# ── Logging ───────────────────────────────────────────────────────────────────
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, "scheduler.log")),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(__name__)


# ── Event listeners ───────────────────────────────────────────────────────────
def on_job_done(event):
    if event.exception:
        log.error(f"❌ Scheduled job FAILED: {event.exception}")
    else:
        log.info("✅ Scheduled job completed successfully")


# ── Scheduler setup ───────────────────────────────────────────────────────────
scheduler = BlockingScheduler(timezone="Asia/Kolkata")   # IST

# Primary daily run at 06:00 AM IST
scheduler.add_job(
    run_pipeline,
    trigger="cron",
    hour=6,
    minute=0,
    id="daily_pipeline",
    name="Ananya MIS Daily Pipeline",
    misfire_grace_time=300,   # allow up to 5 min late start
    replace_existing=True,
)

scheduler.add_listener(on_job_done, EVENT_JOB_EXECUTED | EVENT_JOB_ERROR)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("⏰ Ananya MIS Scheduler started")
    log.info("   Daily pipeline fires at 06:00 AM IST")
    log.info("   Press Ctrl+C to stop\n")
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        log.info("Scheduler stopped.")
