"""
filters.py — Global slicer definitions for the dashboard.

Mirrors the "ANALYSIS PARAMETERS" panel from the Excel "June 2026 Dashboards"
(Current Outstanding sheet). Every slicer the management asked for is exposed
here, grouped for the collapsible left rail.

Options are sourced from rpt_aum_status where a matching column already exists.
Slicers whose source column is not yet wired to the warehouse are returned with
available=false and an empty option list (to be connected later — the UI still
shows them so the full management slicer set is visible).
"""

from fastapi import APIRouter, Depends
from core.db import read_report
from auth.deps import get_current_user
import pandas as pd

router = APIRouter()


def _scope(df: pd.DataFrame, user: dict) -> pd.DataFrame:
    # Row-level scope is applied centrally in read_report (core/db.py via
    # core/scope.py) — kept as identity for backward compatibility.
    return df


def _opts(df: pd.DataFrame, col: str) -> list[str]:
    """Distinct, sorted, non-empty option values for a column."""
    if df.empty or col not in df.columns:
        return []
    vals = (
        df[col]
        .dropna()
        .astype(str)
        .map(str.strip)
        .replace("", pd.NA)
        .dropna()
        .unique()
        .tolist()
    )
    vals = [v for v in vals if v not in ("Unassigned", "N/A", "nan")]
    # Numeric slicers (Cycle) must sort 1,2,…,10 — not lexicographically 1,10,11,2
    if vals and all(v.replace(".", "", 1).isdigit() for v in vals):
        return sorted(vals, key=float)
    return sorted(vals)


# Slicer catalogue — grouped exactly like the Excel parameter panel.
# Each entry: (id, label, source column in rpt_aum_status or None if not wired yet)
SLICER_GROUPS = [
    ("Segment & Product", [
        ("segment",         "Business Segment",      "business_segment"),
        ("prod_class",      "Product Classification", "prod_classification"),
    ]),
    ("Geography", [
        ("zone",            "Zone",                  "zone_name"),
        ("cluster",         "Cluster",               "cluster_name"),
        ("region",          "Region",                "region_name"),
        ("unit",            "Unit",                  "area_name"),
        ("branch",          "Branch",                "branch_name"),
        ("branch_state",    "Branch State",          "state_id"),
        ("district",        "District",              "district_id"),
        # Options are "<lo_id> - <NAME>"; the backend matches on the lo_id prefix.
        ("lo",              "LO Name (with ID)",     "lo_name"),
    ]),
    ("Risk / Overdue", [
        # OD Status (Regular / Overdue / NPA / Write-off) is DEACTIVATED for now —
        # OD Movement covers current needs. Re-enable by uncommenting when required.
        # ("od_status",       "OD Status",             "curr_od_status"),
        ("od_bucket",       "OD Bucket",             "dpd_bucket"),
        ("od_movement",     "OD Movement",           "od_movement_status"),
        ("bucket_movement", "Bucket Movement",       "bucket_movement"),
    ]),
    ("Loan Attributes", [
        ("loan_status",     "Loan Status",           "loan_status"),
        # Source status verbatim. loan_status folds D and I into "Death"; this
        # separates the two death stages — D = claim not yet filed (principal
        # still outstanding), I = claim filed and principal already cleared.
        ("status_code",     "Status Code",           "status_code"),
        ("disb_year",       "Disbursement Year",     "disb_year"),
        ("cycle",           "Cycle",                 "cycle_no"),
        ("purpose",         "Purpose",               "purpose_id"),
        ("facility",        "Facility",              "facility_id"),
        ("lender",          "Lender",                "lender_id"),
    ]),
    ("Borrower", [
        ("caste",           "Caste",                 "caste"),
        ("religion",        "Religion",              "religion"),
        ("rural_urban",     "Rural / Urban",         None),
    ]),
]


# Canonical display order for slicers whose values are not alphabetical
SLICER_ORDER = {
    "od_bucket":        ["Regular", "1 - 30", "31 - 60", "61 - 90",
                         "91 - 180", "181 - 360", "360 +"],
    "loan_status":      ["Active", "Death", "Write-off"],
    "status_code":      ["A", "D", "I", "W"],
    "bucket_movement":  ["Improved", "Static", "Worsened", "N/A"],
    "od_movement":      ["Not OD", "OD Slippage", "Regularised", "Continuing"],
}

# Values to drop from a slicer's options
SLICER_EXCLUDE = {
    "od_bucket":    {"Write-Off"},
    "od_movement":  {"Write-Off"},   # Write-Off shown in loan_status slicer
    # 'Closed' = movement-only loans (closed this month) carried on rpt_aum_status
    # solely for OD Status / Bucket Movement — not a live-book status, hide it.
    "loan_status":  {"Closed"},
    # 'X' is closed — movement-only rows, same reason 'Closed' is hidden above.
    "status_code":  {"X"},
}


def _ordered(sid: str, options: list[str]) -> list[str]:
    drop = SLICER_EXCLUDE.get(sid, set())
    options = [o for o in options if o not in drop]
    order = SLICER_ORDER.get(sid)
    if not order:
        return options
    rank = {v: i for i, v in enumerate(order)}
    return sorted(options, key=lambda v: (rank.get(v, len(order)), v))


@router.get("/filters/options")
def filter_options(user: dict = Depends(get_current_user)):
    """Return all slicer groups with their available option values."""
    df = _scope(read_report("rpt_aum_status"), user)

    groups = []
    for group_label, slicers in SLICER_GROUPS:
        items = []
        for sid, label, col in slicers:
            options = _ordered(sid, _opts(df, col)) if col else []
            items.append({
                "id": sid,
                "label": label,
                "options": options,
                "available": bool(col) and len(options) > 0,
            })
        groups.append({"label": group_label, "slicers": items})

    return {"groups": groups}
