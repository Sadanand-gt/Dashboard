"""
origination.py — the front of the loan lifecycle, for the Executive Summary.

    /api/origination/funnel      stage counts, T-1 and MTD (rpt_case_movement)
    /api/origination/bre-daily   BRE decisions, T-1 and MTD (rpt_bre_daily)

WHY THIS MODULE EXISTS
    These endpoints previously lived in operations.py, whose router was RETIRED
    on 2026-08-07 and is NOT mounted in main.py. Anything served from there
    returns 404: the Executive Summary's origination funnel rendered every stage
    as 0 because /api/case-movement did not exist, not because the data was
    missing. rpt_case_movement itself was correct throughout.

STAGE DISCIPLINE
    The funnel stages each have their OWN denominator —
        application -> BRE/CB decision -> CGT -> GRT/PD -> sanction -> disbursal
    and must never be collapsed into a single "approval rate". This module only
    ever returns per-stage COUNTS; the one ratio it exposes (BRE approval) is
    explicitly the BRE stage's own.

SCOPE
    PD and BRE are JLG-ONLY — IL borrowers are absent from cb_engine, and
    pd_remarks holds no IL application. Callers must label them as such.
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional
from datetime import datetime

import pandas as pd

from core.db import read_report
from core.filters import hier, segment_filter
from auth.deps import get_current_user

router = APIRouter()

# Stage measures summed for the funnel. Kept explicit rather than "sum every
# numeric column": ratio columns (approval_ratio_*) and tat_days_mtd must NEVER
# be summed across branches, and a wildcard would do exactly that.
_T1 = {
    "applications": "new_clients_t1",
    "cb_screened":  "cb_checked_t1",
    "cgt":          "cgt1_t1",
    "grt":          "grt1_t1",
    "pd_done":      "pd_done_t1",
    "sanctioned":   "sanctioned_t1",
    "rejected":     "rejected_t1",
    "disbursed":    "disbursed_t1_count",
    "disbursed_amt": "disbursed_t1_amount",
}
_MTD = {
    "applications": "total_apps_mtd",
    "cb_screened":  "cb_checked_total",
    # CGT and GRT are SEPARATE ACTIVITIES — compulsory group training, then the
    # group recognition test that follows it. "cgt" used to be mapped to
    # grt1_mtd, which is not a typo with a small blast radius: paired with
    # cgt1_t1 on one tile it compared training YESTERDAY against recognition
    # tests MONTH-TO-DATE. Both now carry both periods and stay apart.
    "cgt":          "cgt1_mtd",
    "grt":          "grt1_mtd",
    "pd_done":      "pd_done_mtd",
    "sanctioned":   "sanctioned_mtd",
    "rejected":     "rejected_mtd",
    # Of "rejected", the share already past Personal Discussion when turned
    # down. Lets the tile say WHERE in the funnel the file died instead of
    # reporting one undifferentiated total. JLG only.
    "rejected_post_pd": "rejected_post_pd_mtd",
    "disbursed":    "disbursed_mtd_count",
    "disbursed_amt": "disbursed_mtd_amount",
}
_APPROVAL = {
    "approved_mtd":    "approved_total",
    "screened_mtd":    "cb_checked_total",
    "approved_nc":     "approved_nc_mtd",
    "screened_nc":     "cb_checked_nc_mtd",
    "approved_ec":     "approved_ec_mtd",
    "screened_ec":     "cb_checked_ec_mtd",
}


def _sum(df: pd.DataFrame, col: str) -> float:
    if col not in df.columns:
        return 0.0
    return float(pd.to_numeric(df[col], errors="coerce").fillna(0).sum())


@router.get("/origination/funnel")
def origination_funnel(
    segment: str = Query("ALL"),
    loan_source: str = Query("ALL"),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    """Origination stage counts for T-1 and month to date.

    Every figure is a COUNT belonging to one stage. The approval block is the
    .pbit measure — approved / CBs SCREENED, not approved / decided — so it is a
    throughput rate that climbs through the month, matching Power BI.

    There is deliberately no T-1 approval rate: an application filed yesterday
    has not been sanctioned yet (median TAT is 2 days for JLG), so the numerator
    is empty by construction and the ratio would read ~0%.
    """
    df = read_report("rpt_case_movement")
    if df.empty:
        return {"t1": {}, "mtd": {}, "approval": {}, "tat": {}}
    df = segment_filter(df, segment, loan_source)
    df = hier(df, cluster, region, area, branch)
    if df.empty:
        return {"t1": {}, "mtd": {}, "approval": {}, "tat": {}}

    t1 = {k: _sum(df, c) for k, c in _T1.items()}
    mtd = {k: _sum(df, c) for k, c in _MTD.items()}
    ap = {k: _sum(df, c) for k, c in _APPROVAL.items()}

    def rate(num_key, den_key):
        d = ap.get(den_key, 0)
        return round(ap.get(num_key, 0) / d * 100, 2) if d else 0.0

    # TAT is a MEDIAN per branch — take the median of those, never the sum.
    tat = {}
    if "tat_days_mtd" in df.columns:
        for src in ("JLG", "IL"):
            v = pd.to_numeric(
                df.loc[df.get("loan_source", "").astype(str) == src, "tat_days_mtd"],
                errors="coerce").dropna()
            tat[src.lower()] = round(float(v.median()), 1) if len(v) else None

    return {
        "t1": {k: int(v) for k, v in t1.items() if k != "disbursed_amt"}
              | {"disbursed_amt": t1["disbursed_amt"]},
        "mtd": {k: int(v) for k, v in mtd.items() if k != "disbursed_amt"}
               | {"disbursed_amt": mtd["disbursed_amt"]},
        "approval": {
            "approved": int(ap["approved_mtd"]), "screened": int(ap["screened_mtd"]),
            "rate": rate("approved_mtd", "screened_mtd"),
            "nc_rate": rate("approved_nc", "screened_nc"),
            "ec_rate": rate("approved_ec", "screened_ec"),
            "nc_approved": int(ap["approved_nc"]), "nc_screened": int(ap["screened_nc"]),
            "ec_approved": int(ap["approved_ec"]), "ec_screened": int(ap["screened_ec"]),
        },
        "tat": tat,
    }


@router.get("/origination/bre-daily")
def bre_daily(
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    """Bureau/BRE decisions for T-1 and month to date. JLG ONLY.

    ANCHORED ON current_date - 1, deliberately NOT max(pull_date). cb_engine is a
    LIVE database, unlike the T-1-bound core replica, so today's partial pulls are
    already present — on 2026-08-21 it held 476 for today against 986 for
    yesterday. Taking the latest date would quietly report half a day.
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
            # Share of decisions the ENGINE approved — the BRE stage's own rate,
            # not the application approval rate. Different denominator entirely.
            "approval_pct": round(appr / total * 100, 2) if total else 0.0,
        }

    return {
        "t1": split(df[df["pull_date"] == t1]),
        "mtd": split(df[(df["pull_date"] >= mtd_start) & (df["pull_date"] <= t1)]),
        "t1_date": t1.strftime("%d %b %Y"),
    }
