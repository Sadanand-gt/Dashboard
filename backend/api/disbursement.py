from fastapi import APIRouter, Depends, Query
from typing import Optional
import pandas as pd
from core.db import read_report
from core.filters import hier, segment_filter, multi
from core.trend import build_trend, build_daily
from auth.deps import get_current_user

router = APIRouter()


def _apply_filters(
    df: pd.DataFrame,
    segment: Optional[str] = None, zone: Optional[str] = None,
    cluster: Optional[str] = None, region: Optional[str] = None,
    area: Optional[str] = None, branch: Optional[str] = None,
    branch_state: Optional[str] = None, district: Optional[str] = None,
    prod_class: Optional[str] = None, disb_year: Optional[str] = None,
    cycle: Optional[str] = None, purpose: Optional[str] = None,
    facility: Optional[str] = None, lender: Optional[str] = None,
    caste: Optional[str] = None, religion: Optional[str] = None,
) -> pd.DataFrame:
    # Business segment (real column now present in rpt_disbursement)
    df = segment_filter(df, segment or "ALL")
    # Geography hierarchy
    df = hier(df, cluster, region, area, branch, zone=zone)
    df = multi(df, "state_id",            branch_state)
    df = multi(df, "district_id",         district)
    # Product / loan attributes
    df = multi(df, "prod_classification", prod_class)
    df = multi(df, "disb_year",           disb_year)
    df = multi(df, "cycle_no",            cycle)
    df = multi(df, "purpose_id",          purpose)
    df = multi(df, "facility_id",         facility)
    df = multi(df, "lender_id",           lender)
    # Borrower
    df = multi(df, "caste",               caste)
    df = multi(df, "religion",            religion)
    return df


# Frontend AP dimension keys → rpt_disbursement column names.
DIM_COL: dict[str, str] = {
    "business_segment":   "business_segment",
    "loan_source":        "loan_source",
    "zone_name":          "zone_name",
    "cluster_name":       "cluster_name",
    "region_name":        "region_name",
    "area_name":          "area_name",
    "branch_name":        "branch_name",
    "state_id":           "state_id",
    "district_id":        "district_id",
    "lo_id":              "lo_id",
    "product_id":         "product_id",
    "prod_classification": "prod_classification",
    "disb_year":          "disb_year",
    "cycle_no":           "cycle_no",
    "purpose_id":         "purpose_id",
    "facility_id":        "facility_id",
    "lender_id":          "lender_id",
    "caste":              "caste",
    "religion":           "religion",
}


def _safe_col(df: pd.DataFrame, key: str) -> str:
    """Mapped column name; inject a constant 'N/A' column if absent (graceful)."""
    col = DIM_COL.get(key, key)
    if col not in df.columns:
        df[col] = "N/A"
    return col


def _group_pivot(df: pd.DataFrame, group_by: str, group_by_2: Optional[str]) -> list[dict]:
    """Pivot period_type × dimension rows into side-by-side T1 | MTD columns."""
    if df.empty:
        return []

    df = df.copy()
    col1 = _safe_col(df, group_by)
    col2 = _safe_col(df, group_by_2) if group_by_2 and group_by_2 != "none" else None
    group_cols = [col1] + ([col2] if col2 else [])

    t1  = df[df["period_type"] == "T1" ].groupby(group_cols)[["disb_count", "disb_amount"]].sum().reset_index()
    mtd = df[df["period_type"] == "MTD"].groupby(group_cols)[["disb_count", "disb_amount"]].sum().reset_index()
    ytd = df[df["period_type"] == "YTD"].groupby(group_cols)[["disb_count", "disb_amount"]].sum().reset_index()

    merged = (
        t1.merge(mtd, on=group_cols, how="outer", suffixes=("_t1", "_mtd"))
          .merge(ytd.rename(columns={"disb_count": "disb_count_ytd", "disb_amount": "disb_amount_ytd"}),
                 on=group_cols, how="outer")
          .fillna(0)
    )

    rows = []
    for _, r in merged.iterrows():
        t1c,  t1a  = int(r["disb_count_t1"]),  float(r["disb_amount_t1"])
        mtdc, mtda = int(r["disb_count_mtd"]), float(r["disb_amount_mtd"])
        ytdc, ytda = int(r["disb_count_ytd"]), float(r["disb_amount_ytd"])
        rows.append({
            "name":       str(r[col1]),
            "name2":      str(r[col2]) if col2 else None,
            "t1_count":   t1c,
            "t1_amount":  t1a,
            "t1_avg":     round(t1a / t1c, 2) if t1c else 0,
            "mtd_count":  mtdc,
            "mtd_amount": mtda,
            "mtd_avg":    round(mtda / mtdc, 2) if mtdc else 0,
            "ytd_count":  ytdc,
            "ytd_amount": ytda,
        })

    gt1c,  gt1a  = sum(r["t1_count"]  for r in rows), sum(r["t1_amount"]  for r in rows)
    gmtdc, gmtda = sum(r["mtd_count"] for r in rows), sum(r["mtd_amount"] for r in rows)
    gytdc, gytda = sum(r["ytd_count"] for r in rows), sum(r["ytd_amount"] for r in rows)
    rows.append({
        "name": "Grand Total", "name2": None,
        "t1_count":   gt1c, "t1_amount":  gt1a,  "t1_avg":  round(gt1a  / gt1c,  2) if gt1c  else 0,
        "mtd_count":  gmtdc, "mtd_amount": gmtda, "mtd_avg": round(gmtda / gmtdc, 2) if gmtdc else 0,
        "ytd_count":  gytdc, "ytd_amount": gytda,
    })
    return rows


