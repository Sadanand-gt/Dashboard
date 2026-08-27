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
    # "<id> - <NAME>" display forms of the above, plus the loan officer
    "zone_label", "cluster_label", "region_label", "area_label",
    "branch_label", "lo_name",
    # Product / Status
    "prod_classification", "curr_od_status", "dpd_bucket",
    "od_movement_status", "bucket_movement", "loan_status", "loan_source",
    # Source status verbatim (A/D/I/W/X). loan_status folds D and I into "Death";
    # this keeps the two death stages separable — D = claim not yet filed,
    # I = claim filed and principal already cleared.
    "status_code",
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


# "<id> - <NAME>" display column → the plain column to fall back on when the
# report table predates dba_add_aum_labels.sql.
LABEL_FALLBACK = {
    "zone_label":    "zone_name",
    "cluster_label": "cluster_name",
    "region_label":  "region_name",
    "area_label":    "area_name",
    "branch_label":  "branch_name",
    "lo_name":       "lo_id",
}


def _dim(df: pd.DataFrame, col: str) -> str:
    """Resolve a requested dimension to one that exists in this table."""
    if col in df.columns:
        return col
    return LABEL_FALLBACK.get(col, col)


def _vals(raw: Optional[str]) -> list[str]:
    if not raw or raw == "ALL":
        return []
    return [v for v in (x.strip() for x in str(raw).split(",")) if v and v != "ALL"]


def _multi(df: pd.DataFrame, col: str, raw: Optional[str]) -> pd.DataFrame:
    vals = _vals(raw)
    if vals and col in df.columns:
        df = df[df[col].astype(str).isin(vals)]
    return df


def _multi_lo(df: pd.DataFrame, raw: Optional[str]) -> pd.DataFrame:
    """Loan-officer filter.

    The slicer shows "<lo_id> - <NAME>", but matching happens on lo_id: the id is
    the stable key and it is present in every report table, whereas lo_name is
    only on rpt_aum_status. Bare ids are accepted too.
    """
    vals = _vals(raw)
    if not vals or "lo_id" not in df.columns:
        return df
    ids = {v.split(" - ", 1)[0].strip() for v in vals}
    return df[df["lo_id"].astype(str).str.strip().isin(ids)]


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
    lo: Optional[str] = None,
    status_code: Optional[str] = None,
    # Loan ID is a LOOKUP, not a grouping — one row per loan is unusable as an
    # AP dimension, so it filters instead. Comma-separated ids allowed.
    loan_id: Optional[str] = None,
) -> pd.DataFrame:
    df = _multi_lo(df, lo)
    df = _multi(df, "loan_id",           loan_id)
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
    df = _multi(df, "status_code",        status_code)
    return df


SEGMENT_ORDER = ["IEL", "JLG", "LAP"]


def _segment_filter(df: pd.DataFrame, segment: str, loan_source: str) -> pd.DataFrame:
    if _vals(segment) and "business_segment" in df.columns:
        df = _multi(df, "business_segment", segment)
    elif loan_source and loan_source != "ALL":
        df = df[df["loan_source"] == loan_source]
    return df


def _active_set(df: pd.DataFrame, loan_status: Optional[str]) -> pd.DataFrame:
    """Current Outstanding = Active + Death + Write-off. loan_status slicer narrows if provided.

    rpt_aum_status also carries movement-only loans (on-book at prev month-end but
    closed during the current month) purely for OD Status / Bucket Movement. They are
    always dropped here so the live book and its counts are unchanged. Keyed on
    open_now — loan_status alone is not enough, because a written-off loan that closed
    this month is (correctly) classified 'Write-off', not 'Closed'."""
    if "open_now" in df.columns:
        df = df[df["open_now"].fillna(True).astype(bool)]
    elif "loan_status" in df.columns:          # pre-migration fallback
        df = df[df["loan_status"].astype(str) != "Closed"]
    if _vals(loan_status) and "loan_status" in df.columns:
        return df[df["loan_status"].astype(str).isin(_vals(loan_status))]
    return df



def _aum_source(user, loan_id=None) -> pd.DataFrame:
    """Current Outstanding rows, scoped.

    Normally the aggregated rpt_aum_status. When a LOAN ID is supplied it reads
    rpt_aum_loans instead and synthesises the same measures per loan, because
    rpt_aum_status has no loan_id column — filtering it on loan_id was a SILENT
    NO-OP that returned the whole book while looking filtered.

    The two tables reconcile exactly (92,769 Excl W/O · 123,064 With W/O), so
    swapping the source changes the grain, never the totals.
    """
    if not loan_id:
        return _scope(read_report("rpt_aum_status"), user)
    df = _scope(read_report("rpt_aum_loans"), user)
    if df.empty:
        return df
    pos = pd.to_numeric(df.get("pos", 0), errors="coerce").fillna(0)
    dpd = pd.to_numeric(df.get("dpd", 0), errors="coerce").fillna(0)
    return df.assign(
        loan_count=1,
        total_pos=pos,
        par0_pos=pos.where(dpd > 0, 0),
        par30_pos=pos.where(dpd > 30, 0),
        par60_pos=pos.where(dpd > 60, 0),
        par90_pos=pos.where(dpd > 90, 0),
    )


