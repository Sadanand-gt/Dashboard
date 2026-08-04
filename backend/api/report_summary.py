"""
Generic AP#1 × AP#2 group-summary for the reports that previously rendered as
flat table dumps (AUM DPD Detail, Cashless, POS & PAR, Delinquencies, Case
Movement) — so they get the same standard page view as Current Outstanding.

One handler, five specs. Routes deliberately keep each report's OWN path
prefix (/api/aum-live/..., /api/cashless/..., …) so the report-access gate in
core/reports_catalog.py keeps working with no changes.

Reads go through read_report(), so the user's data scope applies automatically.
"""

from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, Query

from auth.deps import get_current_user
from core.db import read_report
from core.filters import hier, multi, segment_filter

router = APIRouter()

# Dimensions offered as AP#1 / AP#2. Key = UI value, value = (label, column).
# 'business_segment' maps onto loan_source — that IS the segment on these tables.
COMMON_DIMS = {
    "business_segment": ("Business Segment", "loan_source"),
    "cluster_name":     ("Cluster",          "cluster_name"),
    "region_name":      ("Region",           "region_name"),
    "area_name":        ("Unit",             "area_name"),
    "branch_name":      ("Branch",           "branch_name"),
    "lo_id":            ("Loan Officer",     "lo_id"),
}

SPECS: dict = {
    "aum_live": {
        "table": "rpt_aum_live",
        "dims": {**COMMON_DIMS, "loan_status": ("Loan Status", "loan_status"),
                 "product_id": ("Product", "product_id")},
        "sums": ["total_loans", "total_pos", "death_cases",
                 "par0_pos", "par30_pos", "par60_pos", "par90_pos",
                 "standard_count", "dpd_1_30_count", "dpd_31_60_count",
                 "dpd_61_90_count", "dpd_91_180_count", "dpd_181_360_count",
                 "dpd_360p_count"],
        "ratios": {"par0_pct": ("par0_pos", "total_pos"),
                   "par30_pct": ("par30_pos", "total_pos"),
                   "par60_pct": ("par60_pos", "total_pos"),
                   "par90_pct": ("par90_pos", "total_pos")},
        "date_col": "report_date",
    },
    "cashless": {
        "table": "rpt_cashless_collection",
        "dims": {**COMMON_DIMS, "loan_status": ("Loan Status", "loan_status"),
                 "product_id": ("Product", "product_id")},
        "sums": ["daily_cashless", "daily_collection", "mtd_cashless", "mtd_collection"],
        "ratios": {"daily_cashless_pct": ("daily_cashless", "daily_collection"),
                   "mtd_cashless_pct": ("mtd_cashless", "mtd_collection")},
        "date_col": "report_date",
    },
    "pos_par": {
        "table": "rpt_pos_par",
        "dims": {**COMMON_DIMS, "loan_status": ("Loan Status", "loan_status")},
        "sums": ["total_loans", "total_pos", "par0_count", "par30_count",
                 "par60_count", "par90_count", "par0_pos", "par30_pos",
                 "par60_pos", "par90_pos"],
        "ratios": {"par0_pct": ("par0_pos", "total_pos"),
                   "par30_pct": ("par30_pos", "total_pos"),
                   "par60_pct": ("par60_pos", "total_pos"),
                   "par90_pct": ("par90_pos", "total_pos")},
        "date_col": "report_date",
        "variant_col": "report_type",      # EOM / LIVE toggle
        "variant_default": "LIVE",
    },
    "delinquencies": {
        "table": "rpt_delinquencies",
        "dims": {**COMMON_DIMS, "loan_status": ("Loan Status", "loan_status")},
        "sums": ["total_loans", "total_pos", "death_cases", "par0_pos", "par30_pos",
                 "od030_prev_count", "od030_regularized", "od030_partial_paid",
                 "od030_not_paid", "fresh_slippage", "par30_prev_count",
                 "par30_regularized", "par30_paid_1_inst", "members_no_pay"],
        "ratios": {"par0_pct": ("par0_pos", "total_pos"),
                   "par30_pct": ("par30_pos", "total_pos")},
        "date_col": "report_date",
    },
    "ots": {
        "table": "rpt_ots",
        # business_segment is a REAL column here (IEL / LAP / JLG) — override the
        # COMMON_DIMS mapping, which points 'business_segment' at loan_source.
        "dims": {**COMMON_DIMS,
                 "business_segment": ("Business Segment", "business_segment"),
                 "loan_source":      ("Loan Source",      "loan_source"),
                 "settle_bucket":    ("Settlement Bucket", "settle_bucket"),
                 "settle_year":      ("Settlement Year",   "settle_year"),
                 "settle_month":     ("Settlement Month",  "settle_month"),
                 "product_id":       ("Product",           "product_id")},
        "sums": ["ots_count", "ots_amount", "principal_collected", "interest_collected",
                 "principal_waiver", "interest_waiver", "total_waiver",
                 "net_amount_collected", "net_principal", "net_interest"],
        # waiver_pct = how much of the settled amount was given up;
        # recovery_pct = how much came back as real cash.
        "ratios": {"waiver_pct":   ("total_waiver",         "ots_amount"),
                   "recovery_pct": ("net_amount_collected", "ots_amount")},
        "date_col": "report_day",
        "filter_col": "settle_year",
        "filter_label": "Settlement Year",
    },
    "writeoff": {
        "table": "rpt_writeoff",
        # writeoff_year is derived below from writeoff_month ('YYYY-MM') — no DDL
        # change needed, and it doubles as the post-write-off recovery vintage.
        "dims": {**COMMON_DIMS, "product_id": ("Product", "product_id"),
                 "writeoff_year": ("Write-off Year", "writeoff_year"),
                 "writeoff_month": ("Write-off Month", "writeoff_month")},
        "sums": ["writeoff_count", "writeoff_amount", "sanctioned_amount",
                 "recovery_amount", "net_credit_loss"],
        "ratios": {"recovery_pct": ("recovery_amount", "writeoff_amount")},
        "date_col": "report_day",
        # Single-select vintage filter rendered by StandardReport.
        "filter_col": "writeoff_year",
        "filter_label": "Write-off Year",
    },
    "case_movement": {
        "table": "rpt_case_movement",
        "dims": COMMON_DIMS,
        "sums": ["new_clients_t1", "booked_t1", "sanctioned_t1", "rejected_t1",
                 "disbursed_t1_count", "disbursed_t1_amount",
                 "new_clients_mtd", "booked_mtd", "sanctioned_mtd", "rejected_mtd",
                 "disbursed_mtd_count", "disbursed_mtd_amount", "total_apps_mtd",
                 "cb_checked_total", "approved_total", "cgt1_t1", "grt1_mtd"],
        "ratios": {"approval_ratio_total": ("approved_total", "cb_checked_total")},
        "date_col": "report_date",
    },
}


