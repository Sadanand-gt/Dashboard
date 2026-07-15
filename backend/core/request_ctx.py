"""
core/request_ctx.py — per-request context.

report_gate (auth/deps.py) stores the authenticated user here at the start
of every /api request; read_report (core/db.py) picks it up to apply the
row-level data scope automatically. Each request runs in its own asyncio
task, so the contextvar is isolated between concurrent requests.
"""

from contextvars import ContextVar
from typing import Optional

current_user: ContextVar[Optional[dict]] = ContextVar("current_user", default=None)
