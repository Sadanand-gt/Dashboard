"""
origination_funnel.py — the stage-wise origination funnel.

    /api/origination-funnel/stages     the ladder: reached / rejected / still here
    /api/origination-funnel/category   outcome by bureau client category
    /api/origination-funnel/meetings   CGT / GRT / House Visit queue
    /api/origination-funnel/cohorts    punch months available, with carry-over
    /api/origination-funnel/applications   application rows, for the CSV

WHY THIS IS NOT PART OF CASE MOVEMENT
    Case Movement reads rpt_case_movement, which is branch-grain and MONTH TO
    DATE. Two questions cannot be asked of it:

      · WHERE IS EVERYTHING NOW. An MTD sanctioned/rejected pair is silent about
        applications still moving. On 2026-08-26, 1,624 were live — 844 at stage
        'B', 448 at CGT. That queue is the bottleneck and it was invisible.
      · WHOSE MONTH IS IT. "Punched this month" and "decided this month" are
        different populations. Of everything decided in August, 1,202 of 13,628
        (8.8%) came from JULY applications. An MTD rate divides one by the other.

    This reads rpt_origination_funnel at APPLICATION grain, so a cohort can be
    followed to completion and the carry-over is measured rather than caveated.

THE SANCTION RATE HERE DIVIDES BY *DECIDED*, NOT BY APPLICATIONS
    A cohort still in flight has applications that have not been ruled on. Over
    applications, a young cohort reads low purely for being young. Over decided,
    it is comparable from day one. `pending_rate` carries the maturity separately
    so nothing is hidden.

STAGE NAMES
    C1 = CGT, G1 = GRT, HV = House Visit are VERIFIED — home_meeting_sch uses the
    same vocabulary for meeting_purpose. 'S' rows all carry a sanctioned_date.
    'B', 'D', 'R' and 'P1' are NOT named: their observed behaviour is exposed
    (volume, median days to decision) so the business can name them, but a stage
    label is read as a statement about someone's process and is not guessed here.
"""

from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, Query

from core.db import read_report, report_days
from core.filters import hier, segment_filter, multi
from auth.deps import get_current_user, require_export

router = APIRouter()

FUNNEL = "rpt_origination_funnel"
MEETINGS = "rpt_origination_meetings"

# Verified only. Anything absent is rendered by its raw code on purpose.
STAGE_LABEL = {"C1": "CGT", "G1": "GRT", "HV": "House Visit", "S": "Sanction",
               "EN": "Enrolled", "BK": "Booked", "TV": "TVR", "CC": "Credit Check",
               "SN": "Sanction", "DS": "Sanctioned", "A": "Approved", "X": "Rejected"}

SUMS = ["applications", "is_approved", "is_rejected", "is_inprocess", "decided",
        "decision_days", "hv_done", "credit_submitted", "sanctioned", "approved",
        "disbursed", "applied_amount", "sanctioned_amount", "disbursed_amount"]

DIMS = {
    "business_segment": ("Business Segment", "loan_source"),
    "zone_name": ("Zone", "zone_name"),
    "cluster_name": ("Cluster", "cluster_name"),
    "region_name": ("Region", "region_name"),
    "area_name": ("Unit", "area_name"),
    "branch_name": ("Branch", "branch_name"),
    "lo_id": ("Loan Officer", "lo_id"),
    "client_category": ("Client Category", "client_category"),
    "cohort_month": ("Punch Month", "cohort_month"),
    "reject_reason": ("Rejection Reason", "reject_reason"),
    "credit_decision": ("Credit Decision", "credit_decision"),
    "prod_classification": ("Prod. Classification", "prod_classification"),
}


def _filters(
    segment: Optional[str] = Query(None), loan_source: Optional[str] = Query(None),
    zone: Optional[str] = Query(None), cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None), area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None), prod_class: Optional[str] = Query(None),
    lo: Optional[str] = Query(None),
    cohort: Optional[str] = Query(None),        # 'YYYY-MM' punch month, or ALL
    category: Optional[str] = Query(None),      # client category
    include_topup: Optional[str] = Query(None), # '1' keeps top-ups
) -> dict:
    return dict(segment=segment, loan_source=loan_source, zone=zone, cluster=cluster,
                region=region, area=area, branch=branch, prod_class=prod_class,
                lo=lo, cohort=cohort, category=category, include_topup=include_topup)


