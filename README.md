# Ananya Finance MIS — Backend

## Architecture

```
PostgreSQL (RDS)  →  SQL Queries  →  pipeline/runner.py  →  reports.db (SQLite)  →  Dash Dashboard
```

All business logic lives in SQL. Python only orchestrates + stores. Dashboard reads only from SQLite — **zero PostgreSQL at render time**.

---

## Reports

| Report Key        | SQL File                | SQLite Table          | Description                          |
|-------------------|-------------------------|-----------------------|--------------------------------------|
| `aum_status`      | aum_status.sql          | `rpt_aum_status`      | Live AUM with DPD buckets (Standard/SMA-0/SMA-1/SMA-2/NPA/WO) |
| `daily_collection`| daily_collection.sql    | `rpt_daily_collection`| Daily CE% with PMSD comparison      |
| `mtd_collection`  | collection_eff.sql      | `rpt_mtd_collection`  | MTD CE% with PMSD + opening advance  |
| `disbursement`    | disbursement.sql        | `rpt_disbursement`    | Prev month + MTD disbursement        |
| `writeoff`        | writeoff.sql            | `rpt_writeoff`        | WO portfolio + post-WO recovery      |
| `pos_par`         | pos_par.sql             | `rpt_pos_par`         | POS & PAR (EOM + Live)               |

---

## Key PBI Logic Translated to SQL

| PBI Measure                  | SQL Equivalent                                         |
|------------------------------|--------------------------------------------------------|
| `This Month Demand Date`     | `demand_date > period_end AND demand_date <= mtd_cutoff` |
| `mtd collection_date`        | `collection_date_time::date > period_end AND <= mtd_cutoff` |
| `mtd collection_date PMSD`   | `collection_date_time::date BETWEEN prev_month_start AND pmsd_cutoff` |
| `Net Demand of the Day`      | `SUM(total_amt_due) WHERE demand_date = col_date`      |
| `Collection on the same day` | `SUM(amount_collected) WHERE collection_date = col_date` |
| `Collection MTD`             | MTD collected + opening_advance, capped at demand      |
| `Collection PMSD`            | `SUM(amount_collected) WHERE date BETWEEN prev_start AND pmsd_cutoff` |
| `Demand calc`                | `SUM(total_amt_due)` from repayment_schedule           |
| Opening Advance              | `MAX(cumul_collected - cumul_due at period_end, 0)`   |
| DPD (simplified)             | `(today - MIN(demand_date)) WHERE total_amt_collected < total_amt_due` |

### Key Columns Used (from PBI model)
- `loan_account_il.WRITEOFF_DATE` — write-off date (not CLOSURE_DATE)
- `repayment_detail_il.AMOUNT_COLLECTED` — total per receipt
- `repayment_detail_il.COLL_PAY_MODE` — Cash/Bank/Other
- `repayment_schedule_il.TOTAL_AMT_COLLECTED` — collected per installment
- `repayment_schedule_il.TOTAL_AMT_DUE` — demand per installment

---

## Dashboard Pages

| URL            | Page                        |
|----------------|-----------------------------|
| `/`            | Executive Summary           |
| `/aum`         | Current Status AUM          |
| `/daily`       | Daily Collection Efficiency |
| `/mtd`         | MTD Collection Efficiency   |
| `/disbursement`| Disbursement                |
| `/pos-par`     | POS & PAR                   |
| `/writeoff`    | Write-Off Portfolio         |

---

## Setup

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Configure DB credentials
cp .env.example .env
# Edit .env with your PostgreSQL credentials

# 3. Test connection
python -m pipeline.db

# 4. Run pipeline (all reports)
python -m pipeline.runner

# 5. Run single report
python -m pipeline.runner --report aum_status
python -m pipeline.runner --report daily_collection
python -m pipeline.runner --report mtd_collection
python -m pipeline.runner --report disbursement
python -m pipeline.runner --report writeoff
python -m pipeline.runner --report pos_par

# 6. Start dashboard
python dashboard/app.py
# Open: http://localhost:8050

# 7. Start daily scheduler (06:00 AM IST)
python scheduler.py
```

---

## SQLite Tables

| Table                  | Rows (approx)  | Refresh |
|------------------------|----------------|---------|
| `rpt_aum_status`       | ~5K            | Daily   |
| `rpt_daily_collection` | ~60 days × branches | Daily |
| `rpt_mtd_collection`   | ~branches      | Daily   |
| `rpt_disbursement`     | ~branches × products | Daily |
| `rpt_writeoff`         | ~months × branches | Daily |
| `rpt_pos_par`          | ~branches × type | Daily |
| `pipeline_log`         | grows daily    | Each run|