# Canonical DPD-bucket display order — same list as od_status.py / dq_category.py.
# Any column holding these labels must render in this order, never alphabetically
# ('181 - 360' < '360 +' < '61 - 90' as text, which is wrong).
DPD_BUCKET_ORDER = ["Regular", "1 - 30", "31 - 60", "61 - 90", "91 - 180", "181 - 360", "360 +"]
_BUCKET_RANK = {b: i for i, b in enumerate(DPD_BUCKET_ORDER)}
BUCKET_COLS = {"dpd_bucket", "settle_bucket", "prev_dpd_bucket", "curr_dpd_bucket", "od_bucket"}


def _order_key(col: str, value: str):
    """Sort key for a group label: canonical rank for bucket columns, else the text."""
    if col in BUCKET_COLS:
        return (_BUCKET_RANK.get(str(value), 99), "")
    return (0, str(value))


def _filters(
    segment: Optional[str] = Query(None), zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None), loan_status: Optional[str] = Query(None),
    portfolio: Optional[str] = Query(None),  # with | without (Excl W/O)
    pick: Optional[str] = Query(None),       # value for the spec's filter_col
) -> dict:
    return {"segment": segment, "zone": zone, "cluster": cluster, "region": region,
            "area": area, "branch": branch, "prod_class": prod_class,
            "loan_status": loan_status, "portfolio": portfolio, "pick": pick}


