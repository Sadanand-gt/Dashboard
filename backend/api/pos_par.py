from fastapi import APIRouter, Depends, Query
from typing import Optional
from core.db import read_report
from core.filters import hier, segment_filter
from auth.deps import get_current_user

router = APIRouter()


@router.get("/pos-par")
def pos_par(
    report_type: str = Query("EOM"),
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    df = read_report("rpt_pos_par")
    if df.empty:
        return []
    df = df[df["report_type"] == report_type]
    df = segment_filter(df, segment, loan_source)
    df = hier(df, cluster, region, area, branch)
    return df.fillna("").to_dict("records")
