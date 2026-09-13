"""
od_status.py — OD Status report (combines the Excel "OD Status" + "OD List" sheets).

  • /od-status/matrix : AP#1 (default Branch) × OD-movement-status matrix
        (OD Slippage / Continuing / Regularized / Not OD), each with # and POS%,
        plus Total # and Total POS %.  Served from rpt_aum_status.
  • /od-status/list   : loan-level OD List (rpt_od_list) — filtered & paginated.

Both honour the global slicer filters + Portfolio (With / Excl. W/O) toggle.
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional
import pandas as pd
from core.db import read_report
from core.filters import hier, segment_filter, multi
from auth.deps import get_current_user, require_export

router = APIRouter()

# Canonical DPD-bucket display order (used when grouping by OD Bucket).
DPD_BUCKET_ORDER = ["Regular", "1 - 30", "31 - 60", "61 - 90", "91 - 180", "181 - 360", "360 +"]
_BUCKET_RANK = {b: i for i, b in enumerate(DPD_BUCKET_ORDER)}


def _order_rows(rows: list, group_by: str) -> list:
    """Order body rows: by canonical DPD bucket when grouping by OD Bucket, else by size."""
    if group_by == "dpd_bucket":
        rows.sort(key=lambda r: _BUCKET_RANK.get(r["name"], 99))
    else:
        rows.sort(key=lambda r: -r["total_count"])
    return rows


# aum od_movement_status values → Excel column order (note Excel spells "Regularized")
OD_STATES = ["OD Slippage", "Continuing", "Regularised", "Not OD"]
OD_LABELS = {"OD Slippage": "OD Slippage", "Continuing": "Continuing",
             "Regularised": "Regularized", "Not OD": "Not OD"}

DIM_COL = {
    "business_segment": "business_segment", "zone_name": "zone_name",
    "cluster_name": "cluster_name", "region_name": "region_name", "area_name": "area_name",
    "branch_name": "branch_name", "state_id": "state_id", "district_id": "district_id",
    "prod_classification": "prod_classification", "curr_od_status": "curr_od_status",
    "dpd_bucket": "dpd_bucket", "bucket_movement": "bucket_movement",
    "od_movement_status": "od_movement_status", "loan_status": "loan_status",
    "disb_year": "disb_year", "cycle_no": "cycle_no", "caste": "caste",
    "religion": "religion", "purpose_id": "purpose_id", "facility_id": "facility_id",
    "lender_id": "lender_id",
}


def _apply_filters(df, f) -> pd.DataFrame:
    # Movement universe = the PREV month-end portfolio: keep only loans on-book at
    # 30-Jun (drops current-month disbursals, which have no month-end demand and
    # can't be OD; keeps current-month closures). No-op on tables without the flag.
    if "onbook_prev_eom" in df.columns:
        df = df[df["onbook_prev_eom"].fillna(False).astype(bool)]
    if f.get("portfolio") == "without" and "loan_status" in df.columns:
        df = df[df["loan_status"] != "Write-off"]
    df = segment_filter(df, f.get("segment") or "ALL")
    df = hier(df, f.get("cluster"), f.get("region"), f.get("area"), f.get("branch"), zone=f.get("zone"))
    df = multi(df, "state_id",            f.get("branch_state"))
    df = multi(df, "district_id",         f.get("district"))
    df = multi(df, "prod_classification", f.get("prod_class"))
    df = multi(df, "curr_od_status",      f.get("od_status"))
    df = multi(df, "dpd_bucket",          f.get("od_bucket"))
    df = multi(df, "bucket_movement",     f.get("bucket_movement"))
    df = multi(df, "loan_status",         f.get("loan_status"))
    df = multi(df, "disb_year",           f.get("disb_year"))
    df = multi(df, "cycle_no",            f.get("cycle"))
    df = multi(df, "purpose_id",          f.get("purpose"))
    df = multi(df, "facility_id",         f.get("facility"))
    df = multi(df, "lender_id",           f.get("lender"))
    df = multi(df, "caste",               f.get("caste"))
    df = multi(df, "religion",            f.get("religion"))
    df = multi(df, "loan_id",             f.get("loan_id"))
    return df


def _od_movement(df: pd.DataFrame) -> pd.Series:
    """OD Status per the Excel/.pbit DAX — driven by month-end DPD vs current DPD:
      Current Bucket Sr = month-end DPD bucket (prev_dpd_bucket): 0 = Regular, >0 = OD
      Next Bucket Sr    = current/live DPD bucket (curr_dpd_bucket): 0 = Regular, >0 = OD
        Current=0 & Next>0 → OD Slippage    (regular at month-end, OD now)
        Current>0 & Next=0 → Regularised    (OD at month-end, regular now)
        Current=0 & Next=0 → Not OD
        else (both > 0)    → Continuing
    Bucket labels are the pure DPD buckets (no write-off override); the Portfolio
    toggle handles write-off inclusion via loan_status.
    """
    cur_od = df["prev_dpd_bucket"].ne("Regular")   # Current Bucket (month-end) > 0
    nxt_od = df["curr_dpd_bucket"].ne("Regular")   # Next Bucket (current) > 0
    out = pd.Series("Continuing", index=df.index)
    out[(~cur_od) & nxt_od]     = "OD Slippage"
    out[cur_od    & (~nxt_od)]  = "Regularised"
    out[(~cur_od) & (~nxt_od)]  = "Not OD"
    return out


def _filter_params(
    segment: Optional[str] = Query(None), zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None), district: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None), od_status: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None), bucket_movement: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None), disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None), purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None), lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None), religion: Optional[str] = Query(None),
    # Loan ID is a LOOKUP, not a grouping — one row per loan is unusable as
    # an AP dimension, so it filters instead. Comma-separated ids allowed.
    loan_id: Optional[str] = Query(None),
    portfolio: Optional[str] = Query(None),
) -> dict:
    return dict(
        segment=segment, zone=zone, cluster=cluster, region=region, area=area,
        branch=branch, branch_state=branch_state, district=district, prod_class=prod_class,
        od_status=od_status, od_bucket=od_bucket, bucket_movement=bucket_movement,
        loan_status=loan_status, disb_year=disb_year, cycle=cycle, purpose=purpose,
        facility=facility, lender=lender, caste=caste, religion=religion, portfolio=portfolio, loan_id=loan_id,
    )


def _safe(df: pd.DataFrame, key: str) -> str:
    col = DIM_COL.get(key, key)
    if col not in df.columns:
        df[col] = "N/A"
    return col


# rpt_od_slippage carries only segment/geo/loan_status; enrich with the remaining
# analysis dims from rpt_od_list (all slippage loans are OD-relevant → present there)
# so the OD Slippage report honours the same filters & group-bys as other reports.
_SLIP_EXTRA_DIMS = ["prod_classification", "dpd_bucket", "cycle_no", "disb_year",
                    "purpose_id", "facility_id", "lender_id", "caste", "religion"]


def _enrich_slippage(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or "loan_id" not in df.columns:
        return df
    try:
        od = read_report("rpt_od_list")
        cols = ["loan_id"] + [c for c in _SLIP_EXTRA_DIMS if c in od.columns and c not in df.columns]
        if len(cols) > 1:
            df = df.merge(od[cols].drop_duplicates("loan_id"), on="loan_id", how="left")
    except Exception:
        pass
    return df


def _freq_slice(filters: dict, freq: str):
    """Loans with a given previous-slippage count (12M), from rpt_od_slippage.
    Returns the filtered per-loan frame (all are current OD-slippage loans)."""
    slip = _read_slippage()
    if slip.empty:
        return slip
    slip = _apply_filters(_enrich_slippage(slip), filters).copy()
    want = "3+" if freq in ("3", "3+") else freq
    slip["_fb"] = slip["prev_slippage_count"].map(_freq_bucket)
    return slip[slip["_fb"] == want]



def _read_slippage():
    """rpt_od_slippage restricted to the OD Status matrix basis.

    Since 2026-08-13 the table also carries loans that slipped this month and
    were then written off, flagged in_od_matrix = FALSE, so one table can serve
    both "every loan that slipped" and "the matrix column". Every consumer that
    must equal the OD Status matrix or the Excel OD Slippage sheet — both of
    which drop write-offs — reads through here.
    """
    df = read_report("rpt_od_slippage")
    if not df.empty and "in_od_matrix" in df.columns:
        df = df[df["in_od_matrix"].astype(bool)]
    return df


@router.get("/od-status/kpis")
def od_status_kpis(
    freq: str = Query("all"),
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    # Frequency filter (specific value): restrict to loans with that previous-slippage
    # count — these are current OD-slippage loans (only population with a known 12M count).
    if freq and freq != "all":
        s = _freq_slice(filters, freq)
        if s.empty:
            return {"total_pos": 0, "loan_count": 0, "slippage": 0,
                    "continuing": 0, "regularized": 0, "not_od": 0}
        cnt = int(len(s))
        return {"total_pos": float(s["pos"].sum()), "loan_count": cnt,
                "slippage": cnt, "continuing": 0, "regularized": 0, "not_od": 0}

    df = read_report("rpt_aum_status")
    if df.empty:
        return {}
    df = _apply_filters(df, filters).copy()
    df["_odm"] = _od_movement(df)
    # POS stated at the PREVIOUS month-end (matches the Excel movement sheets)
    pcol = "prev_pos" if "prev_pos" in df.columns else "total_pos"
    pos = float(df[pcol].sum())
    by = df.groupby("_odm")["loan_count"].sum().to_dict()
    return {
        "total_pos": pos,
        "loan_count": int(df["loan_count"].sum()),
        "slippage": int(by.get("OD Slippage", 0)),
        "continuing": int(by.get("Continuing", 0)),
        "regularized": int(by.get("Regularised", 0)),
        "not_od": int(by.get("Not OD", 0)),
    }


def _matrix_by_freq(group_by: str, group_by_2, freq: str, filters: dict) -> dict:
    """OD Status matrix restricted to loans with a given previous-slippage count (12M).
    Those loans are current OD-slippage loans, so they populate the OD Slippage column."""
    states = [OD_LABELS[s] for s in OD_STATES]
    s = _freq_slice(filters, freq)
    if s.empty:
        return {"states": states, "rows": []}
    a1 = _safe(s, group_by)
    a2 = _safe(s, group_by_2) if group_by_2 and group_by_2 != "none" else None
    keys = [a1] + ([a2] if a2 else [])

    def _cells(cnt: int) -> list:
        # OD Slippage is OD_STATES[0]; other movement states have no 12M frequency data.
        return [{"count": cnt, "pos_pct": 100.0 if cnt else 0}] + \
               [{"count": 0, "pos_pct": 0} for _ in OD_STATES[1:]]

    rows = []
    for gv, sub in s.groupby(keys, dropna=False):
        gv = gv if isinstance(gv, tuple) else (gv,)
        cnt = int(len(sub))
        rows.append({"name": str(gv[0]), "name2": str(gv[1]) if a2 else None, "cells": _cells(cnt),
                     "total_count": cnt, "total_pos": float(sub["pos"].sum())})
    _order_rows(rows, group_by)
    rows.append({"name": "Grand Total", "name2": None, "cells": _cells(int(len(s))),
                 "total_count": int(len(s)), "total_pos": float(s["pos"].sum()), "is_total": True})
    return {"states": states, "rows": rows}


@router.get("/od-status/matrix")
def od_status_matrix(
    group_by: str = Query("branch_name"),
    group_by_2: Optional[str] = Query(None),
    freq: str = Query("all"),
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    if freq and freq != "all":
        return _matrix_by_freq(group_by, group_by_2, freq, filters)

    states = [OD_LABELS[s] for s in OD_STATES]
    df = read_report("rpt_aum_status")
    if df.empty:
        return {"states": states, "rows": []}
    df = _apply_filters(df, filters).copy()
    if df.empty:
        return {"states": states, "rows": []}

    # OD Status = month-end DPD (Current Bucket) vs current DPD (Next Bucket) — see _od_movement.
    df["_odm"] = _od_movement(df)
    a1 = _safe(df, group_by)
    a2 = _safe(df, group_by_2) if group_by_2 and group_by_2 != "none" else None
    keys = [a1] + ([a2] if a2 else [])

    pcol = "prev_pos" if "prev_pos" in df.columns else "total_pos"   # POS @ prev month-end
    cnt = df.groupby(keys + ["_odm"])["loan_count"].sum()
    pos = df.groupby(keys + ["_odm"])[pcol].sum()

    rows = []
    for gv, sub in df.groupby(keys, dropna=False):
        gv = gv if isinstance(gv, tuple) else (gv,)
        row_pos_tot = float(sub[pcol].sum())
        row_cnt_tot = int(sub["loan_count"].sum())
        cells = []
        for st in OD_STATES:
            c = int(cnt.get(gv + (st,), 0))
            p = float(pos.get(gv + (st,), 0))
            cells.append({"count": c, "pos_pct": round(p / row_pos_tot * 100, 2) if row_pos_tot else 0})
        rows.append({"name": str(gv[0]), "name2": str(gv[1]) if a2 else None,
                     "cells": cells, "total_count": row_cnt_tot, "total_pos": row_pos_tot})

    _order_rows(rows, group_by)

    # Grand total
    gtot_pos = float(df[pcol].sum())
    gcells = []
    for st in OD_STATES:
        c = int(df[df["_odm"] == st]["loan_count"].sum())
        p = float(df[df["_odm"] == st][pcol].sum())
        gcells.append({"count": c, "pos_pct": round(p / gtot_pos * 100, 2) if gtot_pos else 0})
    rows.append({"name": "Grand Total", "name2": None, "cells": gcells,
                 "total_count": int(df["loan_count"].sum()), "total_pos": gtot_pos, "is_total": True})

    return {"states": states, "rows": rows}


FREQ_BUCKETS = ["0", "1", "2", "3+"]


def _freq_bucket(n) -> str:
    n = int(n)
    return "3+" if n >= 3 else str(n)


@router.get("/od-status/slippage")
def od_status_slippage(
    group_by: str = Query("branch_name"),
    freq: str = Query("all"),           # 'all' | '0' | '1' | '2' | '3' (=3+)
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    """Previous Slippage (12M): current OD-slippage loans grouped by AP#1 ×
    # of previous slippages (0/1/2/3+), each with # loans and POS ₹."""
    df = _read_slippage()
    if df.empty:
        return {"freqs": FREQ_BUCKETS, "rows": []}
    df = _apply_filters(df, filters)
    if df.empty:
        return {"freqs": FREQ_BUCKETS, "rows": []}

    df = df.copy()
    df["_fb"] = df["prev_slippage_count"].map(_freq_bucket)

    # Frequency filter (slices the population to one bucket)
    if freq and freq != "all":
        want = "3+" if freq in ("3", "3+") else freq
        df = df[df["_fb"] == want]
        if df.empty:
            return {"freqs": [want], "rows": []}

    freqs = [b for b in FREQ_BUCKETS if (df["_fb"] == b).any()]
    a1 = _safe(df, group_by)

    cnt = df.groupby([a1, "_fb"])["loan_id"].count()
    pos = df.groupby([a1, "_fb"])["pos"].sum()

    rows = []
    for gv, sub in df.groupby(a1, dropna=False):
        cells = [{"count": int(cnt.get((gv, b), 0)), "pos": float(pos.get((gv, b), 0))} for b in freqs]
        rows.append({"name": str(gv), "cells": cells,
                     "total_count": int(len(sub)), "total_pos": float(sub["pos"].sum())})
    _order_rows(rows, group_by)

    gcells = [{"count": int((df["_fb"] == b).sum()),
               "pos": float(df[df["_fb"] == b]["pos"].sum())} for b in freqs]
    rows.append({"name": "Grand Total", "cells": gcells,
                 "total_count": int(len(df)), "total_pos": float(df["pos"].sum()), "is_total": True})

    return {"freqs": freqs, "rows": rows}


