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
    portfolio=None, loan_id=None, eom_dpd_gt=None,
) -> pd.DataFrame:
    # Portfolio toggle: 'without' = exclude write-off loans (master + DB status).
    # A MISSING value now means 'without', matching aum.py and aml.py — those used
    # (portfolio or "without") while this endpoint treated None as 'with', so the
    # same missing parameter produced opposite portfolios across the three APIs.
    # Every caller in the app sends the value explicitly, so no displayed figure
    # changes; this only makes the fallback consistent for external callers.
    if (portfolio or "without") == "without" and "loan_status" in df.columns:
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
    df = multi(df, "loan_id",             loan_id)
    # PAR>60 cohort. eom_dpd is the loan's DPD at the PREVIOUS month-end, so
    # eom_dpd_gt=60 reproduces the trend engine's own par60_collection rule
    # exactly — `sum(coll) WHERE NOT is_wo AND prev_dpd > 60` in trend_full_*.sql.
    # Strictly greater than, not >=, for the same reason.
    if eom_dpd_gt is not None:
        if "eom_dpd" not in df.columns:
            # Do NOT skip quietly. rpt_collection is pre-aggregated and has no
            # eom_dpd, so an ignored filter returns the WHOLE BOOK looking like a
            # filtered cohort — which is what /collection/kpis did before the
            # PAR>60 endpoints were pointed at the loan table.
            raise ValueError(
                "eom_dpd_gt was passed but this frame has no eom_dpd column — it "
                "only exists at loan grain (rpt_collection_loans). Use the "
                "/collection/par60/* endpoints.")
        df = df[pd.to_numeric(df["eom_dpd"], errors="coerce").fillna(0) > float(eom_dpd_gt)]
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
    # Loan ID is a LOOKUP, not a grouping — one row per loan is unusable as
    # an AP dimension, so it filters instead. Comma-separated ids allowed.
    loan_id: Optional[str] = Query(None),
    # Keeps only loans that were more than this many days past due at the
    # PREVIOUS month-end. The PAR 60 Collection page sends 60; every other
    # caller omits it and sees the whole book.
    eom_dpd_gt: Optional[int] = Query(None),
    portfolio: Optional[str] = Query(None),
) -> dict:
    return dict(
        segment=segment, zone=zone, cluster=cluster, region=region, area=area,
        branch=branch, branch_state=branch_state, district=district,
        prod_class=prod_class, od_status=od_status, od_bucket=od_bucket,
        bucket_movement=bucket_movement, loan_status=loan_status, disb_year=disb_year,
        cycle=cycle, purpose=purpose, facility=facility, lender=lender,
        caste=caste, religion=religion, portfolio=portfolio, loan_id=loan_id,
        eom_dpd_gt=eom_dpd_gt,
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
            "t1_collected_count", "mtd_collection_count", "mtd_collected_count",
            "mtd_full_paid_count",
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
    # ON-TIME collection against T-1's own demand, capped per loan in the
    # pipeline. t1_collection is every rupee received on T-1 — including arrears
    # against older dues — so t1_collection / t1_demand read 110.15% on
    # 2026-08-13 while 233 loans first-time slipped that day. The formula is
    # unchanged (on-time collection / current demand); this is the numerator it
    # always expected. Falls back to t1_collection until the pipeline has run
    # once with the new column.
    t1ot = float(g["t1_ontime"].sum()) if "t1_ontime" in g.columns else t1c
    return {
        "loan_count":       int(g["loan_count"].sum()),
        "t1_demand_count":  _isum(g, "t1_demand_count"),
        # loans that had a T-1 demand AND collected against it — the count pair
        # that makes the OTRR ratio readable on the card
        "t1_collection_count": _isum(g, "t1_collection_count"),
        # TOTAL loans that paid, demand or not. This is what belongs beside the
        # collection AMOUNT: the amount counts every receipt, so pairing it with
        # the demand-matched count made the card contradict itself (Rs 24.8 L
        # labelled "25 loans" when 458 paid, 433 of them against arrears).
        "t1_collected_count": _isum(g, "t1_collected_count"),
        "mtd_demand_count": _isum(g, "mtd_demand_count"),
        "mtd_collection_count": _isum(g, "mtd_collection_count"),
        "mtd_collected_count": _isum(g, "mtd_collected_count"),
        # FULL vs PARTIAL settlement of the month's own demand. Partial is derived
        # from the same base, so the two always sum to mtd_collection_count.
        "mtd_full_paid_count": _isum(g, "mtd_full_paid_count"),
        "mtd_partial_paid_count": max(
            _isum(g, "mtd_collection_count") - _isum(g, "mtd_full_paid_count"), 0),
        "t1_demand":    t1d,
        "t1_collection": t1c,
        "t1_ontime":    t1ot,
        "t1_ce":        _div(t1c, t1d),     # .pbit uncapped collection efficiency
        "t1_otrr":      _pct(t1ot, t1d),    # OTRR = on-time collection / demand
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
    # Both comparison ratios use _div, exactly like the periods they are compared
    # AGAINST (t1_ce and mtd_ce). They used to use the capped _pct while their
    # counterparts were uncapped, so a "vs last month" read was never like-for-like.
    psd, psc = float(df["pmsd_demand"].sum()), float(df["pmsd_collection"].sum())
    m["pmsd_demand"] = psd
    m["pmsd_collection"] = psc
    m["pmsd_ce"] = _div(psc, psd)                       # mirrors t1_ce (raw / raw)
    # PMTD = previous month TO DATE → MTD comparison. pmtd_collection is now built
    # in SQL with the same .pbit [Collection] cap + opening advance as mtd_collection,
    # so this ratio mirrors mtd_ce exactly.
    ptd = float(df["pmtd_demand"].sum()) if "pmtd_demand" in df.columns else 0.0
    ptc = float(df["pmtd_collection"].sum()) if "pmtd_collection" in df.columns else 0.0
    m["pmtd_demand"] = ptd
    m["pmtd_collection"] = ptc
    m["pmtd_ce"] = _div(ptc, ptd)                       # mirrors mtd_ce
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


# =============================================================================
# LOAN-WISE EXPORT (rpt_collection_loans)
#
# Same filter chain as the pages, over a table built from collection_fact.sql's
# own CTEs, so the file reconciles to the screen. Verified 2026-08-13: all six
# measures tie exactly (ftod 3,826 · t1_ontime 10,094,982 · mtd_ontime
# 244,839,611).
# =============================================================================

COLL_EXPORT_COLS = [
    "loan_id", "loan_source", "business_segment", "loan_status",
    "eom_dpd", "live_dpd", "dpd_bucket", "bucket_movement", "ftod_flag",
    "t1_demand", "t1_collection", "t1_ontime",
    "mtd_demand", "mtd_collection", "mtd_ontime",
    "zone_name", "cluster_name", "region_name", "area_name", "branch_name",
    "branch_id", "lo_id", "prod_classification", "state_id", "district_id",
]


@router.get("/collection/loans")
def collection_loans(filters: dict = Depends(_filter_params),
                     user: dict = Depends(get_current_user)):
    """Loan-wise rows for the T-1 and MTD Collection CSV exports."""
    df = read_report("rpt_collection_loans")
    if df.empty:
        return {"rows": [], "columns": COLL_EXPORT_COLS}
    df = _apply_filters(df, **filters)   # takes kwargs, not a dict
    if df.empty:
        return {"rows": [], "columns": COLL_EXPORT_COLS}
    cols = [c for c in COLL_EXPORT_COLS if c in df.columns]
    out = df[cols].copy()
    sort = [c for c in ("mtd_demand", "t1_demand") if c in out.columns]
    if sort:
        out = out.sort_values(sort, ascending=False)
    return {"rows": out.fillna("").to_dict("records"), "columns": cols}


# =============================================================================
# PAR 60 COLLECTION (loan grain) — NOT the figure the PAR 60 page shows.
#
# SUPERSEDED 2026-08-26. The page now reads the TREND engine
# (/api/trend/series?measure=par60_collection), because that is the measure that
# reconciles: against "August, 2026 Dashboards" -> "Trend - PAR60 Collection" it
# matches EXACTLY in 9 of 12 months, worst month 1.24%. These endpoints, built
# on eom_dpd, read Rs 0.029 Cr for August against the trend's Rs 0.067 Cr —
# roughly half — because collection_fact derives DPD from instalment-level
# cumulative due while the trend walks a day-level ledger.
#
# Kept because they are the only LOAN-GRAIN view of the cohort (which loans,
# who paid nothing, the CSV). Use them to get a list to act on; do NOT quote
# their totals as the PAR>60 collection figure.
#
# READS THE LOAN TABLE, NOT rpt_collection. The cohort is defined by eom_dpd
# (DPD at the PREVIOUS month-end), which is a per-loan fact and therefore does
# not exist on the pre-aggregated table — passing eom_dpd_gt to /collection/kpis
# is a SILENT NO-OP that returns the whole book. Same defect aml.py fixed by
# moving to rpt_aml_loans, and the same reason.
#
# The cohort rule `eom_dpd > 60` is the trend engine's own:
# `sum(coll) WHERE NOT is_wo AND prev_dpd > 60` in trend_full_*.sql. Strictly
# greater than, and fixed at the PREVIOUS month-end so the denominator cannot
# move underneath the numerator while the month runs.
#
# No PMTD/PMSD comparison is offered: those columns live only on the aggregate
# table, so a prior-period figure for this cohort would have to be invented.
# =============================================================================

PAR60_EOM_DPD_GT = 60


def _par60_frame(filters: dict) -> pd.DataFrame:
    df = read_report("rpt_collection_loans")
    if df.empty:
        return df
    f = dict(filters)
    f["eom_dpd_gt"] = PAR60_EOM_DPD_GT
    df = _apply_filters(df, **f)
    if df.empty:
        return df
    for c in ("t1_demand", "t1_collection", "t1_ontime",
              "mtd_demand", "mtd_collection", "mtd_ontime", "pos"):
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    return df


def _par60_metrics(g: pd.DataFrame) -> dict:
    t1d, t1c = float(g["t1_demand"].sum()), float(g["t1_collection"].sum())
    md, mc = float(g["mtd_demand"].sum()), float(g["mtd_collection"].sum())
    mot = float(g["mtd_ontime"].sum())
    t1ot = float(g["t1_ontime"].sum()) if "t1_ontime" in g.columns else t1c
    # Counts are derived from the loan rows themselves — at this grain a "loan
    # that paid" is a row with collection > 0, so there is nothing to look up.
    return {
        "loan_count": int(len(g)),
        "pos": float(g["pos"].sum()) if "pos" in g.columns else 0.0,
        "t1_demand": t1d, "t1_collection": t1c, "t1_ontime": t1ot,
        "t1_ce": _div(t1c, t1d), "t1_otrr": _pct(t1ot, t1d),
        "mtd_demand": md, "mtd_collection": mc, "mtd_ontime": mot,
        "mtd_ce": _div(mc, md), "mtd_otrr": _pct(mot, md),
        "mtd_demand_count": int((g["mtd_demand"] > 0).sum()),
        "mtd_collected_count": int((g["mtd_collection"] > 0).sum()),
        "t1_collected_count": int((g["t1_collection"] > 0).sum()),
        # Loans still carrying arrears with NOTHING paid this month — the
        # actionable list on a deep-arrears page.
        "no_pay_count": int((g["mtd_collection"] <= 0).sum()),
    }


@router.get("/collection/par60/kpis")
def par60_kpis(filters: dict = Depends(_filter_params),
               user: dict = Depends(get_current_user)):
    df = _par60_frame(filters)
    if df.empty:
        return {}
    return _par60_metrics(df)


@router.get("/collection/par60/group-summary")
def par60_group_summary(
    group_by: str = Query("business_segment"),
    group_by_2: Optional[str] = Query(None),
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    df = _par60_frame(filters)
    if df.empty:
        return []
    g1 = _safe_col(df, group_by)
    g2 = _safe_col(df, group_by_2) if (group_by_2 and group_by_2 != "none") else None
    keys = [g1] + ([g2] if g2 and g2 != g1 else [])
    rows = []
    for k, grp in df.groupby(keys, dropna=False):
        vals = k if isinstance(k, tuple) else (k,)
        rec = {"name": str(vals[0]), **_par60_metrics(grp)}
        if len(keys) > 1:
            rec["name2"] = str(vals[1])
        rows.append(rec)
    rows.sort(key=lambda r: -r["mtd_demand"])
    grand = {"name": "Grand Total", **_par60_metrics(df)}
    if len(keys) > 1:
        grand["name2"] = ""
    return rows + [grand]
