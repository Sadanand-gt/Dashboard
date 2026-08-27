"""
gen_loan_grain.py — regenerate the loan-grain queries from their parents.

    python -m pipeline.gen_loan_grain           # regenerate all
    python -m pipeline.gen_loan_grain --check   # fail if any is stale (CI-style)

WHY THIS EXISTS
    aum_loans.sql and collection_loans.sql each reproduce their parent report's
    ENTIRE CTE block — the universe, the write-off master with its date gate,
    open_now on T-1, the graduated-customer dedupe, the DPD reconstruction. That
    is deliberate: an export built from its own universe drifts from the page it
    came from, and copying the parent verbatim is what makes rpt_aum_loans and
    rpt_collection_loans reconcile to their pages exactly.

    But a copy kept in step by a comment is not kept in step. This project has
    already paid for that once: the LAP classification rule was wrong in SIX
    queries because %SECURED% was added to some copies and not others.

    So the copy is now MECHANICAL. Each child file is:

        <generated header>
        <parent CTE block, copied verbatim>
        <SPLIT marker>
        <hand-written loan-grain projection>

    Everything above the marker is regenerated from the parent; everything below
    is the child's own and is preserved. Change a parent, run this, and the child
    follows — no one has to remember.

RUN THIS after editing aum_status.sql or collection_fact.sql, then re-run the
    affected report and check its reconciliation.
"""
from __future__ import annotations

import argparse
import os
import sys

QDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "queries")

SPLIT = ("-- ===========================================================================\n"
         "-- LOAN-GRAIN PROJECTION — hand-maintained.\n"
         "-- EVERYTHING ABOVE THIS LINE IS GENERATED from the parent query by\n"
         "-- pipeline/gen_loan_grain.py. Do not hand-edit it; edit the parent and\n"
         "-- regenerate. Everything below is this file's own and is preserved.\n"
         "-- ===========================================================================\n")

# child -> (parent, header)
SPECS = {
    "aum_loans.sql": (
        "aum_status.sql",
        """-- =============================================================================
-- Current Outstanding — LOAN GRAIN  ->  rpt_aum_loans
--
-- One row per loan. Feeds the Current Outstanding loan-wise CSV export and the
-- loan_id lookup (rpt_aum_status is aggregated and has no loan_id, so filtering
-- it on loan_id was a silent no-op).
--
--   RECONCILIATION — must hold after every run:
--     loan_status IN ('Active','Death')             = Current Outstanding Excl W/O
--     loan_status IN ('Active','Death','Write-off') = Current Outstanding With W/O
--
-- The CTE block below is GENERATED from aum_status.sql. See gen_loan_grain.py.
-- report_day is NOT selected here; pg_write_report_day stamps it on write.
-- =============================================================================
"""),
    "collection_loans.sql": (
        "collection_fact.sql",
        """-- =============================================================================
-- Collection — LOAN GRAIN  ->  rpt_collection_loans
--
-- One row per loan with a T-1 or MTD demand OR receipt. Feeds the loan-wise CSV
-- export on the T-1 and MTD Collection pages, and the loan_id lookup.
--
--   RECONCILIATION — must hold after every run:
--     sum(ftod_flag)      = rpt_collection.mtd_ftod
--     sum(t1_ontime)      = rpt_collection.t1_ontime
--     sum(mtd_collection) = rpt_collection.mtd_collection
--
-- MEASURE NOTES — do not re-derive downstream:
--   t1_ontime  CAPPED per loan: least(t1_collection, t1_demand). Total collection
--     includes arrears against older dues, which is why the uncapped
--     t1_collection / t1_demand read 110.15% on 2026-08-13.
--   mtd_ontime  TIMING measure (receipts on/before the loan's last MTD demand
--     date) that is now ALSO CAPPED per loan at that loan's own demand, matching
--     t1_ontime. Before the cap it exceeded demand on 1,723 loans (Rs 52.4 L) and
--     pushed branch-level MTD OTRR over 100% — 5 branches, max 103.40%.
--     It is NOT least(mtd_collection, mtd_demand): that is the capped CE (93.22%)
--     and would count loans paying AFTER their due date as on-time.
--   ftod_flag  first-time OD AND not written off, so it agrees with the OD
--     Status matrix by construction.
--
-- The CTE block below is GENERATED from collection_fact.sql. See gen_loan_grain.py.
-- report_day is NOT selected here; pg_write_report_day stamps it on write.
-- =============================================================================
"""),
}


def _read(name: str) -> str:
    with open(os.path.join(QDIR, name), encoding="utf-8") as f:
        return f.read()


def parent_ctes(parent_sql: str) -> str:
    """The parent's CTE block: everything before its final aggregating SELECT.

    The final SELECT is the last one starting at column 0 — CTE-internal SELECTs
    are always indented. Cutting there keeps every CTE and drops only the
    aggregation the child replaces.
    """
    lines = parent_sql.split("\n")
    idx = [i for i, l in enumerate(lines) if l.startswith("SELECT")]
    if not idx:
        raise SystemExit("no column-0 SELECT found in parent")
    cut = idx[-1]
    # walk back over blank lines and comment banners so the block ends on the
    # CTE's closing ')' rather than on a section divider
    while cut > 0 and (lines[cut - 1].strip() == ""
                       or lines[cut - 1].lstrip().startswith("--")):
        cut -= 1
    block = "\n".join(lines[:cut]).rstrip()
    if not block.endswith(")"):
        raise SystemExit(f"parent CTE block does not end with ')': ...{block[-60:]!r}")
    return block


def build(child: str) -> str:
    parent, header = SPECS[child]
    tail = _read(child).split(SPLIT, 1)
    if len(tail) != 2:
        raise SystemExit(f"{child}: SPLIT marker missing — add it above the final SELECT")
    return header + parent_ctes(_read(parent)) + "\n\n" + SPLIT + tail[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if any child is stale, without writing")
    args = ap.parse_args()

    stale = []
    for child in SPECS:
        want = build(child)
        path = os.path.join(QDIR, child)
        have = _read(child)
        if want == have:
            print(f"  {child}: up to date")
            continue
        stale.append(child)
        if args.check:
            print(f"  {child}: STALE — parent changed, run gen_loan_grain.py")
            continue
        with open(path, "w", encoding="utf-8") as f:
            f.write(want)
        print(f"  {child}: regenerated from {SPECS[child][0]}")

    if args.check and stale:
        print(f"\n{len(stale)} file(s) stale.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