# ═════════════════════════════════════════════════════════════════════════════
# OD SLIPPAGE report (Excel "OD Slippage" sheet) — current OD-slippage loans
# broken down by AP#1 (× AP#2) × # of previous slippages (12M), # and POS ₹.
# ═════════════════════════════════════════════════════════════════════════════

# Columns the OD Slippage loan-wise CSV ships, in order.
OD_SLIP_EXPORT_COLS = [
    "loan_id", "business_segment", "loan_status", "in_od_matrix",
    "prev_slippage_count", "pos",
    "zone_name", "cluster_name", "region_name", "area_name", "branch_name",
    "branch_id", "lo_id", "state_id", "district_id",
]


@router.get("/od-slippage/loans")
def od_slippage_loans(filters: dict = Depends(_filter_params),
                      user: dict = Depends(require_export)):
    """Loan-wise rows for the CSV, under the same filters and data scope as the
    page. rpt_od_slippage is already loan grain, so no separate source is needed.

    Read UNFILTERED by in_od_matrix and ship the flag as a COLUMN: the file then
    explains itself — matrix-basis rows (what the OD Status matrix and the Excel
    sheet count) and the loans that slipped but have since been written off, in
    one file, distinguishable. The page's own total/split cards use the same
    split, so the CSV reconciles to what is on screen.
    """
    df = read_report("rpt_od_slippage")
    if df.empty:
        return {"rows": [], "columns": OD_SLIP_EXPORT_COLS}
    df = _apply_filters(_enrich_slippage(df), filters)
    if df.empty:
        return {"rows": [], "columns": OD_SLIP_EXPORT_COLS}
    cols = [c for c in OD_SLIP_EXPORT_COLS if c in df.columns]
    out = df[cols].copy()
    if "in_od_matrix" in out.columns:
        out["in_od_matrix"] = out["in_od_matrix"].map(
            lambda v: "Counts in OD matrix" if bool(v) else "Excluded - written off")
    sort = [c for c in ("prev_slippage_count", "pos") if c in out.columns]
    if sort:
        out = out.sort_values(sort, ascending=False)
    return {"rows": out.fillna("").to_dict("records"), "columns": cols}