def _load(f: dict) -> pd.DataFrame:
    df = read_report(FUNNEL)
    if df.empty:
        return df
    for c in SUMS:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    # Top-ups are excluded by DEFAULT. They are a different product decision —
    # an existing borrower being offered more on a loan already performing — and
    # leaving them in flatters every conversion rate on the page.
    if str(f.get("include_topup") or "") != "1" and "is_topup" in df.columns:
        df = df[pd.to_numeric(df["is_topup"], errors="coerce").fillna(0) == 0]
    df = segment_filter(df, f.get("segment") or "ALL", f.get("loan_source") or "ALL")
    df = hier(df, cluster=f.get("cluster"), region=f.get("region"),
              area=f.get("area"), branch=f.get("branch"), zone=f.get("zone"))
    df = multi(df, "prod_classification", f.get("prod_class"))
    df = multi(df, "lo_id", f.get("lo"))
    df = multi(df, "client_category", f.get("category"))
    cohort = (f.get("cohort") or "ALL").strip()
    if cohort and cohort != "ALL" and "cohort_month" in df.columns:
        df = df[df["cohort_month"].astype(str).str.slice(0, 7) == cohort]
    return df


def _as_of() -> Optional[str]:
    days = report_days(FUNNEL)
    return days[-1] if days else None


def _rates(d: dict) -> dict:
    """Every rate recomputed from SUMMED numerator and denominator."""
    dec = float(d.get("decided", 0) or 0)
    apps = float(d.get("applications", 0) or 0)
    appr = float(d.get("is_approved", 0) or 0)
    d["sanction_rate"] = round(appr / dec * 100, 2) if dec else 0.0
    d["rejection_rate"] = round(float(d.get("is_rejected", 0) or 0) / dec * 100, 2) if dec else 0.0
    d["pending_rate"] = round(float(d.get("is_inprocess", 0) or 0) / apps * 100, 2) if apps else 0.0
    d["hv_rate"] = round(float(d.get("hv_done", 0) or 0) / apps * 100, 2) if apps else 0.0
    d["disbursal_rate"] = round(float(d.get("disbursed", 0) or 0) / appr * 100, 2) if appr else 0.0
    d["avg_days"] = round(float(d.get("decision_days", 0) or 0) / dec, 1) if dec else 0.0
    dis = float(d.get("disbursed", 0) or 0)
    d["avg_ticket"] = round(float(d.get("disbursed_amount", 0) or 0) / dis, 0) if dis else 0.0
    return d


@router.get("/origination-funnel/stages")
def stages(f: dict = Depends(_filters), user: dict = Depends(get_current_user)):
    """The ladder. For every stage: how many rejections it produced, how many
    live applications are sitting in it, and how long a rejection there took.

    Rejections are attributed by `reject_stage` (the source's rejection_status),
    live cases by `current_stage`. The two are different columns on purpose — an
    application has one or the other, never both.
    """
    df = _load(f)
    empty = {"rows": [], "totals": {}, "as_of": _as_of()}
    if df.empty:
        return empty

    rej = df[df["outcome"].astype(str) == "Rejected"]
    live = df[df["outcome"].astype(str) == "In Process"]

    stages = sorted({str(s) for s in rej.get("reject_stage", pd.Series(dtype=str)).dropna()
                     if str(s) not in ("", "nan", "None")}
                    | {str(s) for s in live.get("current_stage", pd.Series(dtype=str)).dropna()
                       if str(s) not in ("", "nan", "None")})
    rows = []
    for s in stages:
        r = rej[rej["reject_stage"].astype(str) == s]
        l = live[live["current_stage"].astype(str) == s]
        days = pd.to_numeric(r.get("days_to_decision"), errors="coerce").dropna()
        rows.append({
            "stage": s,
            "label": STAGE_LABEL.get(s, f"Stage {s}"),
            "named": s in STAGE_LABEL,
            "rejected_here": int(len(r)),
            "live_here": int(len(l)),
            "median_days": float(days.median()) if len(days) else None,
            # The dominant reason is what turns "57% die at B" into something
            # actionable — a bureau reject and a stale-application sweep call for
            # completely different responses.
            "top_reason": (str(r["reject_reason"].mode().iloc[0])
                           if "reject_reason" in r.columns and not r["reject_reason"].dropna().empty
                           else None),
        })
    rows.sort(key=lambda x: -(x["rejected_here"] + x["live_here"]))

    tot = _rates({c: float(df[c].sum()) for c in SUMS if c in df.columns})
    tot["rejected_unattributed"] = int(len(rej) - sum(r["rejected_here"] for r in rows))
    return {"rows": rows, "totals": tot, "as_of": _as_of()}


