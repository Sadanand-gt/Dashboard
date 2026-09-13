# Deploying the Ananya MIS pipeline on AWS

## What the pipeline actually touches

Two databases, and only two:

| | instance | region | database | role |
|---|---|---|---|---|
| **read** | `ananyaapp-replica…` | **ap-south-2** (Hyderabad) | `Ananya_app_prod` | every source query |
| **read** | *same instance* | ap-south-2 | `cb_engine` | bureau decision output |
| **write** | `ananya-app-prod…` | **ap-south-1** (Mumbai) | `ananya_mis_dashboard` | all `rpt_*` tables + `writeoff_master` |

`ananya_data` (`13.206.64.132`) is third-party and is **not** touched by the
daily run — the only script that reads it is `build_shortlisted_pool.py`, a
one-off for the accounts team. The pipeline takes its data from
`Ananya_app_prod`, which is where `ananya_data` is synced to. That constraint is
already satisfied by the code; nothing needs changing to honour it.

## Put the instance in ap-south-2

The run is **read-heavy and write-light** — it scans millions of rows out of
`Ananya_app_prod` and writes a few hundred thousand report rows back. The five
reports that fail on the laptop (`aum_status`, `aum_loans`, `collection_loans`,
`trend_monthly`, `trend_full`) all die with `SSL connection has been closed
unexpectedly`, which is the signature of a long scan over a slow link — the
reads, not the writes.

So co-locate with the SOURCE, in **ap-south-2**, and let the comparatively tiny
writes cross to ap-south-1. Putting it in ap-south-1 instead would leave the
failing queries exactly as exposed as they are today.

A `t3.medium` is enough (the laptop does it in ~1h50m on 8 GB), but give it room
— `trend_full` rebuilds the entire history nightly.

## Security groups

* the instance needs outbound **5432** to both RDS instances
* each RDS security group needs an inbound **5432** rule for the instance's
  security group — cross-region means this is **not** covered by a default VPC
  rule, and it is the first thing to check when the first run cannot connect

## Install

```bash
sudo bash deploy/install-pipeline-timer.sh
```

Creates the `ananya` service account, `/opt/ananya_mis`, a venv, logrotate, and
a systemd timer firing at **06:00 IST** with `Persistent=true` — a run missed
because the box was down happens on next boot instead of being skipped in
silence, which is precisely how the laptop job kept failing unnoticed.

`.env` is **not** generated — it holds credentials. Copy it and lock it down:

```bash
sudo install -o ananya -g ananya -m 600 /path/to/.env /opt/ananya_mis/.env
```

If you would rather not have credentials on disk, put them in Secrets Manager
and have the unit fetch them into the environment at start; the units are plain
systemd so an `ExecStartPre` is all it takes. The `.env` file is the default
only because it matches how the pipeline already runs.

## Before trusting it

Both checks are printed by the installer. **The second is not optional.**

`get_writeoff_triples()` in `load_writeoff_master.py` catches *every* exception
and returns an empty list. A missing `.env`, an unreachable `ananya_mis_dashboard`
or a bad `search_path` therefore produces a run that looks green while injecting
**zero** write-off ids — silently wrong numbers everywhere, which is worse than a
failed run. It should read about **30,661**. Every report logs
`injecting N write-off ids from writeoff_master`; a sudden `0` is the tell.

Note the server needs no Excel file for this: with `REPORT_BACKEND=postgres` the
master is read from the `writeoff_master` **table** in `ananya_mis_dashboard`.
The `.xlsx` is only for the loader, which stays a manual refresh.

## Operating it

```bash
sudo systemctl start ananya-pipeline.service     # run now
systemctl status ananya-pipeline.service         # did the last run pass?
systemctl list-timers ananya-pipeline.timer      # when does it fire next?
sudo journalctl -u ananya-pipeline -f            # follow
tail -f /var/log/ananya_mis/pipeline.log         # the pipeline's own log
```

A run is **failed if any single report failed** — `daily_run` exits non-zero on
purpose, so `systemctl status` goes red instead of a misleading green.

## Why the laptop job could never work

For the record, since it was registered and enabled and still never ran properly:

| setting | value | consequence |
|---|---|---|
| `Principal.LogonType` | `Interactive` | runs only while that user is logged in |
| `WakeToRun` | `False` | asleep at 06:00 → no run |
| `StartWhenAvailable` | `True` | fired whenever the lid next opened — 10:02, 09:47, 21:38 |
| `RestartCount` | `0` | a failed night stayed failed |
| task history log | **disabled** | no record of whether it ran at all |
| `LastTaskResult` | `1` | the last run genuinely failed |

`192.168.1.237` — the address the dashboard is reached on — is that laptop's own
Wi-Fi address.

## Two things this does not cover

**The backend API.** `install-backend-service.ps1` runs FastAPI under NSSM on
Windows; there is no systemd equivalent here yet, and no `AnanyaMIS*` service is
installed on the laptop either — the API is whatever uvicorn someone started by
hand. Worth doing once the pipeline is settled.

**`TREND_FULL_REBUILD = True`** in `pipeline/daily_run.py` rebuilds the whole
trend history nightly. Deliberate and documented there, but it is what makes the
run heavy, and it means published months can be restated by back-dated
corrections. Set it to `False` to restore frozen history.
