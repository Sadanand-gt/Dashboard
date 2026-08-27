"""
gen_vintage.py — build rpt_vintage, the loan-grain source for the Vintage Curve.

WHAT IT COMPUTES
    Per loan: the disbursement cohort, the amount lent, and the Month On Book at
    which the loan FIRST crossed 0 / 30 / 60 / 90 DPD. The page aggregates those
    into curves at read time.

THE CHEAP EXACT TEST
    Detecting "first breach" naively means walking every month-end of every loan
    — ~457,000 loans x ~30 months. It is not needed. Cash only ever increases and
    an instalment's cumulative demand is fixed, so:

        instalment i is X-days overdue at month-end M
            iff  demand_date(i) + X <= M  AND  cash(M) < cumulative_due(i)

    Take M_i = the first month-end on or after demand_date(i) + X. If cash has
    already covered cumulative_due(i) by M_i then it is covered at every later
    month-end too, so instalment i can NEVER breach. Each instalment therefore
    has exactly ONE candidate month-end, and

        first breach = min{ M_i : cash(M_i) < cumulative_due(i) }

    That turns a month-grid walk into one as-of lookup per instalment.

    Detection is at MONTH-END granularity on purpose: the workbook is built from
    monthly Loandump snapshots, so a loan that went overdue and was cured inside
    a single month never appears there either.

BASIS
    Cash counts status 'A'/'V' only (the rest are reversals) and is compared
    against cumulative_principal_due + cumulative_interest_due — the same
    cash-vs-due basis as aum_status.sql, od_slippage.sql and the trend engine.
    Rs 0.50 tolerance absorbs instalment-split rounding.

    disb_amount is the DISBURSED principal, taken as the loan's total scheduled
    principal (max cumulative_principal_due) over the FULL schedule, never
    total_loan_amount — that is the SANCTIONED figure and overstates
    part-disbursed loans. See [[pos-basis-sanction-vs-disbursed]].

    "Full schedule" is load-bearing: the closure-date cut below is a window for
    BREACH DETECTION only. Applying it to disb_amount as well made an early
    settlement look like a smaller loan and understated the denominator by up to
    9.24% — see the comment in build_side().
"""

from __future__ import annotations

import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from db import run_query                                        # noqa: E402
from report_store import pg_write_report_day                    # noqa: E402
from load_writeoff_master import get_writeoff_triples           # noqa: E402

TABLE = "rpt_vintage"
# Cohorts start at FY22-23. Earlier years pre-date the current products, and the
# reference workbook itself only sees April 2023 onward, so anything before this
# has no counterpart to check against.
COHORT_FROM = date(2022, 4, 1)
CHUNK = 40_000                       # loans per pass
THRESHOLDS = (0, 30, 60, 90)


def month_end(s: pd.Series) -> pd.Series:
    """First month-end on or after each date."""
    return (s + pd.offsets.MonthEnd(0)).dt.normalize()


def first_breach(sched: pd.DataFrame, cash: pd.DataFrame, days: int) -> pd.Series:
    """MOB-bearing date of the first X+ DPD breach per loan, or NaT.

    sched: loan_id, demand_date, cum_due     cash: loan_id, d, cum_cash

    CALLERS MUST DROP POST-CLOSURE INSTALMENTS FIRST. A loan settled early keeps
    its remaining instalments in repayment_schedule, so cumulative demand goes on
    rising after the borrower has finished paying and every later month-end looks
    like a breach. Measured on the Apr-Dec 2023 JLG cohort, leaving them in put
    the PAR>0 curve at 39.20% by MOB 24 against 30.81% with them removed.
    """
    s = sched.copy()
    s["M"] = month_end(s["demand_date"] + pd.Timedelta(days=days))
    # Cash as at each candidate month-end. merge_asof needs both sides sorted by
    # the join key; 'backward' takes the last cash row at or before M.
    s = s.sort_values("M")
    c = cash.sort_values("d")
    j = pd.merge_asof(s, c, left_on="M", right_on="d", by="loan_id",
                      direction="backward")
    j["cum_cash"] = j["cum_cash"].fillna(0.0)
    breached = j[j["cum_due"] > j["cum_cash"] + 0.5]
    return breached.groupby("loan_id")["M"].min()


