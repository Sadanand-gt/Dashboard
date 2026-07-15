from fastapi import APIRouter, Depends, Query
from typing import Optional
import pandas as pd
from core.db import read_report
from core.filters import hier, segment_filter, multi
from auth.deps import get_current_user

router = APIRouter()


# ═════════════════════════════════════════════════════════════════════════════
# LEGACY endpoints (still used by the Executive Summary daily KPIs).
# Backed by rpt_daily_collection / rpt_mtd_collection.
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/collection/daily")
def daily_collection(
    segment: str = Query("ALL"), loan_source: str = Query("ALL"),
    month_type: Optional[str] = Query(None), cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None), area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None), user: dict = Depends(get_current_user),
):
    df = read_report("rpt_daily_collection")
    if df.empty:
        return []
    df = segment_filter(df, segment, loan_source)
    if month_type:
        df = df[df["month_type"] == month_type]
    df = hier(df, cluster, region, area, branch)
    return df.fillna("").to_dict("records")


@router.get("/collection/daily/kpis")
def daily_kpis(
    segment: str = Query("ALL"), loan_source: str = Query("ALL"),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_daily_collection")
    if df.empty:
        return {}
    df = segment_filter(df, segment, loan_source)
    df = hier(df, cluster, region, area, branch)
    curr = df[df["month_type"] == "CURRENT"]
    if curr.empty:
        return {}
    latest = curr[curr["col_date"] == curr["col_date"].max()]
    demand_d = float(latest["daily_demand"].sum())
    coll_d = float(latest["daily_collection"].sum())
    demand_c = float(latest["cumul_demand"].sum())
    coll_c = float(latest["cumul_collection"].sum())
    return {
        "daily_ce": round(coll_d / demand_d * 100, 2) if demand_d else 0,
        "cumul_ce": round(coll_c / demand_c * 100, 2) if demand_c else 0,
        "daily_demand": demand_d, "daily_collection": coll_d,
        "cumul_demand": demand_c, "cumul_collection": coll_c,
    }


# ═════════════════════════════════════════════════════════════════════════════
# NEW endpoints — T-1 Collection & MTD Collection reports (rpt_collection).
# Full analysis-parameter set + slicer filters, matching the Excel sheets.
# ═════════════════════════════════════════════════════════════════════════════

def _apply_filters(
    df: pd.DataFrame,
    segment=None, zone=None, cluster=None, region=None, area=None, branch=None,
    branch_state=None, district=None, prod_class=None, od_status=None,
    od_bucket=None, bucket_movement=None, loan_status=None, disb_year=None,
    cycle=None, purpose=None, facility=None, lender=None, caste=None, religion=None,
    portfolio=None,
) -> pd.DataFrame:
    # Portfolio toggle: 'without' = exclude write-off loans (master + DB status)
    if portfolio == "without" and "loan_status" in df.columns:
        df = df[df["loan_status"] != "Write-off"]
    df = segment_filter(df, segment or "ALL")
    df = hier(df, cluster, region, area, branch, zone=zone)
    df = multi(df, "state_id",            branch_state)
    df = multi(df, "district_id",         district)
    df = multi(df, "prod_classification", prod_class)
    df = multi(df, "curr_od_status",      od_status)
    df = multi(df, "dpd_bucket",          od_bucket)
    df = multi(df, "bucket_movement",     bucket_movement)
    df = multi(df, "loan_status",         loan_status)
    df = multi(df, "disb_year",           disb_year)
    df = multi(df, "cycle_no",            cycle)
    df = multi(df, "purpose_id",          purpose)
    df = multi(df, "facility_id",         facility)
    df = multi(df, "lender_id",           lender)
    df = multi(df, "caste",               caste)
    df = multi(df, "religion",            religion)
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
        branch=branch, branch_state=branch_state, district=district,
        prod_class=prod_class, od_status=od_status, od_bucket=od_bucket,
        bucket_movement=bucket_movement, loan_status=loan_status, disb_year=disb_year,
        cycle=cycle, purpose=purpose, facility=facility, lender=lender,
        caste=caste, religion=religion, portfolio=portfolio,
    )


DIM_COL: dict[str, str] = {
    "business_segment": "business_segment", "loan_source": "loan_source",
    "zone_name": "zone_name", "cluster_name": "cluster_name", "region_name": "region_name",
    "area_name": "area_name", "branch_name": "branch_name", "state_id": "state_id",
    "district_id": "district_id", "prod_classification": "prod_classification",
    "curr_od_status": "curr_od_status", "dpd_bucket": "dpd_bucket",
    "bucket_movement": "bucket_movement", "loan_status": "loan_status",
    "cycle_no": "cycle_no", "disb_year": "disb_year", "purpose_id": "purpose_id",
    "facility_id": "facility_id", "lender_id": "lender_id", "caste": "caste",
    "religion": "religion", "lo_id": "lo_id", "product_id": "product_id",
}

