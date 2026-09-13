"""
operations.py — Operational reports brought over from the attached pipeline:
Bucket Movement, Delinquencies, Case Movement, AUM Live, Cashless Collection,
Trend Monthly. Each reads its rpt_* table and applies the global slicers
(Business Segment → loan_source, geography hierarchy). Frontend computes KPIs.
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional
from core.db import read_report
from core.filters import hier, segment_filter
from auth.deps import get_current_user
from datetime import datetime
import pandas as pd

router = APIRouter()


def _scope(df: pd.DataFrame, user: dict) -> pd.DataFrame:
    # Row-level scope is applied centrally in read_report (core/db.py via
    # core/scope.py) — kept as identity for backward compatibility.
    return df


def _rows(table: str, segment, loan_source, cluster, region, area, branch, user):
    """Read a report table, scope to the user, apply segment + geography slicers."""
    df = read_report(table)
    if df.empty:
        return []
    df = _scope(df, user)
    df = segment_filter(df, segment, loan_source)
    df = hier(df, cluster, region, area, branch)
    return df.fillna("").to_dict("records")


def _slicer_params(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
):
    """Common slicer query params as a dependency bundle."""
    return {
        "segment": segment, "loan_source": loan_source,
        "cluster": cluster, "region": region, "area": area, "branch": branch,
    }


@router.get("/bucket-movement")
def bucket_movement(sl: dict = Depends(_slicer_params), user: dict = Depends(get_current_user)):
    return _rows("rpt_bucket_movement", **sl, user=user)


@router.get("/delinquencies")
def delinquencies(sl: dict = Depends(_slicer_params), user: dict = Depends(get_current_user)):
    return _rows("rpt_delinquencies", **sl, user=user)


@router.get("/case-movement")
def case_movement(sl: dict = Depends(_slicer_params), user: dict = Depends(get_current_user)):
    return _rows("rpt_case_movement", **sl, user=user)


@router.get("/aum-live")
def aum_live(sl: dict = Depends(_slicer_params), user: dict = Depends(get_current_user)):
    return _rows("rpt_aum_live", **sl, user=user)


@router.get("/cashless")
def cashless(sl: dict = Depends(_slicer_params), user: dict = Depends(get_current_user)):
    return _rows("rpt_cashless_collection", **sl, user=user)


@router.get("/trend-monthly")
def trend_monthly(sl: dict = Depends(_slicer_params), user: dict = Depends(get_current_user)):
    """Monthly trend — supports segment + geography slicers."""
    df = read_report("rpt_trend_monthly")
    if df.empty:
        return []
    df = _scope(df, user)
    df = segment_filter(df, sl["segment"], sl["loan_source"])
    df = hier(df, sl["cluster"], sl["region"], sl["area"], sl["branch"])
    if "m_offset" in df.columns:
        df = df.sort_values("m_offset")
    return df.fillna("").to_dict("records")


@router.get("/bre/daily-kpis")
def bre_daily_kpis(
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    """Bureau/BRE decisions for T-1 and month to date. JLG ONLY.

    IL borrowers are absent from cb_engine (7 join keys tested during the JLG
    Leverage Cuts work, 1 of 3,608 matched), so every figure here is the JLG book
    and must be labelled as such — it is not a firm-wide bureau number.

    ANCHORED ON current_date - 1, deliberately NOT max(pull_date). cb_engine is a
    LIVE database, unlike the T-1-bound core replica, so today's partial pulls are
    already present: on 2026-08-21 the table held 476 pulls for today against 986
    for yesterday. Taking the latest date would quietly report a half day.

    Decision is the engine's own FINAL RECOMMENDATION — Approved / Rejected /
    Referred. This is the BRE stage ALONE; it is not the CGT, PD or sanction
    outcome, and must not be combined with those counts.
    """
    df = read_report("rpt_bre_daily")
    empty = {"t1": {}, "mtd": {}, "t1_date": None}
    if df.empty:
        return empty
    df = hier(df, cluster, region, area, branch)
    if df.empty:
        return empty

    df["pull_date"] = pd.to_datetime(df["pull_date"], errors="coerce")
    df["pulls"] = pd.to_numeric(df["pulls"], errors="coerce").fillna(0)
    today = pd.Timestamp(datetime.now().date())
    t1 = today - pd.Timedelta(days=1)
    mtd_start = today.replace(day=1)

    def split(frame):
        g = frame.groupby("decision")["pulls"].sum()
        total = float(g.sum())
        appr = float(g.get("Approved", 0))
        return {
            "pulls": int(total),
            "approved": int(appr),
            "rejected": int(g.get("Rejected", 0)),
            "referred": int(g.get("Referred", 0)),
            # Share of decisions the engine APPROVED. This is the BRE stage rate,
            # not the application approval rate — different denominator entirely.
            "approval_pct": round(appr / total * 100, 2) if total else 0.0,
        }

    return {
        "t1": split(df[df["pull_date"] == t1]),
        "mtd": split(df[(df["pull_date"] >= mtd_start) & (df["pull_date"] <= t1)]),
        "t1_date": t1.strftime("%d %b %Y"),
    }