def build_side(side: str, ids: list[int]) -> pd.DataFrame:
    """One segment's loans, in chunks."""
    sched_tbl = "repayment_schedule" if side == "JLG" else "repayment_schedule_il"
    coll_tbl = "repayment_detail" if side == "JLG" else "repayment_detail_il"
    coll_date = "collection_date" if side == "JLG" else "collection_date_time"

    out = []
    for i in range(0, len(ids), CHUNK):
        part = ids[i:i + CHUNK]
        lst = ",".join(str(x) for x in part)
        # The closure cut is a BREACH-DETECTION window, not a filter on the loan.
        # Instalments demanded after the loan closed must not drive a breach — an
        # early settlement leaves the rest of the schedule in place, and every
        # later month-end would look overdue (see first_breach) — but they are
        # still part of what was lent. Fetch the whole schedule and flag the
        # window, so disb_amount can be taken from the FULL row set.
        #
        # Truncating BOTH understated the denominator by up to 9.24%, worst on
        # mid-age cohorts where most loans have closed but the book is still
        # large. That was the entire reported Rs 174.1 Cr vs Rs 191.2 Cr gap
        # against the workbook: on the full schedule every quarter from 2023Q2
        # to 2026Q2 lands within 0.13% of it.
        loan_tbl = "home_loan_account" if side == "JLG" else "loan_account_il"
        sched = run_query(f"""
            SELECT rs.loan_id, rs.demand_date::date AS demand_date,
                   (rs.cumulative_principal_due + rs.cumulative_interest_due) AS cum_due,
                   rs.cumulative_principal_due AS cum_prin,
                   (la.closure_date IS NULL
                    OR rs.demand_date::date <= la.closure_date::date) AS in_window
            FROM public.{sched_tbl} rs
            JOIN public.{loan_tbl} la ON la.loan_id = rs.loan_id
            WHERE rs.loan_id IN ({lst})""")
        if sched.empty:
            continue
        cash = run_query(f"""
            -- coalesce BEFORE summing. A single row with a NULL
            -- principal_collected makes the pandas cumsum below return NaN from
            -- that point on, and NaN cash then reads as "nothing paid": it both
            -- inflated POS-at-breach to the full disbursed amount (2,529 loans)
            -- and manufactured breaches at a threshold whose earlier threshold
            -- had not fired (22 loans) — structurally impossible otherwise.
            SELECT loan_id, {coll_date}::date AS d,
                   sum(coalesce(principal_collected, 0)
                       + coalesce(interest_collected, 0)) AS paid,
                   sum(coalesce(principal_collected, 0))  AS prin
            FROM public.{coll_tbl}
            WHERE loan_id IN ({lst}) AND status IN ('A','V')
            GROUP BY 1, 2""")

        sched["loan_id"] = sched.loan_id.astype("int64")
        sched["demand_date"] = pd.to_datetime(sched.demand_date)
        sched["cum_due"] = pd.to_numeric(sched.cum_due, errors="coerce").fillna(0)
        if cash.empty:
            cash = pd.DataFrame({"loan_id": pd.Series(dtype="int64"),
                                 "d": pd.Series(dtype="datetime64[ns]"),
                                 "cum_cash": pd.Series(dtype="float64"),
                                 "cum_prin": pd.Series(dtype="float64")})
        else:
            cash["loan_id"] = cash.loan_id.astype("int64")
            cash["d"] = pd.to_datetime(cash.d)
            cash = cash.sort_values(["loan_id", "d"])
            # Belt and braces: cumsum propagates any NaN forward forever.
            cash["paid"] = pd.to_numeric(cash["paid"], errors="coerce").fillna(0)
            cash["prin"] = pd.to_numeric(cash["prin"], errors="coerce").fillna(0)
            cash["cum_cash"] = cash.groupby("loan_id")["paid"].cumsum()
            cash["cum_prin"] = cash.groupby("loan_id")["prin"].cumsum()
            cash = cash[["loan_id", "d", "cum_cash", "cum_prin"]]

        # Disbursed principal per loan = total principal ever scheduled, over the
        # WHOLE schedule. Closing early does not reduce what was lent.
        disb = sched.groupby("loan_id")["cum_prin"].max().rename("disb_amount")
        # Breach detection sees only the pre-closure window.
        sched_win = sched[sched["in_window"].fillna(True).astype(bool)]
        res = pd.DataFrame(index=disb.index).join(disb)
        # Principal repaid by any date, for the POS-at-breach basis.
        for x in THRESHOLDS:
            d = first_breach(sched_win, cash, x)
            res[f"_dt{x}"] = d
            if not d.empty and not cash.empty:
                at = pd.DataFrame({"loan_id": d.index, "M": d.values}).sort_values("M")
                cp = cash.sort_values("d")
                got = pd.merge_asof(at, cp, left_on="M", right_on="d",
                                    by="loan_id", direction="backward")
                paid = got.set_index("loan_id")["cum_prin"].fillna(0)
                res[f"_pos{x}"] = (disb - paid.reindex(disb.index).fillna(0)).clip(lower=0)
            else:
                res[f"_pos{x}"] = pd.NA
        out.append(res.reset_index())
        print(f"    {side} {min(i+CHUNK, len(ids)):>7,}/{len(ids):,}", flush=True)
    if not out:
        return pd.DataFrame()
    res = pd.concat(out, ignore_index=True)
    # loan_id is unique per SOURCE TABLE, not globally: 34 ids live in both
    # home_loan_account and loan_account_il, and they are different loans —
    # different customer, date and amount, each with its own ledger. Carrying the
    # side lets main() merge on (loan_id, loan_source); merging on loan_id alone
    # crossed a JLG loan's schedule with an IL loan's breach and turned those 34
    # into 136 rows.
    res["loan_source"] = side
    return res


