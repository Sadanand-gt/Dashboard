"""Regression guard for rpt_trend_full rebuilds.

Run before and after any change to the trend engine:

    python -m pipeline.verify_trend_rebuild --save     # capture a baseline
    ... make the change, rebuild ...
    python -m pipeline.verify_trend_rebuild            # compare

WHY IT IS NOT AN EQUALITY CHECK
    The nightly --full-rebuild restates every month from current source, so a
    published figure legitimately moves when a source record is corrected —
    a back-dated reschedule, a death flagged late, a loan added to the write-off
    master. That is the rebuild working as designed, not a regression.

    An exact-equality guard therefore cries wolf. On 2026-08-11 it flagged
    reg_demand at +Rs 2,500 in Jun and Jul; the cause was two IL loans whose
    schedules were revised on 10-Aug, not the code change being tested. Chasing
    it cost a wasted revert recommendation.

    So this guard asks the decisive question instead: DID ANYTHING MOVE, AND CAN
    THE MOVEMENT BE ATTRIBUTED TO A SOURCE REVISION IN THAT MONTH? Movement with
    a matching revision is EXPECTED. Movement without one is UNEXPLAINED and is
    the only thing worth stopping for.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import pandas as pd
from sqlalchemy import text

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend.core.db import reports_conn          # noqa: E402
from pipeline.db import _get_engine               # noqa: E402

BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "trend_baseline.json")

# Measures worth guarding: the ones other reports publish. A move here is a move
# on somebody's dashboard.
MEASURES = ["loans_eom", "pos_eom", "reg_demand", "reg_collection",
            "par0_pos", "par30_pos", "par90_pos", "collection_capped"]

# Tolerance: a rupee measure may drift a little on legitimate restatement, but
# loan COUNTS should not move without an explanation, so they get zero slack.
ABS_TOL = {"loans_eom": 0}
REL_TOL = 0.0005          # 0.05% on amounts
MONTHS_BACK = 6


def _read(sql, conn_factory, retries=5):
    for k in range(retries):
        try:
            with conn_factory() as c:
                return pd.read_sql(sql, c) if isinstance(sql, str) else pd.read_sql(sql, c)
        except Exception as e:
            if k == retries - 1:
                raise
            print(f"  retry ({str(e)[:60]})", flush=True)
            time.sleep(10)


def snapshot() -> pd.DataFrame:
    cols = ", ".join(f"sum({m}) AS {m}" for m in MEASURES)
    sql = f"""SELECT month_end::text AS month_end, {cols}
              FROM rpt_trend_full
              WHERE month_end >= (date_trunc('month', current_date)
                                  - interval '{MONTHS_BACK} months')::date
              GROUP BY 1 ORDER BY 1"""
    return _read(sql, reports_conn)


def source_revisions(month_end: str) -> dict:
    """Count source rows created OR modified since the baseline was taken, for
    the month in question. This is what turns 'it moved' into 'it moved
    because'. created_on alone is not enough — the 2026-08-11 case was rows
    REVISED in place, which created_on cannot see."""
    since = _load().get("_taken_at", "1900-01-01")[:10]
    m0 = pd.Timestamp(month_end).replace(day=1).date()
    m1 = (pd.Timestamp(month_end) + pd.offsets.MonthBegin(1)).date()
    out = {}
    for tbl, label in (("repayment_schedule", "JLG schedule"),
                       ("repayment_schedule_il", "IL schedule")):
        q = text(f"""SELECT count(*) FILTER (WHERE created_on::date >= :since)  AS created,
                            count(*) FILTER (WHERE modified_on::date >= :since) AS modified
                     FROM public.{tbl}
                     WHERE demand_date >= :m0 AND demand_date < :m1""")
        for k in range(4):
            try:
                with _get_engine().connect() as c:
                    r = pd.read_sql(q, c, params={"since": since, "m0": m0, "m1": m1})
                out[label] = (int(r["created"][0]), int(r["modified"][0]))
                break
            except Exception:
                if k == 3:
                    out[label] = (-1, -1)
                time.sleep(15)
    return out


def writeoff_master_state() -> dict:
    """Loan count and total value in the write-off master.

    The master is the OTHER thing that legitimately moves a published trend
    figure, and it is invisible to source_revisions() because it is a local
    table, not a replica one. On 2026-08-12 a master reload added 170 loans and
    the guard reported all 30 resulting movements as UNEXPLAINED — the numbers
    were right, the guard simply could not see the cause. Recording the master
    alongside the measures makes that attribution automatic.
    """
    try:
        with reports_conn() as c:
            r = pd.read_sql("SELECT count(*) loans, coalesce(sum(writeoff_amount),0) amount "
                            "FROM writeoff_master", c)
        return {"loans": int(r["loans"][0]), "amount": float(r["amount"][0])}
    except Exception:
        return {}


def _load() -> dict:
    if not os.path.exists(BASELINE):
        return {}
    with open(BASELINE, encoding="utf-8") as f:
        return json.load(f)


def save() -> None:
    df = snapshot()
    data = {"_taken_at": pd.Timestamp.now().isoformat(timespec="seconds"),
            "_writeoff_master": writeoff_master_state(),
            "rows": df.to_dict(orient="records")}
    with open(BASELINE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    print(f"baseline saved: {len(df)} months -> {BASELINE}")
    print(df.to_string(index=False))


def compare() -> int:
    base = _load()
    if not base:
        print("no baseline — run with --save first")
        return 2
    prev = pd.DataFrame(base["rows"]).set_index("month_end")
    now = snapshot().set_index("month_end")
    print(f"baseline taken {base['_taken_at']}\n")

    moved, unexplained = [], []
    for m in now.index:
        if m not in prev.index:
            continue
        for meas in MEASURES:
            a, b = float(prev.loc[m, meas] or 0), float(now.loc[m, meas] or 0)
            tol = ABS_TOL.get(meas, abs(a) * REL_TOL)
            if abs(b - a) > tol:
                moved.append((m, meas, a, b, b - a))

    if not moved:
        print("PASS — every guarded measure within tolerance")
        return 0

    # A master reload moves every month at once and is not month-specific, so it
    # is checked once and applies to the whole comparison.
    wo_base = base.get("_writeoff_master") or {}
    wo_now = writeoff_master_state()
    wo_moved = bool(wo_base) and bool(wo_now) and (
        wo_base.get("loans") != wo_now.get("loans")
        or abs(wo_base.get("amount", 0) - wo_now.get("amount", 0)) > 0.005)
    if wo_moved:
        print(f"  write-off master CHANGED since baseline: "
              f"{wo_base.get('loans'):,} -> {wo_now.get('loans'):,} loans, "
              f"Rs {wo_base.get('amount', 0):,.2f} -> Rs {wo_now.get('amount', 0):,.2f}")
        print("  Newly written-off loans leave the live book, so loans_eom and "
              "pos_eom SHOULD fall. Confirm the drop matches the added loans.\n")

    print(f"{len(moved)} measure(s) moved beyond tolerance:\n")
    checked: dict[str, dict] = {}
    for m, meas, a, b, d in moved:
        if m not in checked:
            checked[m] = source_revisions(m)
        rev = checked[m]
        touched = any(c > 0 or mo > 0 for c, mo in rev.values())
        if touched:
            tag = "EXPECTED (source revised)"
        elif wo_moved:
            tag = "EXPECTED (write-off master reloaded)"
        else:
            tag = "*** UNEXPLAINED ***"
            unexplained.append((m, meas))
        print(f"  {m}  {meas:<18} {a:>16,.2f} -> {b:>16,.2f}  ({d:+,.2f})   {tag}")
        for label, (c, mo) in rev.items():
            if c or mo:
                print(f"        {label}: {c} created, {mo} modified since baseline")

    if unexplained:
        print(f"\n*** {len(unexplained)} UNEXPLAINED — a code change moved a published "
              f"figure with no matching source revision. Investigate before shipping.")
        return 1
    print("\nAll movement attributed to source revisions — the rebuild is "
          "restating corrected data, which is what it is for.")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", action="store_true", help="capture a new baseline")
    args = ap.parse_args()
    sys.exit(save() or 0 if args.save else compare())
