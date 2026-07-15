from fastapi import APIRouter, Depends, Query
from typing import Optional
from core.db import read_report, reports_conn
from core.trend import build_trend
from auth.deps import get_current_user
import pandas as pd

router = APIRouter()

BUCKET_ORDER = [
    "Regular", "1 - 30", "31 - 60", "61 - 90",
    "91 - 180", "181 - 360", "360 +", "Write-Off",
]

# All valid group_by dimensions (AP#1 / AP#2 selectors — 23 parameters)
VALID_DIMS = {
    # Geography
    "business_segment", "zone_name", "cluster_name", "region_name",
    "area_name", "branch_name", "state_id", "district_id",
    # Product / Status
    "prod_classification", "curr_od_status", "dpd_bucket",
    "od_movement_status", "bucket_movement", "loan_status", "loan_source",
    # Loan attributes (available in DB)
    "disb_year", "cycle_no",
    # Future columns — not yet in DB; return empty gracefully via column check
    "purpose_id", "caste", "religion", "rural_urban",
    "facility_id", "lender_id", "loan_id", "dq_category",
}


def _scope(df: pd.DataFrame, user: dict) -> pd.DataFrame:
    # Row-level scope is applied centrally in read_report (core/db.py via
    # core/scope.py) — kept as identity for backward compatibility.
    return df


def _vals(raw: Optional[str]) -> list[str]:
    if not raw or raw == "ALL":
        return []
    return [v for v in (x.strip() for x in str(raw).split(",")) if v and v != "ALL"]


def _multi(df: pd.DataFrame, col: str, raw: Optional[str]) -> pd.DataFrame:
    vals = _vals(raw)
    if vals and col in df.columns:
        df = df[df[col].astype(str).isin(vals)]
    return df


def _hier_filter(
    df: pd.DataFrame,
    zone: Optional[str] = None,
    cluster: Optional[str] = None,
    region: Optional[str] = None,
    area: Optional[str] = None,
    branch: Optional[str] = None,
    prod_class: Optional[str] = None,
    od_status: Optional[str] = None,
    od_bucket: Optional[str] = None,
    od_movement: Optional[str] = None,
    bucket_movement: Optional[str] = None,
    branch_state: Optional[str] = None,
    district: Optional[str] = None,
    disb_year: Optional[str] = None,
    cycle: Optional[str] = None,
    purpose: Optional[str] = None,
    facility: Optional[str] = None,
    lender: Optional[str] = None,
    caste: Optional[str] = None,
    religion: Optional[str] = None,
) -> pd.DataFrame:
    df = _multi(df, "zone_name",          zone)
    df = _multi(df, "cluster_name",       cluster)
    df = _multi(df, "region_name",        region)
    df = _multi(df, "area_name",          area)
    df = _multi(df, "branch_name",        branch)
    df = _multi(df, "prod_classification", prod_class)
    df = _multi(df, "curr_od_status",     od_status)
    df = _multi(df, "dpd_bucket",         od_bucket)
    df = _multi(df, "od_movement_status", od_movement)
    df = _multi(df, "bucket_movement",    bucket_movement)
    df = _multi(df, "state_id",           branch_state)
    df = _multi(df, "district_id",        district)
    df = _multi(df, "disb_year",          disb_year)
    df = _multi(df, "cycle_no",           cycle)
    df = _multi(df, "purpose_id",         purpose)
    df = _multi(df, "facility_id",        facility)
    df = _multi(df, "lender_id",          lender)
    df = _multi(df, "caste",              caste)
    df = _multi(df, "religion",           religion)
    return df


SEGMENT_ORDER = ["IEL", "JLG", "LAP"]


def _segment_filter(df: pd.DataFrame, segment: str, loan_source: str) -> pd.DataFrame:
    if _vals(segment) and "business_segment" in df.columns:
        df = _multi(df, "business_segment", segment)
    elif loan_source and loan_source != "ALL":
        df = df[df["loan_source"] == loan_source]
    return df


def _active_set(df: pd.DataFrame, loan_status: Optional[str]) -> pd.DataFrame:
    """Current Outstanding = Active + Death + Write-off. loan_status slicer narrows if provided."""
    if _vals(loan_status) and "loan_status" in df.columns:
        return df[df["loan_status"].astype(str).isin(_vals(loan_status))]
    return df


