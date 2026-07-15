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
