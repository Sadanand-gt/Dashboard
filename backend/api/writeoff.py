from fastapi import APIRouter, Depends, Query
from typing import Optional
from core.db import read_report
from core.filters import hier, segment_filter
from auth.deps import get_current_user

router = APIRouter()


@router.get("/writeoff")
def writeoff(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_writeoff")
    if df.empty:
        return []
    df = segment_filter(df, segment, loan_source)
    df = hier(df, cluster, region, area, branch)
    return df.fillna("").to_dict("records")


@router.get("/writeoff/kpis")
def writeoff_kpis(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_writeoff")
    if df.empty:
        return {}
    df = segment_filter(df, segment, loan_source)
    df = hier(df, cluster, region, area, branch)
    wo_amt = float(df["writeoff_amount"].sum())
    rec_amt = float(df["recovery_amount"].sum())
    return {
        "total_amount": wo_amt,
        "total_count": int(df["writeoff_count"].sum()),
        "recovery_amount": rec_amt,
        "net_loss": round(wo_amt - rec_amt, 2),
        "recovery_pct": round(rec_amt / wo_amt * 100, 2) if wo_amt else 0,
    }