def _group_agg(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    return df.groupby(cols, as_index=False).agg(
        pos=("total_pos", "sum"),
        loans=("loan_count", "sum"),
        par0=("par0_pos", "sum"),
        par30=("par30_pos", "sum"),
        par60=("par60_pos", "sum"),
        par90=("par90_pos", "sum"),
    )


def _to_row(r, name_col: str, name2_col: Optional[str] = None) -> dict:
    pos = float(r["pos"])
    row = {
        "name":  str(r[name_col]),
        "pos":   pos,
        "loans": int(r["loans"]),
        "par0_pct":  round(float(r["par0"])  / pos * 100, 2) if pos else 0,
        "par30_pct": round(float(r["par30"]) / pos * 100, 2) if pos else 0,
        "par60_pct": round(float(r["par60"]) / pos * 100, 2) if pos else 0,
        "par90_pct": round(float(r["par90"]) / pos * 100, 2) if pos else 0,
    }
    if name2_col:
        row["name2"] = str(r[name2_col])
    return row


def _common_params():
    """Shared query param defaults — used in type hints below."""
    return {}


@router.get("/aum/status")
def aum_status(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None),
    od_status: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None),
    od_movement: Optional[str] = Query(None),
    bucket_movement: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None),
    purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None),
    lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None),
    religion: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    df = _scope(read_report("rpt_aum_status"), user)
    if df.empty:
        return []
    df = _segment_filter(df, segment, loan_source)
    df = _active_set(df, loan_status)
    df = _hier_filter(df, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, od_movement, bucket_movement, branch_state, district, disb_year, cycle, purpose, facility, lender, caste, religion)
    return df.fillna("").to_dict("records")


@router.get("/aum/kpis")
def aum_kpis(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None),
    od_status: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None),
    od_movement: Optional[str] = Query(None),
    bucket_movement: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None),
    purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None),
    lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None),
    religion: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    df = _scope(read_report("rpt_aum_status"), user)
    if df.empty:
        return {}

    df = _segment_filter(df, segment, loan_source)
    df = _hier_filter(df, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, od_movement, bucket_movement, branch_state, district, disb_year, cycle, purpose, facility, lender, caste, religion)
    base = _active_set(df, loan_status)

    total_pos   = float(base["total_pos"].sum())
    total_loans = int(base["loan_count"].sum())
    par0  = float(base["par0_pos"].sum())
    par30 = float(base["par30_pos"].sum())
    par60 = float(base["par60_pos"].sum())
    par90 = float(base["par90_pos"].sum())

    wo_rows  = base[base["loan_status"].astype(str) == "Write-off"] if "loan_status" in base.columns else base.iloc[0:0]
    wo_pos   = float(wo_rows["total_pos"].sum())
    wo_count = int(wo_rows["loan_count"].sum())

    return {
        "total_pos":   total_pos,
        "total_loans": total_loans,
        "par0_pos":  par0,
        "par0_pct":  round(par0  / total_pos * 100, 2) if total_pos else 0,
        "par30_pos": par30,
        "par30_pct": round(par30 / total_pos * 100, 2) if total_pos else 0,
        "par60_pos": par60,
        "par60_pct": round(par60 / total_pos * 100, 2) if total_pos else 0,
        "par90_pos": par90,
        "par90_pct": round(par90 / total_pos * 100, 2) if total_pos else 0,
        "wo_pos":   wo_pos,
        "wo_count": wo_count,
    }