def _group_agg(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    return df.groupby(cols, as_index=False).agg(
        pos=("total_pos", "sum"),
        loans=("loan_count", "sum"),
        par0=("par0_pos", "sum"),
        par30=("par30_pos", "sum"),
        par60=("par60_pos", "sum"),
        par90=("par90_pos", "sum"),
    )


def _label(v) -> str:
    """Render a group key as its slicer-option string.

    iterrows() returns each row as a single Series, so an integer dimension
    (cycle_no) is upcast to float alongside the float measures and would render
    as '1.0' — which then matches no slicer option and filters to zero. Keeping
    integral floats as ints makes table labels round-trip through the filters.
    """
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _to_row(r, name_col: str, name2_col: Optional[str] = None) -> dict:
    pos = float(r["pos"])
    row = {
        "name":  _label(r[name_col]),
        "pos":   pos,
        "loans": int(r["loans"]),
        "par0_pct":  round(float(r["par0"])  / pos * 100, 2) if pos else 0,
        "par30_pct": round(float(r["par30"]) / pos * 100, 2) if pos else 0,
        "par60_pct": round(float(r["par60"]) / pos * 100, 2) if pos else 0,
        "par90_pct": round(float(r["par90"]) / pos * 100, 2) if pos else 0,
    }
    if name2_col:
        row["name2"] = _label(r[name2_col])
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
    lo: Optional[str] = Query(None),
    status_code: Optional[str] = Query(None),
    loan_id: Optional[str] = Query(None),   # lookup, not a grouping
    user: dict = Depends(get_current_user),
):
    df = _aum_source(user, loan_id)
    if df.empty:
        return []
    df = _segment_filter(df, segment, loan_source)
    df = _active_set(df, loan_status)
    df = _hier_filter(df, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, od_movement, bucket_movement, branch_state, district, disb_year, cycle, purpose, facility, lender, caste, religion, lo=lo, status_code=status_code, loan_id=loan_id)
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
    lo: Optional[str] = Query(None),
    status_code: Optional[str] = Query(None),
    loan_id: Optional[str] = Query(None),   # lookup, not a grouping
    user: dict = Depends(get_current_user),
):
    df = _aum_source(user, loan_id)
    if df.empty:
        return {}

    df = _segment_filter(df, segment, loan_source)
    df = _hier_filter(df, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, od_movement, bucket_movement, branch_state, district, disb_year, cycle, purpose, facility, lender, caste, religion, lo=lo, status_code=status_code, loan_id=loan_id)
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
    lo: Optional[str] = Query(None),
    status_code: Optional[str] = Query(None),
    loan_id: Optional[str] = Query(None),   # lookup, not a grouping
    user: dict = Depends(get_current_user),
):
    df = _aum_source(user, loan_id)
    if df.empty:
        return []

    df = _segment_filter(df, segment, loan_source)
    df = _hier_filter(df, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, od_movement, bucket_movement, branch_state, district, disb_year, cycle, purpose, facility, lender, caste, religion, lo=lo, status_code=status_code, loan_id=loan_id)
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
    lo: Optional[str] = Query(None),
    status_code: Optional[str] = Query(None),
    loan_id: Optional[str] = Query(None),   # lookup, not a grouping
    user: dict = Depends(get_current_user),
):
    """Aggregate AUM by one or two dimensions (AP#1 × AP#2).
    Returns GroupSummaryRow[]; when group_by_2 is set each row also has 'name2'.
    Grand Total row has name2=null / omitted."""
    g1 = group_by  if group_by  in VALID_DIMS else "business_segment"
    g2 = group_by_2 if group_by_2 and group_by_2 in VALID_DIMS and group_by_2 != "none" else None

    df = _aum_source(user, loan_id)
    if df.empty:
        return []

    df = _segment_filter(df, segment, loan_source)
    df = _hier_filter(df, zone, cluster, region, area, branch, prod_class, od_status, od_bucket, od_movement, bucket_movement, branch_state, district, disb_year, cycle, purpose, facility, lender, caste, religion, lo=lo, status_code=status_code, loan_id=loan_id)
    base = _active_set(df, loan_status)

    # Label dimensions fall back to their plain column until the report table has
    # been migrated (dba_add_aum_labels.sql), so the page never goes blank.
    g1 = _dim(base, g1)
    g2 = _dim(base, g2) if g2 else None
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
    lo: Optional[str] = Query(None),
    status_code: Optional[str] = Query(None),
    loan_id: Optional[str] = Query(None),   # lookup, not a grouping
    top_n: int = Query(15),
    user: dict = Depends(get_current_user),
):
    df = _aum_source(user, loan_id)
    if df.empty:
        return []

    active = _active_set(df, loan_status)
    active = _segment_filter(active, segment, loan_source)
    active = _hier_filter(active, zone=zone, cluster=cluster, region=region, area=area,
                          branch=branch, prod_class=prod_class, od_status=od_status,
                          od_bucket=od_bucket, od_movement=od_movement,
                          bucket_movement=bucket_movement, branch_state=branch_state,
                          district=district, disb_year=disb_year, cycle=cycle,
                          status_code=status_code,
                          purpose=purpose, facility=facility, lender=lender,
                          caste=caste, religion=religion, lo=lo)

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
    lo: Optional[str] = Query(None),
    status_code: Optional[str] = Query(None),
    loan_id: Optional[str] = Query(None),   # lookup, not a grouping
    top_n: int = Query(15),
    user: dict = Depends(get_current_user),
):
    df = _aum_source(user, loan_id)
    if df.empty:
        return []

    active = _active_set(df, loan_status)
    active = _segment_filter(active, segment, loan_source)
    active = _hier_filter(active, zone=zone, cluster=cluster, region=region, area=area,
                          branch=branch, prod_class=prod_class, od_status=od_status,
                          od_bucket=od_bucket, od_movement=od_movement,
                          bucket_movement=bucket_movement, branch_state=branch_state,
                          district=district, disb_year=disb_year, cycle=cycle,
                          status_code=status_code,
                          purpose=purpose, facility=facility, lender=lender,
                          caste=caste, religion=religion, lo=lo)

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
    df = _aum_source(user, loan_id)
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