def main() -> None:
    t0 = time.time()
    as_of = date.today() - pd.Timedelta(days=1).to_pytimedelta()
    print(f"vintage build  data date {as_of}")

    # ── Loan master: cohort + every slicer dimension ────────────────────────
    print("reading loan master ...", flush=True)
    jlg = run_query("""
        SELECT la.loan_id, 'JLG' AS loan_source, 'JLG' AS business_segment,
               la.disbursement_date::date AS disb_date, la.status AS raw_status,
               la.closure_date::date AS closure_date,
               cm.branch_id, cm.assigned_to::varchar AS lo_id,
               coalesce(la.cycle::text,'N/A') AS cycle_no,
               nullif(trim(la.purpose_id::text),'')  AS purpose_id,
               nullif(trim(la.facility_id::text),'') AS facility_id,
               -- JLG carries no lender_id; aum_loans.sql hardcodes 'N/A' for
               -- the same reason, so the slicer reads the same on both pages.
               'N/A'::text                           AS lender_id,
               nullif(trim(b.caste::text),'')        AS caste,
               nullif(trim(b.religion::text),'')     AS religion,
               la.product_id::text AS product_id,
               coalesce(pc.product_classification, 'Other') AS prod_classification
        FROM public.home_loan_account la
        JOIN public.home_center_master cm ON cm.center_id = la.center_id
        LEFT JOIN public.home_brrwr_misc b ON b.cust_id = la.cust_id
        LEFT JOIN public.loan_product     lp ON lp.product_id  = la.product_id
        LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
        WHERE la.loan_id >= 10000000 AND la.status <> 'R'
          AND la.disbursement_date IS NOT NULL
          AND la.disbursement_date::date >= DATE '{}'""".format(COHORT_FROM))
    il = run_query("""
        SELECT la.loan_id, 'IL' AS loan_source,
               CASE WHEN upper(trim(la.product_id::text)) LIKE '%SUGAM%'
                      OR upper(trim(la.product_id::text)) LIKE '%UDYOGINI%'
                      OR upper(trim(la.product_id::text)) LIKE '%SECURED%'
                    THEN 'LAP' ELSE 'IEL' END AS business_segment,
               la.disbursement_date::date AS disb_date, la.status AS raw_status,
               la.closure_date::date AS closure_date,
               la.branch_id, la.loan_officer::varchar AS lo_id,
               coalesce(la.cycle::text,'N/A') AS cycle_no,
               nullif(trim(la.purpose_id::text),'')  AS purpose_id,
               nullif(trim(la.facility_id::text),'') AS facility_id,
               nullif(trim(la.lender_id::text),'')   AS lender_id,
               nullif(trim(b.caste::text),'')        AS caste,
               nullif(trim(b.religion::text),'')     AS religion,
               la.product_id::text AS product_id,
               coalesce(pc.product_classification, 'Other') AS prod_classification
        FROM public.loan_account_il la
        LEFT JOIN public.brrwroth_il b ON b.cust_id = la.cust_id
        LEFT JOIN public.loan_product_il  lp ON lp.product_id  = la.product_id
        LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
        WHERE la.loan_id >= 10000000 AND la.status <> 'R'
          AND la.disbursement_date IS NOT NULL
          AND la.disbursement_date::date >= DATE '{}'""".format(COHORT_FROM))
    hier = run_query("""
        SELECT bm.branch_id, bm.branch_name, a.area_name,
               reg.branch_name AS region_name, clus.area_name AS cluster_name,
               z.area_name AS zone_name, bm.state_id, bm.district_id
        FROM public.brnch_master bm
        LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
        LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
        LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
        LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id""")

    loans = pd.concat([jlg, il], ignore_index=True)
    loans["loan_id"] = loans.loan_id.astype("int64")
    loans["disb_date"] = pd.to_datetime(loans.disb_date)
    print(f"  loans: {len(loans):,}")

    # ── First-breach MOBs ──────────────────────────────────────────────────
    print("computing first-breach months ...", flush=True)
    parts = []
    for side in ("JLG", "IL"):
        ids = loans.loc[loans.loan_source == side, "loan_id"].tolist()
        if ids:
            parts.append(build_side(side, ids))
    br = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()

    # (loan_id, loan_source) — never loan_id alone. See build_side().
    df = loans.merge(br, on=["loan_id", "loan_source"], how="left")
    df = df.merge(hier, on="branch_id", how="left")
    dup = int(df.duplicated(subset=["loan_id", "loan_source"]).sum())
    if dup:
        print(f"  !! {dup} duplicate (loan_id, loan_source) rows — a join fanned "
              f"out; the cohort would double-count them")

    # ── Cohort + MOBs ──────────────────────────────────────────────────────
    df["cohort_month"] = df.disb_date.values.astype("datetime64[M]")
    asof = pd.Timestamp(as_of)
    mob = lambda s: ((s.dt.year - df.cohort_month.dt.year) * 12          # noqa: E731
                     + (s.dt.month - df.cohort_month.dt.month))
    df["max_mob"] = ((asof.year - df.cohort_month.dt.year) * 12
                     + (asof.month - df.cohort_month.dt.month)).clip(lower=0)
    for x in THRESHOLDS:
        d = pd.to_datetime(df[f"_dt{x}"])
        m = mob(d)
        # A breach cannot pre-date the cohort, and is capped at what has been
        # observed — a curve must never extend past its own max_mob.
        ok = d.notna() & (m >= 0) & (m <= df.max_mob)
        df[f"mob_par{x}"] = m.where(ok)
        df[f"pos_par{x}"] = pd.to_numeric(df.get(f"_pos{x}"), errors="coerce").where(ok)

    # Write-off master overrides status, exactly as everywhere else.
    wo = {int(t[0]) for t in get_writeoff_triples()}
    df["loan_status"] = np.select(
        [df.loan_id.isin(wo) | df.raw_status.eq("W"),
         df.raw_status.isin(["D", "I"]),
         df.closure_date.notna()],
        ["Write-off", "Death", "Closed"], default="Active")

    df["disb_year"] = df.cohort_month.dt.year.astype(str)
    # prod_classification now comes from product_category via loan_product, the
    # same path the collection/trend queries use. It was hardcoded to 'Other',
    # which did not merely lose a dimension: _load filters with .isin(), so
    # picking any other Product Classification in the slicer matched zero rows
    # and blanked the whole page.
    df["disb_amount"] = pd.to_numeric(df.disb_amount, errors="coerce").fillna(0)

    cols = ["loan_id", "loan_source", "business_segment", "cohort_month",
            "disb_amount", "max_mob", "mob_par0", "mob_par30", "mob_par60",
            "mob_par90", "pos_par0", "pos_par30", "pos_par60", "pos_par90",
            "zone_name", "cluster_name", "region_name", "area_name",
            "branch_name", "branch_id", "lo_id", "state_id", "district_id",
            "prod_classification", "loan_status", "disb_year", "cycle_no",
            "purpose_id", "facility_id", "lender_id", "caste", "religion"]
    # report_day is stamped by pg_write_report_day; adding it here too makes the
    # writer's insert collide.
    for c in cols:
        if c not in df.columns:
            df[c] = None
    out = df[cols].copy()
    out["cohort_month"] = out.cohort_month.dt.date
    for c in ("max_mob", "mob_par0", "mob_par30", "mob_par60", "mob_par90"):
        out[c] = out[c].astype("Int64")

    rows, days = pg_write_report_day(out, TABLE, as_of.isoformat())
    print(f"\n  {TABLE}: {rows:,} rows @ {as_of}  ({days} day(s) stored)"
          f"  in {(time.time()-t0)/60:.1f} min")

    # ── Shape check ────────────────────────────────────────────────────────
    breached = {x: int(out[f"mob_par{x}"].notna().sum()) for x in THRESHOLDS}
    print(f"  loans ever breaching: {breached}")
    if breached[0] < breached[30]:
        print("  !! PAR>0 breaches fewer loans than PAR>30 — thresholds are "
              "nested, so this is impossible. Check the cash join.")


if __name__ == "__main__":
    main()