@router.get("/aum/segment-summary")
def aum_segment_summary(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None),
    od_status: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None),
    od_movement: Optional[str] = Query(None),
    bucket_movement: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None),
    purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None),
    lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None),
    religion: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    df = _scope(read_report("rpt_aum_status"), user)
    if df.empty:
        return []

    df = _segment_filter(df, segment, loan_source)
    df = _hier_filter(df, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, od_movement, bucket_movement, branch_state, district, disb_year, cycle, purpose, facility, lender, caste, religion)
    active = _active_set(df, loan_status)

    seg_col = "business_segment" if "business_segment" in active.columns else "loan_source"
    grp = active.groupby(seg_col, as_index=False).agg(
        pos=("total_pos", "sum"), loans=("loan_count", "sum"),
        par0=("par0_pos", "sum"), par30=("par30_pos", "sum"),
        par60=("par60_pos", "sum"), par90=("par90_pos", "sum"),
    )
    grp["_ord"] = grp[seg_col].apply(
        lambda s: SEGMENT_ORDER.index(s) if s in SEGMENT_ORDER else len(SEGMENT_ORDER)
    )
    grp = grp.sort_values("_ord")

    rows = [_to_row(r, seg_col) for _, r in grp.iterrows()]
    total_pos = float(active["total_pos"].sum())
    rows.append({
        "name": "Grand Total", "pos": total_pos, "loans": int(active["loan_count"].sum()),
        "par0_pct":  round(float(active["par0_pos"].sum())  / total_pos * 100, 2) if total_pos else 0,
        "par30_pct": round(float(active["par30_pos"].sum()) / total_pos * 100, 2) if total_pos else 0,
        "par60_pct": round(float(active["par60_pos"].sum()) / total_pos * 100, 2) if total_pos else 0,
        "par90_pct": round(float(active["par90_pos"].sum()) / total_pos * 100, 2) if total_pos else 0,
    })
    return rows


@router.get("/aum/group-summary")
def aum_group_summary(
    group_by: str = Query("business_segment"),
    group_by_2: Optional[str] = Query(None),        # AP#2 secondary dimension
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None),
    od_status: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None),
    od_movement: Optional[str] = Query(None),
    bucket_movement: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None),
    purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None),
    lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None),
    religion: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    """Aggregate AUM by one or two dimensions (AP#1 × AP#2).
    Returns GroupSummaryRow[]; when group_by_2 is set each row also has 'name2'.
    Grand Total row has name2=null / omitted."""
    g1 = group_by  if group_by  in VALID_DIMS else "business_segment"
    g2 = group_by_2 if group_by_2 and group_by_2 in VALID_DIMS and group_by_2 != "none" else None

    df = _scope(read_report("rpt_aum_status"), user)
    if df.empty:
        return []

    df = _segment_filter(df, segment, loan_source)
    df = _hier_filter(df, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, od_movement, bucket_movement, branch_state, district, disb_year, cycle, purpose, facility, lender, caste, religion)
    base = _active_set(df, loan_status)

    if g1 not in base.columns:
        return []

    cols = [g1, g2] if g2 and g2 in base.columns else [g1]
    grp = _group_agg(base, cols).sort_values("pos", ascending=False)

    rows = [_to_row(r, g1, g2 if g2 and g2 in base.columns else None) for _, r in grp.iterrows()]

    total_pos = float(base["total_pos"].sum())
    rows.append({
        "name": "Grand Total", "pos": total_pos, "loans": int(base["loan_count"].sum()),
        "par0_pct":  round(float(base["par0_pos"].sum())  / total_pos * 100, 2) if total_pos else 0,
        "par30_pct": round(float(base["par30_pos"].sum()) / total_pos * 100, 2) if total_pos else 0,
        "par60_pct": round(float(base["par60_pos"].sum()) / total_pos * 100, 2) if total_pos else 0,
        "par90_pct": round(float(base["par90_pos"].sum()) / total_pos * 100, 2) if total_pos else 0,
    })
    return rows


@router.get("/aum/bucket-by-branch")
def bucket_by_branch(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None),
    od_status: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None),
    od_movement: Optional[str] = Query(None),
    bucket_movement: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None),
    purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None),
    lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None),
    religion: Optional[str] = Query(None),
    top_n: int = Query(15),
    user: dict = Depends(get_current_user),
):
    df = _scope(read_report("rpt_aum_status"), user)
    if df.empty:
        return []

    active = _active_set(df, loan_status)
    active = _segment_filter(active, segment, loan_source)
    active = _hier_filter(active, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, bucket_movement, branch_state, district, disb_year, cycle)

    top = (active.groupby("branch_name")["total_pos"].sum()
           .nlargest(top_n).index.tolist())
    sub = active[active["branch_name"].isin(top)]
    grp = sub.groupby(["branch_name", "dpd_bucket"], as_index=False).agg(
        pos=("total_pos", "sum"),
        loans=("loan_count", "sum"),
    )
    return grp.to_dict("records")


