"""
vintage.py — Vintage Curve.

    /api/vintage/curves    one series per cohort, indexed by Month On Book
    /api/vintage/cohorts   the cohorts available, for the picker

WHAT A VINTAGE CURVE ANSWERS
    "Of the money we lent in month M, how much had gone X+ days overdue by the
    n-th month of the loan's life?" Cohorts are compared at the SAME age, so a
    2024 vintage and a 2026 vintage can be judged against each other even though
    one has had two more years to go wrong.

DEFINITION (reverse-engineered from All-time Dashboards.xlsb -> Trend - Vintage)
    The workbook's measure is

        Vintage>X % = DIVIDE(
            CALCULATE(SUM('12M AUM Loandump'[Cumulative > X]),
                      FILTER(ALL(<MOB>), <MOB> <= CurrMOB)),
            [Monthly Disbursement])

    — a RUNNING TOTAL over Month On Book of a per-loan "Cumulative > X" column,
    over the amount disbursed in the cohort. The running total is why every curve
    rises then flattens: once a loan is counted it is never uncounted. Verified
    on the sheet — the 2023 PAR>0 series freezes at Rs 268,019,643 from MOB 27
    through 44.

    The numerator column sits beside a `Sum of OUTSTANDING_PRINCIPAL` measure and
    a pair of `Cumulative Bucket` / `Cumulative Bucket Sr` calculated columns
    (the worst DPD bucket the loan had reached by that point), so it is the
    OUTSTANDING PRINCIPAL of loans at their first breach — `basis='pos'` here,
    and the default.

    `basis='disb'` offers the other common construction, the amount originally
    LENT to loans that ever breached. It is the more standard published vintage
    and is what a lender pack usually shows; it reads higher because it does not
    let a loan amortise before it goes bad.

    `basis='count'` weights every loan as 1 — the share of LOANS that had
    breached, not of rupees. The workbook has no counterpart for it (its four
    numerator blocks are all in rupees), so it is ours and is not part of the
    reconciliation below. It answers the question the money bases cannot: whether
    a cohort's damage is many small loans or a few large ones. Read together,
    count above money means the bad loans are small; money above count means a
    handful of large ones are carrying the loss.

RECONCILED AGAINST THE WORKBOOK (2026-08-25, full re-check)
    The workbook's sheet holds four numerator blocks in rupees (Vintage>0/30/60/
    90, at sheet columns 312/416/520/624) over one shared `Sum of Disb During
    Month` denominator, by Disb Year / Quarter / Month. Dividing them gives a
    like-for-like check at every threshold rather than at a handful of points.

    Comparable window: 2023Q2 .. 2026Q2. Excluded, for reasons that are not
    disagreements — 2023Q1, where the workbook's source CSVs had not started
    (its disbursement reads 0); and 2026Q3, where the workbook is a month behind
    us (its Max MOB puts its data date at July 2026).

    DENOMINATOR: 13 quarters, worst 0.13%, mean 0.07%.

    NUMERATOR, every comparable cohort x MOB point (273 per threshold), pos basis:

        PAR>0    mean +0.267pp   median +0.210pp   worst -1.239pp
        PAR>30   mean +0.283pp   median +0.189pp   worst +1.026pp
        PAR>60   mean +0.274pp   median +0.162pp   worst +1.044pp
        PAR>90   mean +0.581pp   median +0.233pp   worst +2.392pp

    We read slightly HIGH, and the bias grows with the threshold. It is NOT a
    grace period: varying the grace from 0 to 15 days moves the curve by 0.09pp,
    nowhere near enough to account for it. The likeliest remaining cause is that
    the workbook reads a DPD field off each monthly Loandump snapshot while this
    derives DPD from cash vs due, so a payment landing just after a month-end
    counts here and not there. Unresolved, and small.

    The basis is settled by the same run: on 2023Q2 the `disb` basis reads far
    above the workbook at every MOB, so the workbook is denominated on
    outstanding, as the DAX indicated.

THREE BUGS FOUND AND FIXED IN THAT RE-CHECK (all in gen_vintage.py)
    1. disb_amount was taken from the CLOSURE-TRUNCATED schedule, so an early
       settlement looked like a smaller loan. It understated the denominator by
       up to 9.24%, worst on mid-age cohorts. This was the whole of the
       previously-reported Rs 174.1 Cr vs Rs 191.2 Cr gap, which had been written
       off as a derivation difference. It was not.
    2. The breach results were merged on loan_id ALONE. 34 ids exist in both
       home_loan_account and loan_account_il and are different loans, so each
       became four rows, crossing one loan's schedule with the other's breach.
       The key is (loan_id, loan_source).
    3. prod_classification was hardcoded to 'Other'. Because _load filters with
       .isin(), choosing any other Product Classification matched zero rows and
       blanked the page — a silent wipe-out, not a missing dimension.

    An earlier build ran 1.4-2.2x high and looked like a definitional gap. It was
    not — it was a NULL principal_collected poisoning a pandas cumsum (see
    gen_vintage.py), which made cash read as zero and manufactured breaches.
    Fixing it dropped ever-breaching loans from 52,881 to 39,849.

KNOWN, NOT CHANGED
    IL cash counts status ('A','V'). repayment_detail_il also carries 10,343
    rows of status 'F' worth Rs 7.50 Cr across 2,082 loans, which look like real
    foreclosure receipts: counting them takes those loans from 385 to 1,035
    exactly-fully-paid. Excluding them makes a settled loan look permanently
    overdue. But every cash query in the codebase uses ('A','V'), so this is a
    system-wide question, not a vintage one — changing it here alone would break
    the single-DPD-method rule. Raised for a decision.
"""

