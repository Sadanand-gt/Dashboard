"""
gen_portfolio_cuts_asof.py — build Portfolio Cuts as at any month-end.

Writes rpt_portfolio_cuts_hist with report_day = the as-on date. That table
already exists and mis_dashboard already holds INSERT/SELECT/DELETE on it, so
this needs NO DDL.

    python gen_portfolio_cuts_asof.py --verify              reconcile vs the live report
    python gen_portfolio_cuts_asof.py --month 2026-07-31    one month-end
    python gen_portfolio_cuts_asof.py --from 2022-04-01     backfill to the last closed month
    python gen_portfolio_cuts_asof.py --latest              just the most recent closed month

WHY A RECONCILIATION GATE
    The as-on query rebuilds DPD and POS from repayment history instead of
    reading the core system's current balance. --verify runs it at
    current_date - 1 and compares against the live rpt_portfolio_cuts. They will
    not match to the rupee — the live report reads la.principal_outstanding,
    which carries the core system's own adjustments, while this recomputes from
    cash vs due — so the gate is a TOLERANCE, not equality, and the measured gap
    is printed every run. A sudden move in that gap means the method drifted.

FY SEMANTICS
    An FY resolves to its CLOSING month-end: FY25-26 -> 2026-03-31. For the FY
    still in progress it resolves to the latest closed month instead, and the
    caller is told which date it landed on. Portfolio Cuts is a stock report, so
    a point-in-time close is the only coherent reading of "as on FY25-26".
"""

import argparse
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

# The REPO ROOT goes on sys.path, not this directory. load_writeoff_master
# resolves its own dependencies as `from pipeline.report_store import ...`, and
# it wraps that import in a bare `except Exception: return []`. Put only
# pipeline/ on the path and the package import fails silently, the write-off
# master comes back EMPTY, and every month-end builds with zero write-offs —
# no error, just a wrong answer. Same silent-no-op class as multi()/{wo_ids}.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline.db import run_sql_file                                  # noqa: E402
from pipeline.load_writeoff_master import writeoff_triples_literal    # noqa: E402
from pipeline.report_store import pg_write_report_day, pg_read        # noqa: E402

HIST = "rpt_portfolio_cuts_hist"
BACKFILL_FROM = date(2022, 4, 1)   # covers FY22-23 onward, so "from FY23" is included
                                   # whether that means FY22-23 or FY23-24.


def month_ends(start: date, end: date) -> list[date]:
    """Every month-end from `start`'s month through `end`'s month, inclusive."""
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        nxt = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
        out.append(nxt - timedelta(days=1))
        y, m = nxt.year, nxt.month
    return out


def last_closed_month(today: date | None = None) -> date:
    """Last month-end strictly before the current month — a month still running
    would give a partial cut that looks like a collapse in the book."""
    t = today or date.today()
    return date(t.year, t.month, 1) - timedelta(days=1)


def fy_close(label: str) -> date:
    """'FY25-26' -> 2026-03-31. Clamped to the last closed month for a live FY."""
    a, b = label.replace("FY", "").split("-")
    end_year = 2000 + int(b)
    return min(date(end_year, 3, 31), last_closed_month())


def wo_literal() -> str:
    """Write-off master as a VALUES body, with a HARD CHECK. The loader returns a
    single dummy row when it cannot reach the master, which would silently build
    a book with no write-offs at all — so refuse instead."""
    lit = writeoff_triples_literal()
    if lit.count("(") < 100:
        raise RuntimeError(
            f"write-off master looks empty ({lit.count('(')} rows) — refusing to "
            f"build. Expected ~30,000. Check the report store is reachable.")
    return lit