_METRICS = ["t1_demand", "t1_collection", "t1_ftod", "t1_demand_count",
            "mtd_demand", "mtd_collection", "mtd_ontime", "mtd_ftod", "mtd_demand_count",
            "pmsd_demand", "pmsd_collection", "pmtd_demand", "pmtd_collection", "loan_count"]


def _safe_col(df: pd.DataFrame, key: str) -> str:
    col = DIM_COL.get(key, key)
    if col not in df.columns:
        df[col] = "N/A"
    return col


def _pct(num: float, den: float) -> float:
    """OTRR ratio — numerator capped at denominator (≤ 100). UNCHANGED per spec
    (OTRR & FTOD logic must not change)."""
    return round(min(num, den) / den * 100, 2) if den else 0


def _div(num: float, den: float) -> float:
    """Collection-efficiency ratio, .pbit logic: DIVIDE(collection, demand) — no cap."""
    return round(num / den * 100, 2) if den else 0


def _isum(g, col: str) -> int:
    return int(g[col].sum()) if col in g.columns else 0


def _row_metrics(g) -> dict:
    t1d, t1c = float(g["t1_demand"].sum()), float(g["t1_collection"].sum())
    md, mc = float(g["mtd_demand"].sum()), float(g["mtd_collection"].sum())
    mot = float(g["mtd_ontime"].sum())
    return {
        "loan_count":       int(g["loan_count"].sum()),
        "t1_demand_count":  _isum(g, "t1_demand_count"),
        "mtd_demand_count": _isum(g, "mtd_demand_count"),
        "t1_demand":    t1d,
        "t1_collection": t1c,
        "t1_ce":        _div(t1c, t1d),     # .pbit uncapped collection efficiency
        "t1_otrr":      _pct(t1c, t1d),     # OTRR — unchanged (capped)
        "t1_ftod":      int(g["t1_ftod"].sum()),
        "mtd_demand":   md,
        "mtd_collection": mc,
        "mtd_ce":       _div(mc, md),       # .pbit uncapped collection efficiency
        "mtd_ontime":   mot,
        "mtd_otrr":     _pct(mot, md),      # OTRR — unchanged (capped)
        "mtd_ftod":     int(g["mtd_ftod"].sum()),
    }


@router.get("/collection/kpis")
def collection_kpis(filters: dict = Depends(_filter_params), user: dict = Depends(get_current_user)):
    df = read_report("rpt_collection")
    if df.empty:
        return {}
    df = _apply_filters(df, **filters)
    if df.empty:
        return {}
    m = _row_metrics(df)
    # PMSD = previous month SAME DAY → T-1 comparison.  .pbit [CE % PMSD] caps the
    # numerator at demand (unlike the uncapped MTD CE / Efficiency MTD).
    psd, psc = float(df["pmsd_demand"].sum()), float(df["pmsd_collection"].sum())
    m["pmsd_demand"] = psd
    m["pmsd_collection"] = psc
    m["pmsd_ce"] = _pct(psc, psd)                       # .pbit [CE % PMSD] — capped
    # PMTD = previous month TO DATE → MTD comparison.  .pbit [CE till PMSD] — capped.
    ptd = float(df["pmtd_demand"].sum()) if "pmtd_demand" in df.columns else 0.0
    ptc = float(df["pmtd_collection"].sum()) if "pmtd_collection" in df.columns else 0.0
    m["pmtd_demand"] = ptd
    m["pmtd_collection"] = ptc
    m["pmtd_ce"] = _pct(ptc, ptd)                       # .pbit [CE till PMSD] — capped
    return m


@router.get("/collection/group-summary")
def collection_group_summary(
    group_by: str = Query("business_segment"),
    group_by_2: Optional[str] = Query(None),
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_collection")
    if df.empty:
        return []
    df = _apply_filters(df, **filters)
    if df.empty:
        return []

    col1 = _safe_col(df, group_by)
    col2 = _safe_col(df, group_by_2) if group_by_2 and group_by_2 != "none" else None
    keys = [col1] + ([col2] if col2 else [])

    rows = []
    for vals, g in df.groupby(keys, dropna=False):
        vals = vals if isinstance(vals, tuple) else (vals,)
        r = {"name": str(vals[0]), "name2": str(vals[1]) if col2 else None}
        r.update(_row_metrics(g))
        rows.append(r)

    r = {"name": "Grand Total", "name2": None}
    r.update(_row_metrics(df))
    rows.append(r)
    return rows


@router.get("/collection/refresh")
def collection_refresh(user: dict = Depends(get_current_user)):
    df = read_report("rpt_collection")
    if df.empty or "report_date" not in df.columns:
        return {"refresh": "—"}
    ts = pd.to_datetime(df["report_date"]).max()
    try:
        label = ts.strftime("%-d %b %Y") if pd.notna(ts) else "—"
    except ValueError:
        label = ts.strftime("%d %b %Y") if pd.notna(ts) else "—"
    return {"refresh": label}