def _period_agg(df: pd.DataFrame, ptype: str) -> tuple[int, float]:
    sub = df[df["period_type"] == ptype]
    return int(sub["disb_count"].sum()), float(sub["disb_amount"].sum())


# Shared filter query params for every endpoint.
def _filter_params(
    segment:      Optional[str] = Query(None),
    zone:         Optional[str] = Query(None),
    cluster:      Optional[str] = Query(None),
    region:       Optional[str] = Query(None),
    area:         Optional[str] = Query(None),
    branch:       Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None),
    district:     Optional[str] = Query(None),
    prod_class:   Optional[str] = Query(None),
    disb_year:    Optional[str] = Query(None),
    cycle:        Optional[str] = Query(None),
    purpose:      Optional[str] = Query(None),
    facility:     Optional[str] = Query(None),
    lender:       Optional[str] = Query(None),
    caste:        Optional[str] = Query(None),
    religion:     Optional[str] = Query(None),
) -> dict:
    return {
        "segment": segment, "zone": zone, "cluster": cluster, "region": region,
        "area": area, "branch": branch, "branch_state": branch_state,
        "district": district, "prod_class": prod_class, "disb_year": disb_year,
        "cycle": cycle, "purpose": purpose, "facility": facility,
        "lender": lender, "caste": caste, "religion": religion,
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/disbursement/kpis")
def disbursement_kpis(
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_disbursement")
    if df.empty:
        return {}
    df = _apply_filters(df, **filters)

    t1c,    t1a    = _period_agg(df, "T1")
    pmsd_c, pmsd_a = _period_agg(df, "PMSD")
    mtdc,   mtda   = _period_agg(df, "MTD")
    pm_c,   pm_a   = _period_agg(df, "PM")      # full previous month
    pmtd_c, pmtd_a = _period_agg(df, "PMTD")
    ytdc,   ytda   = _period_agg(df, "YTD")     # FY 1st April → T-1

    return {
        "t1_count":   t1c,    "t1_amount":   t1a,    "t1_avg":   round(t1a    / t1c,    2) if t1c    else 0,
        "pmsd_count": pmsd_c, "pmsd_amount": pmsd_a, "pmsd_avg": round(pmsd_a / pmsd_c, 2) if pmsd_c else 0,
        "mtd_count":  mtdc,   "mtd_amount":  mtda,   "mtd_avg":  round(mtda   / mtdc,   2) if mtdc   else 0,
        # full previous month — Exec Summary "Last Month" card reads count/amount
        "pm_count":   pm_c,   "pm_amount":   pm_a,   "pm_avg":   round(pm_a   / pm_c,   2) if pm_c   else 0,
        "count":      pm_c,   "amount":      pm_a,
        "pmtd_count": pmtd_c, "pmtd_amount": pmtd_a, "pmtd_avg": round(pmtd_a / pmtd_c, 2) if pmtd_c else 0,
        "ytd_count":  ytdc,   "ytd_amount":  ytda,   "ytd_avg":  round(ytda   / ytdc,   2) if ytdc   else 0,
    }


@router.get("/disbursement/group-summary")
def disbursement_group_summary(
    group_by:   str           = Query("business_segment"),
    group_by_2: Optional[str] = Query(None),
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_disbursement")
    if df.empty:
        return []
    df = _apply_filters(df, **filters)
    return _group_pivot(df, group_by, group_by_2)


@router.get("/disbursement/trend")
def disbursement_trend(
    freq: str = Query("month", pattern="^(day|month|quarter|year)$"),
    fy:   Optional[str] = Query(None),
    yoy:  bool = Query(False),
    user: dict = Depends(get_current_user),
):
    """Disbursement trend on the Indian fiscal calendar (Apr → Mar).
    day     → day-wise within the selected FY (rpt_disb_daily)
    month   → months of the selected FY, starting April
    quarter → FY quarters (selected FY, or last 4 by default)
    year    → FY-wise across all available years
    yoy=1   → selected FY vs previous FY (month / quarter alignment).
    Disbursement is a FLOW metric, so buckets sum their months.
    Portfolio-wide (trend tables carry no dimensions)."""
    if freq == "day":
        df = read_report("rpt_disb_daily")
        return build_daily(df, fy=fy, metrics={"amount": "disb_amount", "count": "disb_count"})
    df = read_report("rpt_trend_monthly")
    return build_trend(
        df, freq=freq, fy=fy, yoy=yoy,
        metrics={"amount": "disb_amount", "count": "disb_count"},
        stock=False,
    )


@router.get("/disbursement/refresh")
def disbursement_refresh(user: dict = Depends(get_current_user)):
    df = read_report("rpt_disbursement")
    if df.empty or "period_end" not in df.columns:
        return {"refresh": "—"}
    ts = pd.to_datetime(df["period_end"]).max()
    try:
        label = ts.strftime("%-d %b %Y") if pd.notna(ts) else "—"
    except ValueError:
        label = ts.strftime("%d %b %Y") if pd.notna(ts) else "—"
    return {"refresh": label}


@router.get("/disbursement")
def disbursement(
    period_type: str = Query("T1"),
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_disbursement")
    if df.empty:
        return []
    if period_type != "ALL":
        df = df[df["period_type"] == period_type]
    df = _apply_filters(df, **filters)
    return df.fillna("").to_dict("records")