@router.get("/od-slippage/kpis")
def od_slippage_kpis(filters: dict = Depends(_filter_params), user: dict = Depends(get_current_user)):
    # Read UNFILTERED here, unlike every other consumer: this page is the one
    # that has to show the whole picture. rpt_od_slippage carries loans that
    # slipped and were then written off (in_od_matrix = FALSE); the listed rows
    # and the matrix column exclude them, so without this the page total sits
    # below MTD FTOD with no explanation — which is exactly what was reported
    # (4,000 vs 3,997). all_count reconciles to rpt_collection.mtd_ftod.
    raw = read_report("rpt_od_slippage")
    if raw.empty:
        return {}
    raw = _apply_filters(_enrich_slippage(raw), filters).copy()
    if raw.empty:
        return {"total_count": 0, "total_pos": 0, "first_time": 0, "repeat": 0,
                "all_count": 0, "excluded_writeoff": 0}
    in_matrix = (raw["in_od_matrix"].astype(bool) if "in_od_matrix" in raw.columns
                 else pd.Series(True, index=raw.index))
    df = raw[in_matrix]
    return {
        # listed rows — the OD Status matrix basis, write-offs dropped
        "total_count": int(len(df)),
        "total_pos":   float(df["pos"].sum()),
        "first_time":  int((df["prev_slippage_count"] == 0).sum()),   # 0 previous slippages
        "repeat":      int((df["prev_slippage_count"] > 0).sum()),     # slipped before
        # every loan that slipped this month, and the part not listed above
        "all_count":         int(len(raw)),
        "excluded_writeoff": int((~in_matrix).sum()),
    }