def build(as_on: date) -> int:
    """Run the as-on query and replace that day's rows in the history table."""
    subs = {"as_on": as_on.isoformat(), "wo_triples": wo_literal()}
    t0 = time.time()
    df = run_sql_file("portfolio_cuts_asof.sql", subs=subs)
    if df.empty:
        print(f"  {as_on}  NO ROWS — skipped (nothing on the book at that date?)")
        return 0
    # pg_write_report_day stamps report_day, replaces only that day and never
    # prunes. write_report() is deliberately NOT used: it targets the live table
    # and applies a rolling retention window that would delete the backfill.
    pg_write_report_day(df, HIST, as_on.isoformat())
    # Report the book from ONE cut type. Every loan appears once per cut, so
    # summing across all 11 would multiply POS and loans by 11.
    seg = df[df.cut_type == "Business Segment"]
    print(f"  {as_on}  {len(df):>6,} rows  POS {seg.pos_total.sum()/1e7:>8,.2f} Cr"
          f"  loans {int(seg.n_total.sum()):>7,}"
          f"  PAR0+ {seg.par0_pos.sum()/max(seg.pos_total.sum(),1)*100:>5.2f}%"
          f"  {time.time() - t0:>5.0f}s")
    return len(df)


def verify() -> None:
    """Run the as-on query at the live report's own date and compare."""
    # The live report lives in the REPORT store, not the source replica, so this
    # reads through pg_read. Latest report_day only — the table keeps a rolling
    # window of daily snapshots.
    live = pg_read("""SELECT data_date, sum(pos_total) pos, sum(n_total) n
                      FROM rpt_portfolio_cuts
                      WHERE cut_type = 'Business Segment'
                        AND report_day = (SELECT max(report_day) FROM rpt_portfolio_cuts)
                      GROUP BY 1""")
    if live.empty:
        print("live rpt_portfolio_cuts is empty — nothing to reconcile against")
        return
    as_on = pd.to_datetime(live.data_date.iloc[0]).date()
    print(f"reconciling as-on query at {as_on} against the live report ...")
    df = run_sql_file("portfolio_cuts_asof.sql",
                      subs={"as_on": as_on.isoformat(), "wo_triples": wo_literal()})
    seg = df[df.cut_type == "Business Segment"]
    lp, ln = float(live.pos.iloc[0]), int(live.n.iloc[0])
    ap, an = float(seg.pos_total.sum()), int(seg.n_total.sum())
    print(f"  loans   live {ln:>9,}   as-on {an:>9,}   diff {an - ln:>+8,} "
          f"({(an - ln) / ln * 100:+.2f}%)")
    print(f"  POS Cr  live {lp/1e7:>9,.2f}   as-on {ap/1e7:>9,.2f}   diff "
          f"{(ap - lp)/1e7:>+8,.2f} ({(ap - lp) / lp * 100:+.2f}%)")
    print("\n  A gap is EXPECTED: the live report reads the core system's own\n"
          "  principal_outstanding, this recomputes from cash vs due. Watch the\n"
          "  percentage over time — a jump means the method drifted.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--month", help="a single month-end, YYYY-MM-DD")
    ap.add_argument("--fy", help="an FY label, e.g. FY25-26")
    ap.add_argument("--from", dest="frm", help="backfill start, YYYY-MM-DD")
    ap.add_argument("--latest", action="store_true", help="the last closed month only")
    a = ap.parse_args()

    if a.verify:
        verify(); return
    if a.month:
        build(date.fromisoformat(a.month)); return
    if a.fy:
        d = fy_close(a.fy); print(f"{a.fy} resolves to {d}"); build(d); return
    if a.latest:
        build(last_closed_month()); return

    start = date.fromisoformat(a.frm) if a.frm else BACKFILL_FROM
    months = month_ends(start, last_closed_month())
    print(f"backfilling {len(months)} month-ends: {months[0]} .. {months[-1]}\n")
    t0, done = time.time(), 0
    for d in months:
        try:
            done += 1 if build(d) else 0
        except Exception as e:
            print(f"  {d}  FAILED: {type(e).__name__}: {str(e).splitlines()[0][:120]}")
    print(f"\n{done}/{len(months)} month-ends built in {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
