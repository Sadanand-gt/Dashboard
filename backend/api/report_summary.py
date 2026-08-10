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

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, Query

from auth.deps import get_current_user
from core.db import read_report, reports_conn
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
    "credit_bureau": {
        "table": "rpt_credit_bureau",
        # Sourced from the cb_engine DATABASE; hierarchy merged in by the pipeline.
        "dims": {**COMMON_DIMS,
                 "business_segment": ("Branch", "branch_name"),   # no segment on bureau pulls
                 "decision":         ("Decision",        "decision"),
                 "client_category":  ("Client Category", "client_category"),
                 "pull_month":       ("Pull Month",      "pull_month"),
                 "pull_year":        ("Pull Year",       "pull_year"),
                 "cb_branch":        ("Bureau Branch",   "cb_branch")},
        "sums": ["pulls", "approved_pulls", "rejected_pulls", "referred_pulls", "mfi_outstanding", "ru_outstanding", "rs_lts_outstanding",
                 "total_outstanding", "total_overdue", "mfi_lenders_sum",
                 "overdue_mfi_lenders_sum", "other_lenders_sum", "with_overdue_lender",
                 "emi_other", "monthly_income", "max_eligibility", "with_income"],
        # Averages per pull, plus the obligation-to-income ratio. The source column
        # named "FOIR" is NOT a ratio (it holds Approve/Refer), so this is derived
        # from the real EMI and income sums instead.
        "ratios": {"approval_rate":       ("approved_pulls",          "pulls"),
                   "rejection_rate":      ("rejected_pulls",          "pulls"),
                   "overdue_lender_pct":  ("with_overdue_lender",     "pulls"),
                   "obligation_pct":      ("emi_other",               "monthly_income"),
                   "overdue_pct":         ("total_overdue",           "total_outstanding")},
        # Plain per-pull averages — counts and rupees, NOT percentages.
        "averages": {"avg_mfi_lenders":   ("mfi_lenders_sum",         "pulls"),
                     "avg_other_lenders": ("other_lenders_sum",       "pulls"),
                     "avg_outstanding":   ("total_outstanding",       "pulls"),
                     "avg_emi_other":     ("emi_other",               "pulls")},
        "date_col": "report_day",
        "filter_col": "pull_year",
        "filter_label": "Pull Year",
    },
    "portfolio_cuts": {
        "table": "rpt_portfolio_cuts",
        # One tall table holding 11 cuts. The page picks a cut_type; cut_value is
        # then the row dimension. cut_rank carries the intended band order so
        # "1 - 12 M" never sorts after "> 36 M".
        "dims": {**COMMON_DIMS,
                 "business_segment": ("Business Segment", "business_segment"),
                 "cut_value":        ("Cut",              "cut_value"),
                 "loan_status":      ("Loan Status",      "loan_status")},
        "sums": ["n_regular", "n_1_30", "n_31_60", "n_61_90", "n_91_180",
                 "n_181_360", "n_360_plus", "n_total",
                 "pos_regular", "pos_1_30", "pos_31_60", "pos_61_90", "pos_91_180",
                 "pos_181_360", "pos_360_plus", "pos_total",
                 "par0_pos", "par30_pos", "par60_pos", "par90_pos",
                 "wo3m_count", "wo3m_amount"],
        # Derived from the POS sums, never stored, so they stay correct under any
        # grouping. par60_pct reproduces the Excel sheet's "PAR > 90 %" column,
        # which is arithmetically DPD > 60 — see portfolio_cuts.sql.
        "ratios": {"par0_pct":  ("par0_pos",  "pos_total"),
                   "par30_pct": ("par30_pos", "pos_total"),
                   "par60_pct": ("par60_pos", "pos_total"),
                   "par90_pct": ("par90_pos", "pos_total")},
        # These describe the written-off book, so they survive the Excl-W/O view.
        "portfolio_exempt_sums": ["wo3m_count", "wo3m_amount"],
        # data_date, not report_day: read_report already filters to the latest
        # report_day and drops the column, and data_date is the more honest
        # label anyway — it is the T-1 date the figures describe, not the date
        # the pipeline happened to run.
        # Bands must never sort alphabetically ("1 - 12 M" after "> 36 M").
        # cut_rank is written by the pipeline and carries the intended order.
        "order_col": "cut_rank",
        "date_col": "data_date",
        "filter_col": "cut_type",
        "filter_label": "Portfolio Cut",
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
        "dims": {**COMMON_DIMS,
                 # real segment (JLG / IEL / LAP), derived from product_id below
                 "business_segment": ("Business Segment", "business_segment"),
                 "loan_source":    ("Loan Source",    "loan_source"),
                 "product_id":     ("Product",        "product_id"),
                 "writeoff_year":  ("Write-off Year", "writeoff_year"),
                 "writeoff_month": ("Write-off Month", "writeoff_month")},
        "segment_from_product": True,
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
    decision: Optional[str] = Query(None),   # bureau outcome (credit_bureau only)
) -> dict:
    return {"segment": segment, "zone": zone, "cluster": cluster, "region": region,
            "area": area, "branch": branch, "prod_class": prod_class,
            "loan_status": loan_status, "portfolio": portfolio, "pick": pick,
            "decision": decision}


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

    # Some report tables carry only loan_source (IL/JLG) but do carry product_id.
    # Derive the real business segment here rather than asking the DBA for a
    # column: the rule is the same one the SQL layer uses (SUGAM / UDYOGINI /
    # SECURED -> LAP), so IEL and LAP are reported exactly as elsewhere.
    if spec.get("segment_from_product") and "product_id" in df.columns:
        prod = df["product_id"].astype(str).str.upper().str.strip()
        is_lap = (prod.str.contains("SUGAM", na=False)
                  | prod.str.contains("UDYOGINI", na=False)
                  | prod.str.contains("SECURED", na=False))
        src = df["loan_source"].astype(str) if "loan_source" in df.columns else ""
        df["business_segment"] = np.where(src == "JLG", "JLG",
                                          np.where(is_lap, "LAP", "IEL"))

    as_of = None
    dcol = spec.get("date_col")
    if dcol and dcol in df.columns and not df.empty:
        as_of = str(df[dcol].max())
    elif not df.empty:
        # read_report filters to the newest report_day and drops the column, so a
        # spec whose date_col IS report_day is left with nothing to stamp (the
        # Write-off page showed "As of —"). Ask the store for the day it served.
        as_of = _latest_report_day(spec["table"])

    # Portfolio: "without" = Excl W/O — drop written-off loans so PAR/POS match
    # Excel + Current Outstanding (mirrors ageing/od_status/dq_category/collection).
    #
    # "portfolio_exempt_sums" are measures that describe the WRITTEN-OFF book
    # itself and therefore live on loan_status='Write-off' rows. Dropping those
    # rows would zero the measure, so their per-group totals are taken BEFORE the
    # filter and merged back afterwards. Portfolio Cuts needs this: its
    # "write-off in last 3 months" columns sit beside live-book POS on the same
    # Excel row, and the Excl-W/O view must not blank them out.
    exempt = [c for c in spec.get("portfolio_exempt_sums", []) if c in df.columns]
    exempt_pre = None
    if (f.get("portfolio") or "with") == "without" and "loan_status" in df.columns:
        if exempt:
            exempt_pre = df.copy()
        df = df[df["loan_status"].astype(str) != "Write-off"]

    df = segment_filter(df, f.get("segment") or "ALL")
    df = hier(df, cluster=f.get("cluster"), region=f.get("region"),
              area=f.get("area"), branch=f.get("branch"), zone=f.get("zone"))
    df = multi(df, "product_id", f.get("prod_class"))
    df = multi(df, "loan_status", f.get("loan_status"))
    # no-ops on tables without the column, so it is safe for every spec
    df = multi(df, "decision", f.get("decision"))
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


    # "ratios" are PERCENTAGES (x100). "averages" are plain num/den — a per-pull
    # lender count or an average rupee amount must NOT be multiplied by 100
    # (avg_mfi_lenders rendered as 147.25 instead of 1.47 before this split).
    averages = spec.get("averages", {})

    def derive(rec: dict) -> dict:
        for name, (num, den) in spec["ratios"].items():
            n, d = float(rec.get(num, 0) or 0), float(rec.get(den, 0) or 0)
            rec[name] = round(n / d * 100, 2) if d else 0.0
        for name, (num, den) in averages.items():
            n, d = float(rec.get(num, 0) or 0), float(rec.get(den, 0) or 0)
            rec[name] = round(n / d, 2) if d else 0.0
        return rec

    keys = [g1] + ([g2] if g2 else [])
    grouped = df.groupby(keys, dropna=False)[sums].sum().reset_index()

    # Re-attach the write-off-book measures the Excl-W/O filter removed. Done
    # AFTER grouping: merging pre-aggregation would broadcast each group's total
    # onto every row of that group and the groupby would then multiply it.
    if exempt_pre is not None and exempt:
        for c in exempt:
            exempt_pre[c] = pd.to_numeric(exempt_pre[c], errors="coerce").fillna(0)
        add = exempt_pre.groupby(keys, dropna=False)[exempt].sum().reset_index()
        grouped = grouped.drop(columns=exempt, errors="ignore").merge(add, on=keys, how="left")
        for c in exempt:
            grouped[c] = pd.to_numeric(grouped[c], errors="coerce").fillna(0)

    rows = []
    for _, r in grouped.iterrows():
        rec = {"name": str(r[g1]), **{c: round(float(r[c]), 2) for c in sums}}
        if g2:
            rec["name2"] = str(r[g2])
        rows.append(derive(rec))
    # An "order_col" (e.g. cut_rank) is authoritative when present: it is written
    # by the pipeline precisely so bands do not sort as text. Falls back to
    # _order_key, which handles the canonical DPD bucket order.
    ocol = spec.get("order_col")
    if ocol and ocol in df.columns:
        rank = (df.groupby(keys, dropna=False)[ocol].max().reset_index()
                  .set_index([str(k) for k in keys] if False else keys)[ocol].to_dict())
        def _rank_of(rec):
            k = (rec["name"],) if not g2 else (rec["name"], rec.get("name2"))
            v = rank.get(k[0] if len(k) == 1 else k)
            return (0, float(v)) if v is not None else (1, 0.0)
        rows.sort(key=lambda x: (_rank_of(x), str(x["name"]), str(x.get("name2", ""))))
    else:
        rows.sort(key=lambda x: (_order_key(g1, x["name"]), _order_key(g2 or "", x.get("name2", ""))))

    _gsrc = {c: (exempt_pre[c] if (exempt_pre is not None and c in exempt) else df[c])
             for c in sums}
    grand = derive({c: round(float(pd.to_numeric(v, errors="coerce").fillna(0).sum()), 2)
                    for c, v in _gsrc.items()})
    grand["name"] = "Grand Total"

    return {"rows": rows, "grand": grand, "as_of": as_of,
            "dims": [{"value": k, "label": v[0]} for k, v in spec["dims"].items()],
            "filter": empty["filter"]}


_LATEST_DAY_CACHE: dict = {}


def _latest_report_day(table: str):
    """Newest report_day held for a table, cached per process. Returns None when
    the table has no report_day, so the caller simply shows no stamp."""
    if table not in _LATEST_DAY_CACHE:
        try:
            with reports_conn() as c:
                v = pd.read_sql(f"SELECT max(report_day) d FROM {table}", c).iloc[0, 0]
            _LATEST_DAY_CACHE[table] = str(v) if v is not None else None
        except Exception:
            _LATEST_DAY_CACHE[table] = None
    return _LATEST_DAY_CACHE[table]


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
router.add_api_route("/portfolio-cuts/summary", _make("portfolio_cuts"), methods=["GET"])
router.add_api_route("/credit-bureau/summary", _make("credit_bureau"), methods=["GET"])
