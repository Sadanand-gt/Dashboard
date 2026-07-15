"""One-off driver: rerun every report whose SQL gained lo_id, with retries.

Ordered lightest -> heaviest so results land early. Each report gets up to
3 attempts (RDS replica drops SSL on long scans now and then).
Run:  python -m pipeline.run_lo_id_refresh
"""
import time
from datetime import datetime

from pipeline.runner import REPORTS, SPLIT_REPORTS, run_report

# report keys changed by the lo_id rollout (case_movement intentionally
# excluded — origination funnel has no officer on its source rows)
KEYS = [
    "cashless_collection", "daily_collection", "delinquencies", "writeoff",
    "mtd_collection", "disbursement", "pos_par", "aum_live",
    "bucket_movement",                       # split (IL+JLG)
    "dq_category", "aum_status", "od_list", "od_slippage", "collection_fact",
]

BY_KEY = {r[0]: r for r in REPORTS}

def run_one(key: str) -> bool:
    if key in SPLIT_REPORTS:
        return SPLIT_REPORTS[key]()
    _, sqlf, table = BY_KEY[key]
    return run_report(key, sqlf, table)

def main():
    t0 = datetime.now()
    results = {}
    for key in KEYS:
        ok = False
        for attempt in range(1, 4):
            print(f"\n=== {key} (attempt {attempt}) — {datetime.now():%H:%M:%S} ===", flush=True)
            try:
                ok = run_one(key)
            except Exception as e:
                print(f"    unexpected error: {str(e)[:120]}", flush=True)
                ok = False
            if ok:
                break
            time.sleep(20)
        results[key] = ok

    print("\n" + "=" * 60, flush=True)
    print(f"LO_ID refresh done in {(datetime.now()-t0).seconds}s", flush=True)
    for k, v in results.items():
        print(f"  {'OK  ' if v else 'FAIL'}  {k}", flush=True)
    print("=" * 60, flush=True)

if __name__ == "__main__":
    main()
