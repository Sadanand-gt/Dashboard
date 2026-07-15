"""
dq_category.py — DQ Category (Delinquency Category) report.

Mirrors the Excel "DQ Category" sheet: Early DQ (Eligible / Count / %) and Infant
DQ (Eligible / Count / %) by AP#1 (× optional AP#2).  Eligible = loans that first
came due within ~8 mo (Early) / ~3 mo (Infant); Count = eligible AND currently OD;
% = POS-weighted OD share of eligible (per the Power Pivot DAX).  Served from
rpt_dq_category. Honors the full slicer set + Portfolio (With / Excl. W/O) toggle.
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional
import pandas as pd
from core.db import read_report
from core.filters import hier, segment_filter, multi
from auth.deps import get_current_user

router = APIRouter()

DPD_BUCKET_ORDER = ["Regular", "1 - 30", "31 - 60", "61 - 90", "91 - 180", "181 - 360", "360 +"]
_BUCKET_RANK = {b: i for i, b in enumerate(DPD_BUCKET_ORDER)}

DIM_COL = {
    "business_segment": "business_segment", "loan_source": "loan_source",
    "zone_name": "zone_name", "cluster_name": "cluster_name", "region_name": "region_name",
    "area_name": "area_name", "branch_name": "branch_name", "state_id": "state_id",
    "district_id": "district_id", "prod_classification": "prod_classification",
    "dpd_bucket": "dpd_bucket", "loan_status": "loan_status", "disb_year": "disb_year",
    "cycle_no": "cycle_no", "purpose_id": "purpose_id", "facility_id": "facility_id",
    "lender_id": "lender_id", "caste": "caste", "religion": "religion",
}


def _apply_filters(df, f) -> pd.DataFrame:
    if f.get("portfolio") == "without" and "loan_status" in df.columns:
        df = df[df["loan_status"] != "Write-off"]
    df = segment_filter(df, f.get("segment") or "ALL")
    df = hier(df, f.get("cluster"), f.get("region"), f.get("area"), f.get("branch"), zone=f.get("zone"))
    df = multi(df, "state_id",            f.get("branch_state"))
    df = multi(df, "district_id",         f.get("district"))
    df = multi(df, "prod_classification", f.get("prod_class"))
    df = multi(df, "dpd_bucket",          f.get("od_bucket"))
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
    prod_class: Optional[str] = Query(None), od_bucket: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None), disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None), purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None), lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None), religion: Optional[str] = Query(None),
    portfolio: Optional[str] = Query(None),
) -> dict:
    return dict(
        segment=segment, zone=zone, cluster=cluster, region=region, area=area,
        branch=branch, branch_state=branch_state, district=district, prod_class=prod_class,
        od_bucket=od_bucket, loan_status=loan_status, disb_year=disb_year, cycle=cycle,
        purpose=purpose, facility=facility, lender=lender, caste=caste, religion=religion,
        portfolio=portfolio,
    )


def _safe_col(df: pd.DataFrame, key: str) -> str:
    col = DIM_COL.get(key, key)
    if col not in df.columns:
        df[col] = "N/A"
    return col


def _metrics(g) -> dict:
    ee_pos = float(g["early_elig_pos"].sum())
    ie_pos = float(g["infant_elig_pos"].sum())
    return {
        "early_eligible":  int(g["early_elig_cnt"].sum()),
        "early_count":     int(g["early_od_cnt"].sum()),
        "early_pct":       round(float(g["early_od_pos"].sum()) / ee_pos * 100, 2) if ee_pos else 0,
        "infant_eligible": int(g["infant_elig_cnt"].sum()),
        "infant_count":    int(g["infant_od_cnt"].sum()),
        "infant_pct":      round(float(g["infant_od_pos"].sum()) / ie_pos * 100, 2) if ie_pos else 0,
    }


@router.get("/dq-category/kpis")
def dq_kpis(filters: dict = Depends(_filter_params), user: dict = Depends(get_current_user)):
    df = read_report("rpt_dq_category")
    if df.empty:
        return {}
    df = _apply_filters(df, filters)
    if df.empty:
        return {}
    return _metrics(df)


@router.get("/dq-category/group-summary")
def dq_group_summary(
    group_by: str = Query("business_segment"),
    group_by_2: Optional[str] = Query(None),
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_dq_category")
    if df.empty:
        return []
    df = _apply_filters(df, filters)
    if df.empty:
        return []

    col1 = _safe_col(df, group_by)
    col2 = _safe_col(df, group_by_2) if group_by_2 and group_by_2 != "none" else None
    keys = [col1] + ([col2] if col2 else [])

    rows = []
    for gv, g in df.groupby(keys, dropna=False):
        gv = gv if isinstance(gv, tuple) else (gv,)
        r = {"name": str(gv[0]), "name2": str(gv[1]) if col2 else None}
        r.update(_metrics(g))
        rows.append(r)
    if group_by == "dpd_bucket":
        rows.sort(key=lambda r: _BUCKET_RANK.get(r["name"], 99))
    else:
        rows.sort(key=lambda r: -r["early_eligible"])

    r = {"name": "Grand Total", "name2": None}
    r.update(_metrics(df))
    rows.append({**r, "is_total": True})
    return rows


@router.get("/dq-category/refresh")
def dq_refresh(user: dict = Depends(get_current_user)):
    df = read_report("rpt_aum_status")
    try:
        ts = pd.to_datetime(df["as_of_date"]).max()
        return {"refresh": ts.strftime("%d %b %Y") if pd.notna(ts) else "—"}
    except Exception:
        return {"refresh": "—"}