@router.get("/origination-funnel/category")
def by_category(f: dict = Depends(_filters), user: dict = Depends(get_current_user)):
    """Outcome by bureau client category.

    New to Credit / New to Company / Existing Borrower come from cb_engine's
    CLIENT CATEGORY, assigned BEFORE the decision. This is not the cust_type
    NC/EC flag, which is circular — that one is derived from holding a loan
    today, so being sanctioned is what makes an applicant "existing".
    """
    df = _load(f)
    if df.empty:
        return {"rows": [], "as_of": _as_of()}
    out = []
    for cat, g in df.groupby(df["client_category"].astype(str)):
        rec = {c: float(g[c].sum()) for c in SUMS if c in g.columns}
        rec["category"] = cat
        out.append(_rates(rec))
    out.sort(key=lambda x: -x["applications"])
    return {"rows": out, "as_of": _as_of()}


@router.get("/origination-funnel/meetings")
def meetings(f: dict = Depends(_filters), user: dict = Depends(get_current_user)):
    """CGT / GRT / House Visit: completed, pending, cancelled.

    Centre-grain in the source, so it is its own table rather than a join onto
    the application rows. This is where the operational queue actually shows: on
    the 90 days to 2026-08-26 CGT ran at 0.9% pending while GRT sat at 25.5% and
    House Visit at 29.3%.
    """
    df = read_report(MEETINGS)
    if df.empty:
        return {"rows": [], "as_of": _as_of()}
    for c in ("completed", "pending", "cancelled"):
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
    df = hier(df, cluster=f.get("cluster"), region=f.get("region"),
              area=f.get("area"), branch=f.get("branch"), zone=f.get("zone"))
    cohort = (f.get("cohort") or "ALL").strip()
    if cohort and cohort != "ALL" and "meeting_month" in df.columns:
        df = df[df["meeting_month"].astype(str).str.slice(0, 7) == cohort]
    if df.empty:
        return {"rows": [], "as_of": _as_of()}
    out = []
    for p, g in df.groupby(df["purpose"].astype(str)):
        c, pd_, x = float(g.completed.sum()), float(g.pending.sum()), float(g.cancelled.sum())
        t = c + pd_ + x
        out.append({"purpose": p, "completed": int(c), "pending": int(pd_),
                    "cancelled": int(x),
                    "pending_pct": round(pd_ / t * 100, 2) if t else 0.0,
                    "cancelled_pct": round(x / t * 100, 2) if t else 0.0})
    order = {"CGT": 0, "GRT": 1, "House Visit": 2}
    out.sort(key=lambda r: order.get(r["purpose"], 9))
    return {"rows": out, "as_of": _as_of()}


@router.get("/origination-funnel/cohorts")
def cohorts(f: dict = Depends(_filters), user: dict = Depends(get_current_user)):
    """Punch months available, each with how far it has resolved.

    `carried_in` is the measurement the MTD report could not make: applications
    punched in this cohort that were still undecided when the month ended, and so
    landed in a LATER month's decision counts.
    """
    g = dict(f)
    g["cohort"] = "ALL"
    df = _load(g)
    if df.empty:
        return {"rows": [], "as_of": _as_of()}
    df["_m"] = df["cohort_month"].astype(str).str.slice(0, 7)
    rows = []
    for m, grp in df.groupby("_m"):
        rec = {c: float(grp[c].sum()) for c in SUMS if c in grp.columns}
        rec["cohort"] = m
        rows.append(_rates(rec))
    rows.sort(key=lambda r: r["cohort"], reverse=True)
    return {"rows": rows, "as_of": _as_of()}


EXPORT_COLS = [
    "application_number", "loan_source", "cohort_month", "application_date",
    "outcome", "current_stage", "reject_stage", "reject_reason", "reject_type",
    "days_to_decision", "client_category", "bureau_decision", "credit_decision",
    "hv_done", "sanctioned", "approved", "disbursed",
    "applied_amount", "sanctioned_amount", "disbursed_amount",
    "cluster_name", "region_name", "area_name", "branch_name", "branch_id",
    "lo_id", "product_id", "prod_classification",
]


@router.get("/origination-funnel/applications")
def applications(f: dict = Depends(_filters), user: dict = Depends(require_export)):
    """Application rows for the CSV, under the same filters as everything above,
    so the file always reconciles to what is on screen."""
    df = _load(f)
    if df.empty:
        return {"rows": [], "columns": EXPORT_COLS}
    cols = [c for c in EXPORT_COLS if c in df.columns]
    out = df[cols].copy()
    for c in ("cohort_month", "application_date"):
        if c in out.columns:
            out[c] = out[c].astype(str).replace({"NaT": "", "None": "", "nan": ""})
    out = out.sort_values([c for c in ("application_date", "application_number")
                           if c in out.columns], ascending=False)
    return {"rows": out.fillna("").to_dict("records"), "columns": cols}
