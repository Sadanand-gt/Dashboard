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

from pipeline.runner import REPORTS, SPLIT_REPORTS, run_report

ATTEMPTS = 3
RETRY_WAIT_S = 30


def main() -> int:
    t0 = datetime.now()
    print(f"=== Ananya MIS daily pipeline — {t0:%Y-%m-%d %H:%M:%S} ===", flush=True)

    jobs = [(k, ("report", sqlf, table)) for k, sqlf, table in REPORTS]
    jobs += [(k, ("split", None, None)) for k in SPLIT_REPORTS]

    results = {}
    for key, (kind, sqlf, table) in jobs:
        ok = False
        for attempt in range(1, ATTEMPTS + 1):
            print(f"\n--- {key} (attempt {attempt}/{ATTEMPTS}) — {datetime.now():%H:%M:%S} ---", flush=True)
            try:
                ok = SPLIT_REPORTS[key]() if kind == "split" else run_report(key, sqlf, table)
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
