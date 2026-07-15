"""
bucket_movement.py — Bucket Movement transition matrix.

Replicates the Excel "Bucket Movement" sheet: a Previous-Month bucket (rows) ×
Current-Month bucket (cols) matrix, in POS ₹, POS % and # Loans, plus an
Improved / Static / Worsened summary.

Served from rpt_aum_status (no new pipeline):
  • dpd_bucket       = current live-DPD bucket (Current Month)
  • prev_dpd_bucket  = EOM-DPD bucket at previous month-end (Previous Month)
Respects the global slicer filters + Portfolio (With / Excl. W/O) toggle.
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional
import pandas as pd
from core.db import read_report
from core.filters import hier, segment_filter, multi
from auth.deps import get_current_user

router = APIRouter()

# Pure DPD buckets (no Write-Off) — the matrix axes, in order
BUCKETS = ["Regular", "1 - 30", "31 - 60", "61 - 90", "91 - 180", "181 - 360", "360 +"]


def _apply_filters(df, f) -> pd.DataFrame:
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
    return df


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
    portfolio: Optional[str] = Query(None),
) -> dict:
    return dict(
        segment=segment, zone=zone, cluster=cluster, region=region, area=area,
        branch=branch, branch_state=branch_state, district=district, prod_class=prod_class,
        od_status=od_status, od_bucket=od_bucket, bucket_movement=bucket_movement,
        loan_status=loan_status, disb_year=disb_year, cycle=cycle, purpose=purpose,
        facility=facility, lender=lender, caste=caste, religion=religion, portfolio=portfolio,
    )


def _bucket_idx(b: str) -> int:
    try:
        return BUCKETS.index(b)
    except ValueError:
        return 99  # Write-Off / unknown → sorts last


@router.get("/bucket-movement/matrix")
def bucket_movement_matrix(
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_aum_status")
    if df.empty or "prev_dpd_bucket" not in df.columns:
        return {"buckets": BUCKETS, "pos": [], "loans": [], "summary": []}
    df = _apply_filters(df, filters)
    if df.empty:
        return {"buckets": BUCKETS, "pos": [], "loans": [], "summary": []}

    # Both axes use pure DPD buckets (curr_dpd_bucket has no W override, so
    # write-off loans fall into their real DPD bucket, e.g. 181-360 / 360+).
    # Portfolio toggle (With / Excl. W/O) controls whether W loans are included.
    cols = list(BUCKETS)
    pos = df.groupby(["prev_dpd_bucket", "curr_dpd_bucket"])["total_pos"].sum()
    cnt = df.groupby(["prev_dpd_bucket", "curr_dpd_bucket"])["loan_count"].sum()

    def matrix(series, cast):
        out = []
        for pb in BUCKETS:  # rows = previous-month bucket (pure)
            row = {"bucket": pb, "cells": [], "total": 0}
            tot = 0
            for cb in cols:
                v = cast(series.get((pb, cb), 0))
                row["cells"].append(v)
                tot += v
            row["total"] = tot
            out.append(row)
        # column totals row
        coltot = {"bucket": "Grand Total", "cells": [], "total": 0}
        gt = 0
        for cb in cols:
            v = cast(sum(series.get((pb, cb), 0) for pb in BUCKETS))
            coltot["cells"].append(v)
            gt += v
        coltot["total"] = gt
        out.append(coltot)
        return out

    pos_m = matrix(pos, lambda v: round(float(v), 2))
    cnt_m = matrix(cnt, lambda v: int(v))

    # Improved / Static / Worsened by previous bucket.
    # Excel has both a POS-weighted (POS %) and a count-weighted (# Loans %) view.
    dfp = df.copy()
    dfp["_pi"] = dfp["prev_dpd_bucket"].map(_bucket_idx)
    dfp["_ci"] = dfp["curr_dpd_bucket"].map(_bucket_idx)
    dfp["_mv"] = dfp.apply(
        lambda r: "Improved" if r["_ci"] < r["_pi"] else ("Worsened" if r["_ci"] > r["_pi"] else "Static"),
        axis=1,
    )

    def summarize(valcol: str, cast) -> list:
        out = []
        for pb in BUCKETS:
            sub = dfp[dfp["prev_dpd_bucket"] == pb]
            tot = float(sub[valcol].sum())
            if tot <= 0:
                continue
            out.append({
                "bucket": pb, "value": cast(tot),
                "improved_pct": round(float(sub[sub["_mv"] == "Improved"][valcol].sum()) / tot * 100, 2),
                "static_pct":   round(float(sub[sub["_mv"] == "Static"][valcol].sum())   / tot * 100, 2),
                "worsened_pct": round(float(sub[sub["_mv"] == "Worsened"][valcol].sum()) / tot * 100, 2),
            })
        tot_all = float(dfp[valcol].sum())
        if tot_all > 0:
            out.append({
                "bucket": "Total", "value": cast(tot_all),
                "improved_pct": round(float(dfp[dfp["_mv"] == "Improved"][valcol].sum()) / tot_all * 100, 2),
                "static_pct":   round(float(dfp[dfp["_mv"] == "Static"][valcol].sum())   / tot_all * 100, 2),
                "worsened_pct": round(float(dfp[dfp["_mv"] == "Worsened"][valcol].sum()) / tot_all * 100, 2),
            })
        return out

    return {
        "buckets": cols, "pos": pos_m, "loans": cnt_m,
        "summary_pos":   summarize("total_pos",  lambda v: round(v, 2)),
        "summary_loans": summarize("loan_count", lambda v: int(v)),
    }


@router.get("/bucket-movement/kpis")
def bucket_movement_kpis(
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_aum_status")
    if df.empty or "prev_dpd_bucket" not in df.columns:
        return {}
    df = _apply_filters(df, filters)
    dfp = df.copy()
    tot = float(dfp["total_pos"].sum())
    if tot <= 0:
        return {"total_pos": 0, "loan_count": 0, "improved_pct": 0, "static_pct": 0, "worsened_pct": 0}
    pi = dfp["prev_dpd_bucket"].map(_bucket_idx)
    ci = dfp["curr_dpd_bucket"].map(_bucket_idx)
    imp = float(dfp[ci < pi]["total_pos"].sum())
    wor = float(dfp[ci > pi]["total_pos"].sum())
    sta = tot - imp - wor
    return {
        "total_pos": tot,
        "loan_count":    int(dfp["loan_count"].sum()),
        "improved_pct":  round(imp / tot * 100, 2),
        "static_pct":    round(sta / tot * 100, 2),
        "worsened_pct":  round(wor / tot * 100, 2),
        "improved_count": int(dfp[ci < pi]["loan_count"].sum()),
        "worsened_count": int(dfp[ci > pi]["loan_count"].sum()),
        "static_count":   int(dfp[ci == pi]["loan_count"].sum()),
    }