@router.get("/od-slippage/group-summary")
def od_slippage_group_summary(
    group_by: str = Query("business_segment"),
    group_by_2: Optional[str] = Query(None),
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    """OD Slippage — AP#1 (× AP#2) × # of previous slippages (0/1/2/3+),
    each with # loans and POS ₹, plus Total # and Total POS ₹ per row."""
    df = _read_slippage()
    if df.empty:
        return {"freqs": FREQ_BUCKETS, "rows": []}
    df = _apply_filters(_enrich_slippage(df), filters).copy()
    if df.empty:
        return {"freqs": FREQ_BUCKETS, "rows": []}

    df["_fb"] = df["prev_slippage_count"].map(_freq_bucket)
    freqs = [b for b in FREQ_BUCKETS if (df["_fb"] == b).any()] or ["0"]
    a1 = _safe(df, group_by)
    a2 = _safe(df, group_by_2) if group_by_2 and group_by_2 != "none" else None
    keys = [a1] + ([a2] if a2 else [])

    cnt = df.groupby(keys + ["_fb"])["loan_id"].count()
    pos = df.groupby(keys + ["_fb"])["pos"].sum()

    rows = []
    for gv, sub in df.groupby(keys, dropna=False):
        gv = gv if isinstance(gv, tuple) else (gv,)
        cells = [{"count": int(cnt.get(gv + (b,), 0)), "pos": float(pos.get(gv + (b,), 0))} for b in freqs]
        rows.append({"name": str(gv[0]), "name2": str(gv[1]) if a2 else None, "cells": cells,
                     "total_count": int(len(sub)), "total_pos": float(sub["pos"].sum())})
    _order_rows(rows, group_by)

    gcells = [{"count": int((df["_fb"] == b).sum()),
               "pos": float(df[df["_fb"] == b]["pos"].sum())} for b in freqs]
    rows.append({"name": "Grand Total", "name2": None, "cells": gcells,
                 "total_count": int(len(df)), "total_pos": float(df["pos"].sum()), "is_total": True})

    return {"freqs": freqs, "rows": rows}


@router.get("/od-status/list")
def od_status_list(
    filters: dict = Depends(_filter_params),
    limit: int = Query(200, le=2000),
    offset: int = Query(0),
    sort: str = Query("dpd"),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_od_list")
    if df.empty:
        return {"total": 0, "rows": []}
    df = _apply_filters(df, filters)
    total = len(df)
    if sort in df.columns:
        df = df.sort_values(sort, ascending=False)
    page = df.iloc[offset: offset + limit].copy()
    return {
        "total": int(total),
        "od_amt": float(df["od_amt"].sum()) if "od_amt" in df.columns else 0,
        "pos": float(df["pos"].sum()) if "pos" in df.columns else 0,
        "rows": page.fillna("").to_dict("records"),
    }
