from fastapi import APIRouter, Depends, Query
from typing import Optional

import pandas as pd

from core.db import read_report
from core.filters import hier, segment_filter, multi
from auth.deps import get_current_user, require_export

router = APIRouter()

# =============================================================================
# LEGACY (rpt_writeoff, aggregated) — kept for existing consumers.
# =============================================================================


@router.get("/writeoff")
def writeoff(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_writeoff")
    if df.empty:
        return []
    df = segment_filter(df, segment, loan_source)
    df = hier(df, cluster, region, area, branch)
    return df.fillna("").to_dict("records")


@router.get("/writeoff/kpis")
def writeoff_kpis(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None),
    fy: Optional[str] = Query(None),
    month: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    """Write-off headline figures. Feeds the Executive Summary's Net Write-off card.

    Reads the SAME loan-grain table as the Write-off page (rpt_writeoff_loans),
    not the older rpt_writeoff aggregate. That aggregate does not carry the 1,079
    core status='W' loans outside the write-off master, so the Executive Summary
    reported 30,661 loans / Rs 70.19 Cr while the Write-off page showed
    31,740 / Rs 70.91 Cr — the same measure, two numbers, on two screens.

    It now also accepts prod_class / fy / month, so a period or product filter
    moves this card the same way it moves the Write-off page.
    """
    f = {"segment": segment, "cluster": cluster, "region": region,
         "area": area, "branch": branch, "prod_class": prod_class,
         "loan_id": None}
    df, _ = _load(f, fy, month)
    if df.empty:
        return {"total_amount": 0.0, "total_count": 0, "recovery_amount": 0.0,
                "net_loss": 0.0, "recovery_pct": 0.0}
    if loan_source and loan_source != "ALL":
        df = segment_filter(df, "ALL", loan_source)
    wo_amt = float(df["writeoff_amount"].sum())
    rec_amt = float(df["recovery_amount"].sum())
    return {
        "total_amount": wo_amt,
        "total_count": int(df["writeoff_count"].sum()),
        "recovery_amount": rec_amt,
        "net_loss": round(wo_amt - rec_amt, 2),
        "recovery_pct": round(rec_amt / wo_amt * 100, 2) if wo_amt else 0,
    }


# =============================================================================
# LOAN GRAIN (rpt_writeoff_loans) — the Write-off page and its CSV export.
#
# Both endpoints below apply the SAME filter chain to the SAME table, so the
# exported file always sums back to the figures on screen. That is the whole
# reason the loan-grain table exists; do not let the two drift apart.
# =============================================================================

TABLE = "rpt_writeoff_loans"

# Analysis Parameters available at loan grain. Zone is absent because the
# write-off hierarchy stops at cluster (same as rpt_writeoff).
DIMS: dict[str, tuple[str, str]] = {
    "business_segment": ("Business Segment", "business_segment"),
    "cluster_name":     ("Cluster",          "cluster_name"),
    "region_name":      ("Region",           "region_name"),
    "area_name":        ("Unit",             "area_name"),
    "branch_name":      ("Branch",           "branch_name"),
    "lo_id":            ("Loan Officer",     "lo_id"),
    # Product CLASSIFICATION, not the raw product code: the code has 300+
    # distinct values and is unreadable as a grouping. This is the same
    # slicer Current Outstanding, Disbursement and AML use.
    "prod_classification": ("Prod. Classification", "prod_classification"),
    "loan_source":      ("Loan Source",      "loan_source"),
    "writeoff_fy":      ("FY",               "writeoff_fy"),
    "writeoff_month":   ("Month",            "writeoff_month"),
    # Master ledger vs core status='W'. The two carry different amount bases, so
    # the split is available as a dimension rather than hidden.
    "wo_source":        ("Write-off Source", "wo_source"),
}

# Additive measures.
#
# Avg ticket, avg vintage, accounts-recovered % and net credit loss were removed
# 2026-08-12 at the user's instruction, together with the "Vintage at Write-off"
# AP dimension. months_on_book and recovered_count remain in rpt_writeoff_loans
# (they cost nothing to carry and the DBA owns that schema) but nothing derives
# from them any more.
SUMS = ["writeoff_count", "writeoff_amount", "recovery_amount", "recovery_mtd"]

# Columns the CSV ships, in order. Still loan grain — one row per written-off
# loan — so it stays the detail behind the page.
EXPORT_COLS = [
    "loan_id", "loan_source", "business_segment", "product_id",
    "prod_classification", "wo_source",
    "writeoff_date", "writeoff_month", "writeoff_fy",
    "cluster_name", "region_name", "area_name", "branch_name", "branch_id",
    "lo_id", "disbursement_date",
    "writeoff_amount", "recovery_amount", "recovery_mtd", "last_recovery_date",
]


def _load(f: dict, fy: Optional[str], month: Optional[str]) -> tuple[pd.DataFrame, dict]:
    """Scope-filtered loan rows plus the option lists for the period selects.

    The option lists are built from the frame BEFORE the period filter is
    applied, so choosing a year can never empty the dropdown that chose it.
    """
    df = read_report(TABLE)
    opts = {"fy": [], "month": []}
    if df.empty:
        return df, opts

    for c in SUMS:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    # Hierarchy / segment filters first: the period options a user sees should
    # reflect the book they are allowed to see.
    df = segment_filter(df, f.get("segment") or "ALL")
    df = hier(df, cluster=f.get("cluster"), region=f.get("region"),
              area=f.get("area"), branch=f.get("branch"))
    # The slicer selects a CLASSIFICATION, so it must filter the
    # classification column. It previously filtered product_id (the raw
    # 300+-value code), which meant filtering and grouping on the same
    # concept returned an empty table.
    df = multi(df, "prod_classification", f.get("prod_class"))
    df = multi(df, "loan_id", f.get("loan_id"))
    if df.empty:
        return df, opts

    opts["fy"] = sorted({str(v) for v in df.get("writeoff_fy", pd.Series(dtype=str))
                         .dropna().unique() if str(v) not in ("", "nan")}, reverse=True)

    if fy and fy != "ALL":
        df = df[df["writeoff_fy"].astype(str) == fy]
    # Months are listed for the CHOSEN year only — a month list spanning every
    # year would be unusable, and picking a month from another year would
    # silently return nothing.
    opts["month"] = sorted({str(v) for v in df.get("writeoff_month", pd.Series(dtype=str))
                            .dropna().unique() if str(v) not in ("", "nan")}, reverse=True)
    if month and month != "ALL":
        df = df[df["writeoff_month"].astype(str) == month]
    return df, opts


def _derive(rec: dict) -> dict:
    wo_amt = float(rec.get("writeoff_amount", 0) or 0)
    rec["recovery_pct"] = round(float(rec.get("recovery_amount", 0) or 0) / wo_amt * 100, 2) if wo_amt else 0.0
    return rec


def _wo_filters(
    segment: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    # prod_class was returned in the dict below without ever being declared here,
    # so EVERY write-off endpoint raised NameError at request time — the page
    # loaded and then failed on each call. _load() reads this key to filter
    # prod_classification, so the parameter is what was missing, not the key.
    prod_class: Optional[str] = Query(None),
    # Loan ID is a LOOKUP, not a grouping — one row per loan is unusable as
    # an AP dimension, so it filters instead. Comma-separated ids allowed.
    loan_id: Optional[str] = Query(None),
) -> dict:
    return {"segment": segment, "cluster": cluster, "region": region,
            "area": area, "branch": branch, "prod_class": prod_class,
            "loan_id": loan_id}


@router.get("/writeoff/analysis")
def writeoff_analysis(
    group_by: str = Query("business_segment"),
    group_by_2: Optional[str] = Query(None),
    fy: Optional[str] = Query(None),
    month: Optional[str] = Query(None),
    f: dict = Depends(_wo_filters),
    user: dict = Depends(get_current_user),
):
    empty = {"rows": [], "grand": {}, "as_of": None,
             "dims": [{"value": k, "label": v[0]} for k, v in DIMS.items()],
             "fy_options": [], "month_options": []}
    df, opts = _load(f, fy, month)
    empty["fy_options"], empty["month_options"] = opts["fy"], opts["month"]
    if df.empty:
        return empty

    g1 = DIMS.get(group_by, DIMS["business_segment"])[1]
    g2 = DIMS[group_by_2][1] if (group_by_2 and group_by_2 in DIMS
                                 and group_by_2 != "none") else None
    if g1 not in df.columns:
        return empty
    if g2 and (g2 not in df.columns or g2 == g1):
        g2 = None

    sums = [c for c in SUMS if c in df.columns]
    keys = [g1] + ([g2] if g2 else [])
    grouped = df.groupby(keys, dropna=False)[sums].sum().reset_index()

    rows = []
    for _, r in grouped.iterrows():
        rec = {"name": str(r[g1]), **{c: round(float(r[c]), 2) for c in sums}}
        if g2:
            rec["name2"] = str(r[g2])
        rows.append(_derive(rec))
    rows.sort(key=lambda x: -float(x.get("writeoff_amount", 0)))

    grand = _derive({c: round(float(df[c].sum()), 2) for c in sums})
    grand["name"] = "Grand Total"

    return {"rows": rows, "grand": grand,
            "as_of": str(df["data_date"].max()) if "data_date" in df.columns else None,
            "dims": [{"value": k, "label": v[0]} for k, v in DIMS.items()],
            "fy_options": opts["fy"], "month_options": opts["month"]}


@router.get("/writeoff/loans")
def writeoff_loans(
    fy: Optional[str] = Query(None),
    month: Optional[str] = Query(None),
    f: dict = Depends(_wo_filters),
    user: dict = Depends(require_export),
):
    """Loan-wise rows for the CSV export, under the same filters and the same
    data scope as /writeoff/analysis."""
    df, _ = _load(f, fy, month)
    if df.empty:
        return {"rows": [], "columns": EXPORT_COLS}
    cols = [c for c in EXPORT_COLS if c in df.columns]
    out = df[cols].copy()
    for c in ("writeoff_date", "disbursement_date", "last_recovery_date"):
        if c in out.columns:
            out[c] = out[c].astype(str).replace({"NaT": "", "None": "", "nan": ""})
    out = out.sort_values(
        [c for c in ("writeoff_date", "loan_id") if c in out.columns],
        ascending=False)
    return {"rows": out.fillna("").to_dict("records"), "columns": cols}
