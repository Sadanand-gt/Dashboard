"""Daily scheduled pipeline run — all reports with per-report retries.

Differences from `python -m pipeline.runner` (which is fine for manual runs):
  * each report gets up to 3 attempts (the RDS replica drops SSL on long
    scans now and then — collection_fact especially),
  * exits NON-ZERO if any report still fails, so Windows Task Scheduler
    shows the run as failed instead of silently green.

Run:  python -m pipeline.daily_run
"""
import sys
import time
from datetime import datetime

from pipeline.runner import REPORTS, SPLIT_REPORTS, run_report, run_trend_full

ATTEMPTS = 3
RETRY_WAIT_S = 30

# Rebuild the WHOLE trend history every night rather than only the last month.
#
# Why: rpt_trend_full is frozen at build time while rpt_aum_status recomputes
# daily, so late-arriving data dated on or before the month-end moves OD Status
# but not the trend. Measured drift was ~14 loans in a single day. A full rebuild
# re-derives every month from current source, so the trend and OD Status agree
# every morning.
#
# The cost, stated plainly: this REVERSES the freeze. Published months can now be
# restated by back-dated corrections — a death flagged in September, or a loan
# added to the write-off master, will change July's numbers. Set this to False to
# restore frozen history (the trend then rewrites only the last completed month,
# and the drift returns).
TREND_FULL_REBUILD = True


def main() -> int:
    t0 = datetime.now()
    print(f"=== Ananya MIS daily pipeline — {t0:%Y-%m-%d %H:%M:%S} ===", flush=True)
    print(f"    trend_full: {'FULL REBUILD (all months)' if TREND_FULL_REBUILD else 'incremental (history frozen)'}", flush=True)

    jobs = [(k, ("report", sqlf, table)) for k, sqlf, table in REPORTS]
    jobs += [(k, ("split", None, None)) for k in SPLIT_REPORTS]

    results = {}
    for key, (kind, sqlf, table) in jobs:
        ok = False
        for attempt in range(1, ATTEMPTS + 1):
            print(f"\n--- {key} (attempt {attempt}/{ATTEMPTS}) — {datetime.now():%H:%M:%S} ---", flush=True)
            try:
                if key == "trend_full":
                    ok = run_trend_full(full_rebuild=TREND_FULL_REBUILD)
                elif kind == "split":
                    ok = SPLIT_REPORTS[key]()
                else:
                    ok = run_report(key, sqlf, table)
            except Exception as e:
                print(f"    unexpected error: {str(e)[:140]}", flush=True)
                ok = False
            if ok:
                break
            if attempt < ATTEMPTS:
                time.sleep(RETRY_WAIT_S)
        results[key] = ok

    failed = [k for k, v in results.items() if not v]
    print("\n" + "=" * 60, flush=True)
    print(f"Daily pipeline done in {(datetime.now() - t0).seconds}s — "
          f"OK={len(results) - len(failed)}  FAIL={len(failed)}", flush=True)
    for k, v in results.items():
        print(f"  {'OK  ' if v else 'FAIL'}  {k}", flush=True)
    print("=" * 60, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
