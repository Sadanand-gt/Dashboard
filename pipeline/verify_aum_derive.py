"""verify_aum_derive.py — prove rpt_aum_status can be DERIVED from the loan grain.

    python -m pipeline.verify_aum_derive

WHY
    rpt_aum_status and rpt_aum_loans are two separate queries against a live read
    replica, run minutes apart. Their LOGIC cannot disagree (the loan-grain file's
    CTE block is generated from the parent), but their TIMING can: on 2026-08-18
    they were 9 loans apart on the same report_day, so the Current Outstanding page
    and its CSV export disagreed.

    Deriving the aggregate from the loan grain means ONE query and ONE snapshot, so
    drift becomes impossible rather than unlikely.

WHAT THIS DOES — READ ONLY, WRITES NOTHING
    1. runs aum_loans.sql once
    2. aggregates it with aum_status.sql's exact GROUP BY and measures
    3. runs aum_status.sql once
    4. diffs the two, cell for cell

    Any difference is reported. Because the two queries run a few minutes apart,
    a SMALL residual is expected from replica drift — that is the very thing being
    removed. What must hold is that the KEYS match and the measures agree on every
    shared key; a structural mismatch (missing column, wrong grouping, different
    rounding) shows up as a large or systematic diff, not a handful of loans.
"""
from __future__ import annotations

import os
import sys

import pandas as pd

from pipeline.db import run_sql_file
from pipeline.load_writeoff_master import (get_writeoff_ids, writeoff_values_literal,
                                           writeoff_triples_literal)

# The columns rpt_aum_status EMITS — which is all the API ever reads.
#
# NOT aum_status.sql's internal GROUP BY: that groups on raw_status, and the emitted
# loan_status folds BOTH 'D' and 'I' into 'Death'. So rpt_aum_status can hold two
# rows whose visible dimensions are identical, differing only by a hidden raw_status.
# Reconstructing raw_status from loan_status is lossy in that direction, so compare
# on what is emitted and let the D/I pair sum together — exactly what every consumer
# of the table already does.
GROUP_KEYS = [
    "loan_source", "business_segment", "curr_od_status",
    "loan_status", "open_now", "onbook_prev_eom",
    "dpd_bucket", "prev_dpd_bucket", "curr_dpd_bucket",
    "od_movement_status", "bucket_movement",
    "zone_name", "cluster_name", "region_name", "area_name", "branch_name",
    "zone_label", "cluster_label", "region_label", "area_label", "branch_label",
    "branch_id", "lo_id", "prod_classification",
    "state_id", "district_id",
    "cycle_no", "disb_year",
    "purpose_id", "facility_id", "lender_id", "caste", "religion",
]

# loan-grain column -> emitted name, where the projection aliased it
RENAME_LOANS = {
    "agg_prev_dpd_bucket": "prev_dpd_bucket",
    "agg_curr_dpd_bucket": "curr_dpd_bucket",
    "agg_od_movement_status": "od_movement_status",
    "agg_onbook_prev_eom": "onbook_prev_eom",
}

# measure -> (loan-grain source column, aggregation)
MEASURES = {
    "loan_count":       ("loan_id", "size"),
    "total_pos":        ("pos", "sum"),
    "prev_pos":         ("agg_prev_pos", "sum"),
    "total_sanctioned": ("total_loan_amount", "sum"),
    "total_arrear":     ("total_arrear", "sum"),
    "par0_pos":         ("agg_par0_pos", "sum"),
    "par30_pos":        ("agg_par30_pos", "sum"),
    "par60_pos":        ("agg_par60_pos", "sum"),
    "par90_pos":        ("agg_par90_pos", "sum"),
    "writeoff_pos":     ("agg_writeoff_pos", "sum"),
}


def _subs():
    ids = get_writeoff_ids()
    return {"wo_ids": ",".join(str(i) for i in ids),
            "wo_pairs": writeoff_values_literal(),
            "wo_triples": writeoff_triples_literal()}


def derive(loans: pd.DataFrame) -> pd.DataFrame:
    """Aggregate the loan grain into aum_status's shape."""
    df = loans.rename(columns=RENAME_LOANS).copy()
    for k in GROUP_KEYS:
        if k not in df.columns:
            raise SystemExit(f"loan grain is missing GROUP BY key: {k}")
        df[k] = df[k].astype(str)      # NULL-safe grouping, matching SQL GROUP BY
    agg = df.groupby(GROUP_KEYS, dropna=False).agg(
        **{name: pd.NamedAgg(column=src, aggfunc=how)
           for name, (src, how) in MEASURES.items()}
    ).reset_index()
    for name in MEASURES:
        if name != "loan_count":
            agg[name] = agg[name].astype(float).round(2)
    return agg