def _summary(key: str, group_by: str, group_by_2: Optional[str],
             variant: Optional[str], f: dict) -> dict:
    spec = SPECS[key]
    df = read_report(spec["table"])
    fcol = spec.get("filter_col")
    empty = {"rows": [], "grand": {}, "as_of": None,
             "dims": [{"value": k, "label": v[0]} for k, v in spec["dims"].items()],
             "filter": ({"param": "pick", "label": spec.get("filter_label", "Filter"),
                         "options": []} if fcol else None)}
    if df.empty:
        return empty

    # Derived dimension: write-off YEAR from writeoff_month ('YYYY-MM'). Kept in
    # pandas so no DDL is needed (the DBA owns rpt_* schemas).
    if "writeoff_month" in df.columns and "writeoff_year" not in df.columns:
        df["writeoff_year"] = df["writeoff_month"].astype(str).str.slice(0, 4)

    # Options come from the FULL (scope-filtered) frame, so picking one vintage
    # never empties the dropdown that selected it.
    if fcol and fcol in df.columns:
        empty["filter"]["options"] = sorted(
            {str(v) for v in df[fcol].dropna().unique() if str(v) not in ("", "nan")},
            reverse=True)
        pick = (f.get("pick") or "ALL").strip()
        if pick and pick != "ALL":
            df = df[df[fcol].astype(str) == pick]
        if df.empty:
            return empty

    # EOM / LIVE style variant (POS & PAR)
    vcol = spec.get("variant_col")
    if vcol and vcol in df.columns:
        df = df[df[vcol].astype(str) == (variant or spec["variant_default"])]

    as_of = None
    dcol = spec.get("date_col")
    if dcol and dcol in df.columns and not df.empty:
        as_of = str(df[dcol].max())

    # Portfolio: "without" = Excl W/O — drop written-off loans so PAR/POS match
    # Excel + Current Outstanding (mirrors ageing/od_status/dq_category/collection).
    if (f.get("portfolio") or "with") == "without" and "loan_status" in df.columns:
        df = df[df["loan_status"].astype(str) != "Write-off"]

    df = segment_filter(df, f.get("segment") or "ALL")
    df = hier(df, cluster=f.get("cluster"), region=f.get("region"),
              area=f.get("area"), branch=f.get("branch"), zone=f.get("zone"))
    df = multi(df, "product_id", f.get("prod_class"))
    df = multi(df, "loan_status", f.get("loan_status"))
    if df.empty:
        return {**empty, "as_of": as_of}

    g1 = spec["dims"].get(group_by, spec["dims"]["business_segment"])[1]
    g2 = None
    if group_by_2 and group_by_2 != "none" and group_by_2 in spec["dims"]:
        g2 = spec["dims"][group_by_2][1]
    if g1 not in df.columns:
        return {**empty, "as_of": as_of}
    if g2 and g2 not in df.columns:
        g2 = None

    sums = [c for c in spec["sums"] if c in df.columns]
    for c in sums:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)

    def derive(rec: dict) -> dict:
        for name, (num, den) in spec["ratios"].items():
            n, d = float(rec.get(num, 0) or 0), float(rec.get(den, 0) or 0)
            rec[name] = round(n / d * 100, 2) if d else 0.0
        return rec

    keys = [g1] + ([g2] if g2 else [])
    grouped = df.groupby(keys, dropna=False)[sums].sum().reset_index()

    rows = []
    for _, r in grouped.iterrows():
        rec = {"name": str(r[g1]), **{c: round(float(r[c]), 2) for c in sums}}
        if g2:
            rec["name2"] = str(r[g2])
        rows.append(derive(rec))
    rows.sort(key=lambda x: (_order_key(g1, x["name"]), _order_key(g2 or "", x.get("name2", ""))))

    grand = derive({c: round(float(df[c].sum()), 2) for c in sums})
    grand["name"] = "Grand Total"

    return {"rows": rows, "grand": grand, "as_of": as_of,
            "dims": [{"value": k, "label": v[0]} for k, v in spec["dims"].items()],
            "filter": empty["filter"]}


def _make(key: str):
    def handler(
        group_by: str = Query("business_segment"),
        group_by_2: Optional[str] = Query(None),
        variant: Optional[str] = Query(None),
        f: dict = Depends(_filters),
        user: dict = Depends(get_current_user),
    ):
        return _summary(key, group_by, group_by_2, variant, f)
    return handler


# Each route keeps its report's own path prefix → existing access gate applies.
router.add_api_route("/aum-live/summary", _make("aum_live"), methods=["GET"])
router.add_api_route("/cashless/summary", _make("cashless"), methods=["GET"])
router.add_api_route("/pos-par/summary", _make("pos_par"), methods=["GET"])
router.add_api_route("/delinquencies/summary", _make("delinquencies"), methods=["GET"])
router.add_api_route("/case-movement/summary", _make("case_movement"), methods=["GET"])
router.add_api_route("/writeoff/summary", _make("writeoff"), methods=["GET"])
router.add_api_route("/ots/summary", _make("ots"), methods=["GET"])
