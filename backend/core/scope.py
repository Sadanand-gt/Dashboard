"""
core/scope.py — row-level data access control (hierarchy scope).

Hierarchy: LO → Branch → Area/Unit → Region → Cluster → Zone → HO.
A user carries scope_level + scope_value (comma-separated for multi):
    ho / blank                → sees everything (HO-level user)
    zone|cluster|region|area  → only rows in their zone/cluster/region/area
    branch                    → only their branch (by branch_id)
    lo                        → only their loans (by lo_id)

Every report endpoint passes its DataFrame through scope_df(df, user).

Column availability differs per table, so enforcement is layered:
  1. If the scope level's own column exists in the table → filter directly.
  2. Otherwise resolve the scope to a SET OF branch_ids via rpt_aum_status
     (which carries the full hierarchy) and filter on branch_id — present in
     every dashboard table except the two below.
  3. Tables with no geography at all (rpt_trend_monthly, rpt_disb_daily)
     return EMPTY for scoped users — never leak org-wide numbers.

NB: for LO users, tables without an lo_id column fall back to their branch
(the smallest slice those tables carry).
"""

import time
from typing import Optional

import pandas as pd

from .db import reports_conn

# scope level → the report-table column that carries it
LEVEL_COL = {
    "lo":      "lo_id",
    "branch":  "branch_id",
    "area":    "area_name",
    "region":  "region_name",
    "cluster": "cluster_name",
    "zone":    "zone_name",
}
SCOPE_LEVELS = ["ho", "zone", "cluster", "region", "area", "branch", "lo"]

_CACHE_TTL = 600  # seconds — hierarchy mapping changes only when the pipeline runs
_branch_cache: dict = {}


def _norm(s: pd.Series) -> pd.Series:
    """Normalize ids/names for comparison: str, trimmed, no float '.0' tails."""
    return s.astype(str).str.strip().str.replace(r"\.0$", "", regex=True)


def _vals(raw: Optional[str]) -> list[str]:
    """Parse a comma-separated scope_value into clean strings."""
    if raw is None:
        return []
    out = []
    for v in str(raw).split(","):
        v = v.strip()
        if v.endswith(".0"):
            v = v[:-2]
        if v:
            out.append(v)
    return out


def _branch_ids_for(level: str, values: tuple) -> set:
    """Resolve a scope (level, values) to the set of branch_ids under it,
    using rpt_aum_status (full hierarchy). Cached with a short TTL."""
    key = (level, values)
    hit = _branch_cache.get(key)
    now = time.time()
    if hit and now - hit[1] < _CACHE_TTL:
        return hit[0]

    col = LEVEL_COL[level]
    try:
        with reports_conn() as conn:
            df = pd.read_sql(
                f"SELECT DISTINCT {col} AS v, branch_id FROM rpt_aum_status", conn
            )
        ids = set(_norm(df.loc[_norm(df["v"]).isin(values), "branch_id"]))
    except Exception:
        ids = set()          # table/column missing → resolve to nothing (safe)
    _branch_cache[key] = (ids, now)
    return ids


def user_scope(user: dict) -> tuple[str, list[str]]:
    """Effective (level, values) for a user. ('', []) = unrestricted."""
    level = (user.get("scope_level") or "").strip().lower()
    values = _vals(user.get("scope_value"))
    if level in ("", "ho", "all") or not values:
        # legacy scaffold: branch_user role with a branch_id set on the user
        if user.get("role") == "branch_user" and user.get("branch_id"):
            return "branch", [str(user["branch_id"])]
        return "", []
    if level not in LEVEL_COL:
        return "", []
    return level, values


def scope_df(df: pd.DataFrame, user: dict) -> pd.DataFrame:
    """Restrict a report DataFrame to the user's data scope."""
    if df is None or df.empty:
        return df
    level, values = user_scope(user)
    if not level:
        return df

    col = LEVEL_COL[level]
    if col in df.columns:
        return df[_norm(df[col]).isin(values)]

    # level column absent → fall back to the branch set under the scope
    if "branch_id" in df.columns:
        ids = _branch_ids_for(level, tuple(sorted(values)))
        return df[_norm(df["branch_id"]).isin(ids)]

    # no geography at all → return empty rather than org-wide data
    return df.iloc[0:0]