def shape_status(status: pd.DataFrame) -> pd.DataFrame:
    """Collapse rpt_aum_status onto the emitted keys, summing the D/I duplicate pair."""
    df = status.copy()
    for k in GROUP_KEYS:
        if k in df.columns:
            df[k] = df[k].astype(str)
    have = [k for k in GROUP_KEYS if k in df.columns]
    return df.groupby(have, dropna=False).agg(
        **{name: pd.NamedAgg(column=name, aggfunc="sum") for name in MEASURES}
    ).reset_index()


def main() -> int:
    # The loan-grain query is expensive and this replica drops long connections, so
    # cache it: re-running the comparison must not mean re-running the extract.
    cache = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_verify_loans.parquet")
    if "--fresh" not in sys.argv and os.path.exists(cache):
        loans = pd.read_parquet(cache)
        print(f"loan grain from cache: {len(loans):,} loans, {len(loans.columns)} columns")
    else:
        print("running aum_loans.sql (loan grain) ...", flush=True)
        loans = run_sql_file("aum_loans.sql", subs=_subs())
        loans.to_parquet(cache)
        print(f"  {len(loans):,} loans, {len(loans.columns)} columns  (cached)")

    if "--stored" in sys.argv:
        # compare against the rpt_aum_status already in the report DB. Written from
        # a DIFFERENT snapshot, so a small drift is EXPECTED — that is the defect
        # being removed. Structural errors show up as large or systematic diffs.
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
        from core.db import read_report          # noqa: E402
        status = read_report("rpt_aum_status")
        print(f"aum_status from report DB (different snapshot): {len(status):,} rows")
    else:
        print("running aum_status.sql (current aggregate) ...", flush=True)
        status = run_sql_file("aum_status.sql", subs=_subs())
        print(f"  {len(status):,} rows")

    got = derive(loans)
    print(f"\nderived aggregate: {len(got):,} rows   vs   aum_status: {len(status):,} rows")

    want = shape_status(status)
    missing = [k for k in GROUP_KEYS if k not in want.columns]
    if missing:
        print(f"\nCANNOT COMPARE — aum_status lacks: {missing}")
        return 1
    for k in GROUP_KEYS:
        want[k] = want[k].astype(str)

    print("\n--- TOTALS (the number that matters) ---")
    rows = []
    for name in MEASURES:
        a, b = float(got[name].sum()), float(want[name].sum())
        rows.append((name, a, b, a - b))
    t = pd.DataFrame(rows, columns=["measure", "derived", "aum_status", "diff"])
    print(t.to_string(index=False))

    print("\n--- LIVE BOOK (Excl W/O: loan_status Active + Death) ---")
    gl = got[got.loan_status.isin(["Active", "Death"])]
    wl = want[want.loan_status.isin(["Active", "Death"])]
    print(f"  derived     {gl.loan_count.sum():,} loans   {gl.total_pos.sum()/1e7:,.2f} Cr")
    print(f"  aum_status  {wl.loan_count.sum():,} loans   {wl.total_pos.sum()/1e7:,.2f} Cr")

    m = got.merge(want, on=GROUP_KEYS, how="outer", suffixes=("_got", "_want"), indicator=True)
    only_got = int((m._merge == "left_only").sum())
    only_want = int((m._merge == "right_only").sum())
    both = m[m._merge == "both"]
    print(f"\n--- KEY MATCH ---\n  both {len(both):,}   only-derived {only_got}   only-aum_status {only_want}")

    print("\n--- PER-MEASURE MISMATCHES ON SHARED KEYS ---")
    worst = 0
    for name in MEASURES:
        d = (both[f"{name}_got"].astype(float) - both[f"{name}_want"].astype(float)).abs()
        n = int((d > 0.01).sum())
        worst = max(worst, n)
        print(f"  {name:<18} rows differing: {n:>6}   max abs diff: {d.max():,.2f}")

    ok = (only_got == 0 and only_want == 0 and worst == 0)
    print("\nRESULT:", "EXACT MATCH — safe to derive" if ok
          else "DIFFERENCES PRESENT — inspect before switching (may be replica drift)")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