# =============================================================================
# LOAN-WISE EXPORT (rpt_aum_loans)
#
# Built from aum_status.sql's own CTEs, so the file reconciles to the page.
# Verified 2026-08-13: every bucket matches rpt_aum_status on count AND POS
# (Active 92,717 · Write-off 30,295 · Closed 3,100 · Death 52).
#   Excl W/O = loan_status IN ('Active','Death')            -> 92,769
#   With W/O = + 'Write-off'                                -> 123,064
# =============================================================================

AUM_EXPORT_COLS = [
    "loan_id", "loan_source", "business_segment", "loan_status", "status_code",
    "dpd", "dpd_bucket", "curr_od_status", "bucket_movement",
    "pos", "total_arrear", "disbursement_date", "total_loan_amount",
    "zone_name", "cluster_name", "region_name", "area_name", "branch_name",
    "branch_id", "lo_id", "prod_classification", "state_id", "district_id",
    "disb_year", "cycle_no", "purpose_id", "facility_id", "lender_id",
    "caste", "religion",
]


@router.get("/aum/loans")
def aum_loans_export(
    portfolio: Optional[str] = Query(None),   # with | without (Excl W/O)
    segment: Optional[str] = Query(None), zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None), loan_status: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None), status_code: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    """Loan-wise rows for the Current Outstanding CSV export."""
    from core.filters import hier, segment_filter, multi
    df = read_report("rpt_aum_loans")
    if df.empty:
        return {"rows": [], "columns": AUM_EXPORT_COLS}
    # Movement-only rows (on-book at prev month-end, closed during the current
    # month) are not the live book. The page drops them via open_now in
    # _active_set, and the export MUST do the same or the two disagree.
    #
    # loan_status alone is not enough: a written-off loan that closed this month is
    # classified 'Write-off' (write-off wins over Closed), so it survives the
    # loan_status filter while the page has already excluded it. That put the
    # With W/O view 34 loans above the page.
    if "open_now" in df.columns:
        df = df[df["open_now"].fillna(True).astype(bool)]
    # Excl W/O is the active portfolio and reconciles to the page; 'Closed' rows
    # are movement-only and belong to neither view, exactly as aum_status does.
    keep = (["Active", "Death", "Write-off"] if (portfolio or "without") == "with"
            else ["Active", "Death"])
    if "loan_status" in df.columns:
        df = df[df["loan_status"].isin(keep)]
    df = segment_filter(df, segment or "ALL")
    df = hier(df, cluster, region, area, branch, zone=zone)
    df = multi(df, "prod_classification", prod_class)
    df = multi(df, "loan_status", loan_status)
    df = multi(df, "dpd_bucket", od_bucket)
    df = multi(df, "status_code", status_code)
    if df.empty:
        return {"rows": [], "columns": AUM_EXPORT_COLS}
    cols = [c for c in AUM_EXPORT_COLS if c in df.columns]
    out = df[cols].copy()
    if "disbursement_date" in out.columns:
        out["disbursement_date"] = out["disbursement_date"].astype(str)
    if "pos" in out.columns:
        out = out.sort_values("pos", ascending=False)
    return {"rows": out.fillna("").to_dict("records"), "columns": cols}