from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, Query

from core.db import read_report, report_days
from core.filters import hier, segment_filter
from auth.deps import get_current_user

router = APIRouter()

MAX_MOB = 60          # five years; beyond that no cohort has observations


def _load(f: dict) -> pd.DataFrame:
    df = read_report("rpt_vintage")
    if df.empty:
        return df
    df = segment_filter(df, f.get("segment") or "ALL", f.get("loan_source") or "ALL")
    df = hier(df, f.get("cluster"), f.get("region"), f.get("area"), f.get("branch"))
    # Straight equality slicers — every one is a column on the table.
    for key, col in (("zone", "zone_name"), ("branch_state", "state_id"),
                     ("district", "district_id"), ("prod_class", "prod_classification"),
                     ("loan_status", "loan_status"), ("cycle", "cycle_no"),
                     ("purpose", "purpose_id"), ("facility", "facility_id"),
                     ("lender", "lender_id"), ("caste", "caste"),
                     ("religion", "religion"), ("lo", "lo_id")):
        v = f.get(key)
        if v and col in df.columns:
            want = [s.strip() for s in str(v).split(",") if s.strip()]
            df = df[df[col].astype(str).isin(want)]
    return df


def _filters(
    segment: Optional[str] = Query(None), loan_source: Optional[str] = Query(None),
    zone: Optional[str] = Query(None), cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None), area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None), branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None), prod_class: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None), cycle: Optional[str] = Query(None),
    purpose: Optional[str] = Query(None), facility: Optional[str] = Query(None),
    lender: Optional[str] = Query(None), caste: Optional[str] = Query(None),
    religion: Optional[str] = Query(None), lo: Optional[str] = Query(None),
) -> dict:
    return dict(segment=segment, loan_source=loan_source, zone=zone, cluster=cluster,
                region=region, area=area, branch=branch, branch_state=branch_state,
                district=district, prod_class=prod_class, loan_status=loan_status,
                cycle=cycle, purpose=purpose, facility=facility, lender=lender,
                caste=caste, religion=religion, lo=lo)


def _cohort_key(df: pd.DataFrame, grain: str) -> pd.Series:
    """Display label for the cohort. NEVER sort on this — see _cohort_sort."""
    m = pd.to_datetime(df["cohort_month"])
    if grain == "year":
        return m.dt.year.astype(str)
    if grain == "quarter":
        # CALENDAR quarters (Q1 = Jan-Mar), because that is what the reference
        # workbook cohorts on and what this report reconciles to. Note the house
        # FY runs Apr-Mar, so "Q1" here is NOT the fiscal first quarter — the
        # page spells the months out on hover so nobody has to assume.
        return "Q" + m.dt.quarter.astype(str) + m.dt.strftime("'%y")
    return m.dt.strftime("%b'%y")


def _cohort_sort(df: pd.DataFrame, grain: str) -> pd.Series:
    """Chronological sort key, because the LABELS do not sort chronologically.

    Alphabetically "2023 JAS" precedes "2023 JFM" and "Apr 2022" precedes
    "Aug 2022" — so ordering by label puts the oldest quarter of each year in the
    middle and scrambles a chart whose colour ramp is meant to read as time
    passing. Same trap as the DPD buckets sorting '181 - 360' before '61 - 90'.
    """
    m = pd.to_datetime(df["cohort_month"])
    if grain == "year":
        return m.dt.year.astype(str)
    if grain == "quarter":
        return m.dt.year.astype(str) + "Q" + m.dt.quarter.astype(str)
    return m.dt.strftime("%Y-%m")