@router.get("/aum/par-by-branch")
def par_by_branch(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None),
    od_status: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None),
    od_movement: Optional[str] = Query(None),
    bucket_movement: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None),
    purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None),
    lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None),
    religion: Optional[str] = Query(None),
    top_n: int = Query(15),
    user: dict = Depends(get_current_user),
):
    df = _scope(read_report("rpt_aum_status"), user)
    if df.empty:
        return []

    active = _active_set(df, loan_status)
    active = _segment_filter(active, segment, loan_source)
    active = _hier_filter(active, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, bucket_movement, branch_state, district, disb_year, cycle)

    grp = active.groupby("branch_name", as_index=False).agg(
        total_pos=("total_pos", "sum"),
        par0=("par0_pos", "sum"),
        par30=("par30_pos", "sum"),
        par90=("par90_pos", "sum"),
    ).sort_values("total_pos", ascending=False).head(top_n)

    result = []
    for _, r in grp.iterrows():
        pos = float(r["total_pos"])
        result.append({
            "branch": r["branch_name"],
            "total_pos": pos,
            "par0": float(r["par0"]),
            "par30": float(r["par30"]),
            "par90": float(r["par90"]),
            "par0_pct":  round(float(r["par0"])  / pos * 100, 2) if pos else 0,
            "par30_pct": round(float(r["par30"]) / pos * 100, 2) if pos else 0,
            "par90_pct": round(float(r["par90"]) / pos * 100, 2) if pos else 0,
        })
    return result


@router.get("/aum/hierarchy")
def hierarchy(user: dict = Depends(get_current_user)):
    df = _scope(read_report("rpt_aum_status"), user)
    if df.empty:
        return {"zones": [], "clusters": [], "regions": [], "areas": [], "branches": []}
    return {
        "zones":    sorted(df["zone_name"].dropna().unique().tolist())    if "zone_name"    in df.columns else [],
        "clusters": sorted(df["cluster_name"].dropna().unique().tolist()),
        "regions":  sorted(df["region_name"].dropna().unique().tolist()),
        "areas":    sorted(df["area_name"].dropna().unique().tolist()),
        "branches": sorted(df["branch_name"].dropna().unique().tolist()),
    }


@router.get("/aum/trend")
def aum_trend(
    freq: str = Query("month", pattern="^(month|quarter|year)$"),
    fy:   Optional[str] = Query(None),
    yoy:  bool = Query(False),
    user: dict = Depends(get_current_user),
):
    """AUM (POS) trend on the Indian fiscal calendar (Apr → Mar).
    month   → months of the selected FY, starting April
    quarter → FY quarters (selected FY, or last 4 by default)
    year    → FY-wise across all available years
    yoy=1   → selected FY vs previous FY, aligned by month / quarter.
    AUM is a period-END stock, so buckets take the last month's value.
    Portfolio-wide (rpt_trend_monthly carries no dimensions)."""
    df = read_report("rpt_trend_monthly")
    return build_trend(
        df, freq=freq, fy=fy, yoy=yoy,
        metrics={"pos": "total_pos", "loans": "total_loans"},
        stock=True,
    )


@router.get("/aum/refresh")
def last_refresh(user: dict = Depends(get_current_user)):
    """Data as-of date = T-1 (warehouse only holds through yesterday).
    Derived from rpt_aum_status.as_of_date (pipeline run date) minus 1 day."""
    df = read_report("rpt_aum_status")
    if df.empty or "as_of_date" not in df.columns:
        return {"refresh": "—"}
    ts = pd.to_datetime(df["as_of_date"]).max() - pd.Timedelta(days=1)
    try:
        label = ts.strftime("%-d %b %Y") if pd.notna(ts) else "—"
    except ValueError:
        label = ts.strftime("%d %b %Y") if pd.notna(ts) else "—"
    return {"refresh": label}