@router.get("/vintage/curves")
def vintage_curves(
    threshold: int = Query(30, description="0 / 30 / 60 / 90"),
    grain: str = Query("quarter", description="month | quarter | year"),
    basis: str = Query("pos", description="pos = outstanding at breach (the "
                                          "workbook's basis); disb = amount lent; "
                                          "count = share of loans breached"),
    f: dict = Depends(_filters),
    user: dict = Depends(get_current_user),
):
    """One series per cohort: cumulative % of the cohort breached, by MOB."""
    x = threshold if threshold in (0, 30, 60, 90) else 30
    basis = basis if basis in ("pos", "disb", "count") else "pos"
    df = _load(f)
    empty = {"series": [], "threshold": x, "grain": grain, "basis": basis, "as_of": None}
    if df.empty:
        return empty

    df = df.copy()
    df["cohort"] = _cohort_key(df, grain)
    df["_sort"] = _cohort_sort(df, grain)
    mob_col = f"mob_par{x}"
    df[mob_col] = pd.to_numeric(df[mob_col], errors="coerce")
    df["disb_amount"] = pd.to_numeric(df["disb_amount"], errors="coerce").fillna(0)
    df["max_mob"] = pd.to_numeric(df["max_mob"], errors="coerce").fillna(0)
    # `count` weights every loan as 1, so the same running-total machinery gives
    # the share of LOANS breached instead of a share of rupees. A cohort of many
    # small bad loans and one of few large ones look identical on the money
    # bases; this is the cut that tells them apart.
    if basis == "count":
        df["_num"] = 1.0
    else:
        df["_num"] = pd.to_numeric(
            df[f"pos_par{x}" if basis == "pos" else "disb_amount"],
            errors="coerce").fillna(0)

    out = []
    for (skey, cohort), g in df.groupby(["_sort", "cohort"], sort=True):
        # Rupee bases divide by what the cohort was lent; the count basis divides
        # by how many loans it holds.
        denom = float(len(g)) if basis == "count" else float(g["disb_amount"].sum())
        if denom <= 0:
            continue
        # A cohort is only observed out to the age its YOUNGEST loan has reached.
        # Plotting further would draw an incomplete curve as though it had
        # flattened, which is the classic way a vintage chart lies.
        horizon = int(min(g["max_mob"].min(), MAX_MOB))
        br = g.dropna(subset=[mob_col])
        # Running total: value of everything that had breached by each MOB.
        per = br.groupby(br[mob_col].astype(int))["_num"].sum()
        run = per.reindex(range(0, horizon + 1), fill_value=0.0).cumsum()
        out.append({
            "cohort": str(cohort),
            "sort": str(skey),
            "loans": int(len(g)),
            # Always the rupee figure — the matrix shows it in its own column and
            # must not start reporting a loan count when the basis switches.
            "disbursed": float(g["disb_amount"].sum()),
            "max_mob": horizon,
            "breached_loans": int(len(br)),
            "values": [round(v / denom * 100, 3) for v in run.tolist()],
        })

    out.sort(key=lambda s: s["sort"])
    # read_report strips report_day, so the data date comes from the store.
    days = report_days("rpt_vintage")
    as_of = days[-1] if days else None
    return {"series": out, "threshold": x, "grain": grain, "basis": basis,
            "as_of": as_of, "max_mob": max((s["max_mob"] for s in out), default=0)}


@router.get("/vintage/cohorts")
def vintage_cohorts(f: dict = Depends(_filters), user: dict = Depends(get_current_user)):
    """Cohorts present, newest first, with how far each has been observed."""
    df = _load(f)
    if df.empty:
        return {"months": [], "quarters": [], "years": []}
    df = df.copy()
    res = {}
    for grain, key in (("month", "months"), ("quarter", "quarters"), ("year", "years")):
        g = (df.assign(cohort=_cohort_key(df, grain), _sort=_cohort_sort(df, grain))
               .groupby(["_sort", "cohort"])
               .agg(loans=("loan_id", "size"),
                    disbursed=("disb_amount", "sum"),
                    max_mob=("max_mob", "min"))
               .reset_index().sort_values("_sort", ascending=False))
        res[key] = [{"value": str(r.cohort), "loans": int(r.loans),
                     "disbursed": float(r.disbursed), "max_mob": int(r.max_mob)}
                    for r in g.itertuples()]
    return res
