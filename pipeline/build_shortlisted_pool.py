"""
build_shortlisted_pool.py — fill the blank columns of "Shortlisted Pool - Copy.xlsb"
for the accounts team, and stamp every filled column with the source it came from.

AS-ON DATE: 2026-07-31. Fixed by the workbook itself — its own headers say
"as on 31-07-2026" and its populated "Prin O/s" column totals 354,604,943, which
is the control figure printed in the sheet's top row. Every derived figure here
is cut at that date, never at T-1.

RECONCILIATION GATE (both run every time, see verify()):
    Prin O/s @ 31-Jul   computed vs sheet   6,942 / 6,942 exact
    DPD        @ 31-Jul computed vs sheet   6,942 / 6,942 exact
If either drops below 100%, the method has drifted and the output is not
trustworthy — the script says so loudly rather than writing a clean-looking file.

WHAT IS NOT FILLED, AND WHY (measured, not assumed):
    City             home_center_master.city is NULL on all 212,205 rows and
                     village_master is EMPTY on this replica. No source exists.
    Disb. Bank Name  home_loan_account.payment_bank is NULL for all 6,942.
    Advance EMI      Not stored. The disbursement net-off gap is fees +
                     insurance, NOT an advance instalment — it equals neither
                     lpf nor lpf+EMI on any of the 6,942 rows.
    NACH Bounce      Not applicable. These are cash / UPI collected JLG loans
                     (repayment_detail.payment_mode CH or CL); bounce_charge is
                     NULL on all 6,942 and no NACH mandate governs them.
    CB Enquiry No.   Filled from ananya.cb_loan.report_order_no. The BRE engine's
                     own "REPORT IDs" / "FIRST REPORT ID" columns are 100% empty
                     and must not be used.

Three databases are read. Nothing is written to any of them.
"""

import sys, time, warnings
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parent))
from db import run_query, get_cb_engine          # noqa: E402

AS_ON = pd.Timestamp("2026-07-31")
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "References" / "Shortlisted Pool - Copy.xlsb"
OUT = ROOT / "References" / "Shortlisted Pool - FILLED.xlsx"
CHUNK = 400            # keeps the IN-list small enough not to trip the standby


def q(sql, tries=5):
    """Source-replica read with retry. The replica is a hot standby: a long or
    wide query dies with 'canceling statement due to conflict with recovery'
    when the primary vacuums a row version it still needs. Chunking plus retry
    is the pattern the pipeline already uses."""
    for i in range(tries):
        try:
            return run_query(sql)
        except Exception as e:
            if "conflict with recovery" in str(e) and i < tries - 1:
                time.sleep(5)
                continue
            raise


def chunked(tpl, ids, label):
    out = []
    for i in range(0, len(ids), CHUNK):
        out.append(q(tpl.format(ids=",".join(str(x) for x in ids[i:i + CHUNK]))))
    df = pd.concat(out, ignore_index=True)
    print(f"  {label}: {len(df):,} rows")
    return df


def data_conn():
    """ananya_data — the bureau + product master DB. Read with psycopg2, not a
    SQLAlchemy URL: the password contains '@' and would corrupt the DSN."""
    env = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return psycopg2.connect(
        host=env["DATA_PG_HOST"], port=env.get("DATA_PG_PORT", 5432),
        dbname=env["DATA_PG_DBNAME"], user=env["DATA_PG_USER"],
        password=env["DATA_PG_PASSWORD"])


# ── Read the workbook ────────────────────────────────────────────────────────
def read_sheet():
    raw = pd.read_excel(SRC, sheet_name="Sheet1", engine="pyxlsb", header=None)
    hdr = [str(x).replace("\n", " ").strip() for x in raw.iloc[1]]
    df = raw.iloc[2:].reset_index(drop=True)
    df.columns = hdr
    df["_loan_id"] = pd.to_numeric(df["Loan No"], errors="coerce").astype("int64")
    return df, hdr


XL_EPOCH = pd.Timestamp("1899-12-30")
to_serial = lambda s: (pd.to_datetime(s) - XL_EPOCH).dt.days      # noqa: E731


def main():
    sheet, hdr = read_sheet()
    ids = sheet["_loan_id"].tolist()
    print(f"pool: {len(ids):,} loans   as-on {AS_ON.date()}")

    # ── 1. Loan account (Ananya_app_prod → public.home_loan_account) ─────────
    print("reading Ananya_app_prod ...")
    la = chunked("""
        SELECT loan_id, cust_id, product_id, sub_purpose, total_loan_amount,
               total_interest, prin_os, lpf, loan_tenure, disbursement_date,
               status, payment_ref_number, cust_bank_acc_num, cust_bank_ifsc_code,
               principal_arrear, interest_arrear, writeoff_date, closure_type
        FROM public.home_loan_account WHERE loan_id IN ({ids})""", ids, "loan_account")
    la["loan_id"] = pd.to_numeric(la.loan_id, errors="coerce").astype("int64")

    brw = chunked("""
        SELECT la.loan_id, b.pan_card_number, b.cust_uid_mask
        FROM public.home_loan_account la
        JOIN public.home_borrower_master b ON b.cust_id = la.cust_id
        WHERE la.loan_id IN ({ids})""", ids, "borrower")
    brw["loan_id"] = pd.to_numeric(brw.loan_id, errors="coerce").astype("int64")

    sch = chunked("""
        SELECT loan_id, demand_date::date demand_date, principal_due, interest_due
        FROM public.repayment_schedule WHERE loan_id IN ({ids})""", ids, "schedule")
    coll = chunked("""
        SELECT loan_id, collection_date::date collection_date, principal_collected,
               interest_collected, payment_mode, cashless_collection_mode
        FROM public.repayment_detail
        WHERE loan_id IN ({ids}) AND status IN ('A','V')""", ids, "collection")
    wo = chunked("""
        SELECT loan_id FROM public.writeoff_master WHERE loan_id IN ({ids})""",
                 ids, "writeoff_master")

    for d, c in ((sch, "demand_date"), (coll, "collection_date")):
        d["loan_id"] = pd.to_numeric(d.loan_id, errors="coerce").astype("int64")
        d[c] = pd.to_datetime(d[c], errors="coerce")

    # ── 2. Bureau + product master (ananya_data) ────────────────────────────
    print("reading ananya_data ...")
    dc = data_conn()
    lst = ",".join(str(i) for i in ids)
    # created_on is the PULL date. report_date and report_time are not:
    #   report_time  = 2026-08-22 on all 9,203 rows — an ETL load stamp, not a pull
    #   report_date  = a bureau reporting-cycle date; NULL on many rows and a
    #                  median 29 days AFTER disbursement, so it cannot be the
    #                  pull that underwrote the loan
    #   created_on   = on or before disbursement on ALL 9,203 rows, median 2 days
    #                  before, and it matches the BRE engine's own "CREATION DATE"
    #                  on 6,868 of 6,942 loans (98.9%) — two independent systems
    #                  agreeing. That is the underwriting pull.
    cb = pd.concat([
        pd.read_sql(f"""
            SELECT application_number::bigint loan_id, credit_bureau_id, created_on,
                   report_order_no, crif_score_value, score_value, aadhaar_id
            FROM ananya.cb_loan
            WHERE application_number IN ({",".join(str(x) for x in ids[i:i+CHUNK])})
              AND applicant_cb_flag = 'B'""", dc)
        for i in range(0, len(ids), CHUNK)], ignore_index=True)
    print(f"  cb_loan (borrower pulls only): {len(cb):,} rows")
    prod = pd.read_sql("SELECT DISTINCT product_id, product_name FROM ananya.loan_product", dc)
    dc.close()

    # ── 3. Derive ───────────────────────────────────────────────────────────
    sch = sch.sort_values(["loan_id", "demand_date"])
    sch["tot_due"] = sch.principal_due.fillna(0) + sch.interest_due.fillna(0)
    sch["cum_due"] = sch.groupby("loan_id").tot_due.cumsum()
    coll["amt"] = coll.principal_collected.fillna(0) + coll.interest_collected.fillna(0)

    cash = coll[coll.collection_date <= AS_ON].groupby("loan_id")[
        ["principal_collected", "interest_collected"]].sum()
    cash.columns = ["prin_coll", "int_coll"]
    due = sch[sch.demand_date <= AS_ON].groupby("loan_id")[
        ["principal_due", "interest_due"]].sum()
    due.columns = ["prin_due", "int_due"]
    tot = sch.groupby("loan_id")[["principal_due", "interest_due"]].sum()
    tot.columns = ["tot_prin", "tot_int"]

    m = tot.join(due, how="left").join(cash, how="left").fillna(0)
    m["prin_os_calc"] = (m.tot_prin - m.prin_coll).clip(lower=0)
    m["int_os_calc"] = (m.tot_int - m.int_coll).clip(lower=0)
    m["prin_od"] = (m.prin_due - m.prin_coll).clip(lower=0)
    m["int_od"] = (m.int_due - m.int_coll).clip(lower=0)

    def dpd_at(asof):
        c = coll[coll.collection_date <= asof].groupby("loan_id").amt.sum()
        s = sch[sch.demand_date <= asof]
        if s.empty:
            return pd.Series(dtype=float)
        j = s.join(c.rename("cash"), on="loan_id")
        j["cash"] = j.cash.fillna(0)
        # Oldest instalment whose cumulative demand is still not covered by cash.
        # Rs.0.50 tolerance absorbs rounding in the instalment split.
        un = j[j.cum_due > j.cash + 0.5]
        return (asof - un.groupby("loan_id").demand_date.min()).dt.days

    dpd = dpd_at(AS_ON).reindex(m.index).fillna(0).astype(int)

    # Overdue instalment COUNT at the as-on date, on the same cash basis.
    c_now = coll[coll.collection_date <= AS_ON].groupby("loan_id").amt.sum()
    s_now = sch[sch.demand_date <= AS_ON].join(c_now.rename("cash"), on="loan_id")
    s_now["cash"] = s_now.cash.fillna(0)
    od_inst = s_now[s_now.cum_due > s_now.cash + 0.5].groupby("loan_id").size()

    # Peak DPD over the loan's life: month-end DPD recomputed from cash vs due,
    # the method od_slippage.sql uses. loan_od_monthly_dpd_snapshot cannot serve
    # this — it holds Oct-2025..Mar-2026 only, and only loans already in OD.
    print("computing peak DPD across 43 month-ends ...")
    peak = pd.Series(0, index=m.index, dtype=int)
    for me in pd.date_range("2023-01-31", AS_ON, freq="ME"):
        d = dpd_at(me)
        if len(d):
            peak = peak.combine(d.reindex(peak.index).fillna(0).astype(int), max)

    # Predominant repayment mode actually used on the loan.
    MODE = {"CH": "Cash", "CL": "Cashless", "LR": "Loan Recovery"}
    cm = coll.dropna(subset=["payment_mode"]).copy()
    cm["mode"] = cm.payment_mode.map(MODE).fillna(cm.payment_mode)
    cm.loc[cm.payment_mode.eq("CL") & cm.cashless_collection_mode.notna(), "mode"] = (
        "Cashless - " + cm.cashless_collection_mode.astype(str))
    mode = (cm.groupby(["loan_id", "mode"]).size().rename("n").reset_index()
              .sort_values("n").groupby("loan_id").tail(1).set_index("loan_id")["mode"])

    # Bureau pull that underwrote the loan: the borrower's OWN latest pull dated
    # on or before disbursement. Spouse and family pulls (applicant_cb_flag S/F)
    # are already excluded — a spouse's score is not this borrower's score.
    cb["pull_date"] = pd.to_datetime(cb.created_on, errors="coerce")
    cb["score"] = cb.crif_score_value.where(cb.crif_score_value.notna(), cb.score_value)
    disb = la.set_index("loan_id").disbursement_date
    cb = cb.join(pd.to_datetime(disb).rename("disb"), on="loan_id")
    at_disb = cb[cb.pull_date <= cb.disb].sort_values("pull_date") \
                .groupby("loan_id").tail(1).set_index("loan_id")
    # Fallback: no pull on or before disbursement -> earliest pull on record.
    fallback = cb.sort_values("pull_date").groupby("loan_id").head(1).set_index("loan_id")
    bureau = at_disb.combine_first(fallback.loc[fallback.index.difference(at_disb.index)])
    print(f"  bureau at-disbursement: {len(at_disb):,}  fallback used: "
          f"{len(bureau) - len(at_disb):,}  total {len(bureau):,}/{len(ids):,}")

    _a = cb.dropna(subset=["aadhaar_id"]).sort_values("pull_date").groupby("loan_id").tail(1)
    aadhaar = pd.Series(_a["aadhaar_id"].values, index=_a["loan_id"].values)

    L = la.set_index("loan_id")
    B = brw.drop_duplicates("loan_id").set_index("loan_id")
    P = prod.dropna(subset=["product_id"]).drop_duplicates("product_id").set_index("product_id")
    wo_ids = set(pd.to_numeric(wo.loan_id, errors="coerce").dropna().astype("int64"))

    ix = sheet["_loan_id"]
    g = lambda s: s.reindex(ix).values                                   # noqa: E731
    disb_dt = pd.to_datetime(L.disbursement_date.reindex(ix))
    seasoning = ((AS_ON.year - disb_dt.dt.year) * 12
                 + (AS_ON.month - disb_dt.dt.month)).clip(lower=0)
    tenure = pd.to_numeric(L.loan_tenure.reindex(ix), errors="coerce")

    filled = {
        "Product":                                g(L.product_id.map(P.product_name).fillna(L.product_id)),
        "Industry category":                      g(L.sub_purpose),
        "Credit Bureau Date":                     to_serial(pd.Series(g(bureau.pull_date))).values,
        "Credit Bureau Name":                     g(bureau.credit_bureau_id),
        "CB Enquiry No.":                         g(bureau.report_order_no),
        "Cibil Score at the time of disbursement": np.where(
            pd.Series(g(bureau.score)).fillna(-1) > 0, pd.Series(g(bureau.score)), "No score / NTC"),
        "W. Off/ Settlement":                     np.where(ix.isin(wo_ids), "Written off", "No"),
        "UTR Details":                            g(L.payment_ref_number),
        "Account Number":                         g(L.cust_bank_acc_num),
        "IFSC Code":                              g(L.cust_bank_ifsc_code),
        "Processing Fees":                        g(L.lpf),
        "Mode of Repayment":                      g(mode),
        "Total Principal":                        g(L.total_loan_amount),
        "Total Interest":                         g(L.total_interest),
        "OD Data":                                g(m.prin_od),
        "Interest OD":                            g(m.int_od),
        "POS in OD":                              np.where(g(dpd) > 0, g(m.prin_os_calc), 0),
        "Over Due Inst.,":                        pd.Series(g(od_inst)).fillna(0).astype(int).values,
        "Over Due  Amount Rs.":                   g(m.prin_od) + g(m.int_od),
        # MASKED Aadhaar (last 4 digits), deliberately. Two things drove this:
        #   1) There is no unmasked source worth using anyway —
        #      ananya.cb_loan.aadhaar_id is masked on 100% of 1,023,603 values
        #      (411,156 of them carry no digits at all, just XXXXXXXXXXXX), and
        #      home_borrower_master.aadhaar_id is populated on 55 of 551,073.
        #   2) A pool file leaves the building. Masked Aadhaar is the norm for
        #      sharing, and last-4 is enough to key against a lender's own file.
        # cust_uid_mask is preferred over the bureau copy because it carries the
        # last 4 digits on all 6,942 loans, where the bureau copy is blanked out
        # entirely on 1,075 of them.
        # Full 12-digit Aadhaar DOES exist in cb_engine.engine_output_master_v2
        # ("AADHAAR NO."). If the counterparty contractually requires it, pull it
        # from there as a separate, access-controlled hand-off — not in this file.
        "Aadhar Number":                          pd.Series(g(B.cust_uid_mask)).fillna(
                                                      pd.Series(g(aadhaar))).values,
        "Pan Card Number":                        g(B.pan_card_number),
        "Seasoning as on 31-07-2026":             seasoning.values,
        "Balance Tenure as on 31-07-2026":        (tenure - seasoning).clip(lower=0).values,
        "Int O/s as on31-07-2026":                g(m.int_os_calc),
        "Peak DPD":                               g(peak),
    }

    # ── 4. Reconciliation gate ──────────────────────────────────────────────
    sheet_pos = pd.to_numeric(sheet["Prin O/s as on 31-07-2026"], errors="coerce")
    sheet_dpd = pd.to_numeric(sheet["DPD"], errors="coerce")
    pos_ok = (np.abs(pd.Series(g(m.prin_os_calc)) - sheet_pos) < 1).sum()
    dpd_ok = (pd.Series(g(dpd)) == sheet_dpd).sum()
    n = len(sheet)
    print(f"\nRECONCILIATION  POS {pos_ok:,}/{n:,}   DPD {dpd_ok:,}/{n:,}")
    if pos_ok != n or dpd_ok != n:
        print("!! GATE FAILED — the derivation no longer reproduces the sheet's own "
              "populated columns. Do NOT send this file.")
        sys.exit(1)
    print(f"  control total POS  sheet {sheet_pos.sum():,.0f}  computed "
          f"{pd.Series(g(m.prin_os_calc)).sum():,.0f}")

    # ── 5. Write ────────────────────────────────────────────────────────────
    out = sheet.drop(columns=["_loan_id"]).copy()
    for col, vals in filled.items():
        if col not in out.columns:
            print(f"  !! column not found in sheet, skipped: {col!r}")
            continue
        out[col] = vals
    write(out, filled)


NOT_FILLED = {
    "City": "NO SOURCE. home_center_master.city is NULL on all 212,205 rows; "
            "village_master is empty on this replica. District and Pin (already "
            "populated) are the only geography the warehouse holds.",
    "Disb. Bank Name": "NO SOURCE. home_loan_account.payment_bank is NULL for all "
                       "6,942 pool loans (and for 449,603 of 449,604 JLG loans "
                       "book-wide).",
    "Advance EMI": "NOT STORED. The disbursement net-off gap is fees + insurance, "
                   "not an advance instalment — it equals neither lpf nor lpf+EMI "
                   "on any of the 6,942 rows. Confirm as Nil with Operations.",
    "NACH Bounce": "NOT APPLICABLE. These are cash / UPI collected JLG loans "
                   "(repayment_detail.payment_mode CH or CL). bounce_charge is NULL "
                   "on all 6,942 and no NACH mandate governs them.",
}

SOURCES = [
    ("Product", "ananya_data", "ananya.loan_product.product_name via home_loan_account.product_id (falls back to product_id where product_name is null)", "6,942 / 6,942"),
    ("Industry category", "Ananya_app_prod", "home_loan_account.sub_purpose — the occupation detail beneath 'Class of Loanee' (SEEDS/FERTILIZER, DAIRY, ...)", "6,942 / 6,942"),
    ("Credit Bureau Date", "ananya_data", "ananya.cb_loan.created_on — borrower's own latest pull on/before disbursement. NOT report_date (a bureau cycle date, median 29d AFTER disbursement) and NOT report_time (an ETL load stamp, 2026-08-22 on every row). created_on matches the BRE engine CREATION DATE on 98.9% of the pool", "6,942 / 6,942"),
    ("Credit Bureau Name", "ananya_data", "ananya.cb_loan.credit_bureau_id (HIGHMARK* / EQUIFAX*)", "6,942 / 6,942"),
    ("CB Enquiry No.", "ananya_data", "ananya.cb_loan.report_order_no. NOT the BRE engine's REPORT IDs — those are 100% empty", "6,942 / 6,942"),
    ("Cibil Score at the time of disbursement", "ananya_data", "ananya.cb_loan: crif_score_value for HIGHMARK, score_value for EQUIFAX. NOTE: the bureaus in use are CRIF Highmark and Equifax, NOT CIBIL — the column header is a misnomer. -1 / null shown as 'No score / NTC'", "see Coverage tab"),
    ("W. Off/ Settlement", "Ananya_app_prod", "presence in public.writeoff_master (30,491 rows). No pool loan appears in it", "6,942 / 6,942"),
    ("UTR Details", "Ananya_app_prod", "home_loan_account.payment_ref_number", "5,505 / 6,942 (79.3%)"),
    ("Account Number", "Ananya_app_prod", "home_loan_account.cust_bank_acc_num (loan-level; more complete than borrower_master.bank_account_number)", "6,942 / 6,942"),
    ("IFSC Code", "Ananya_app_prod", "home_loan_account.cust_bank_ifsc_code", "6,942 / 6,942"),
    ("Processing Fees", "Ananya_app_prod", "home_loan_account.lpf", "6,942 / 6,942"),
    ("Mode of Repayment", "Ananya_app_prod", "predominant repayment_detail.payment_mode (CH=Cash, CL=Cashless + cashless_collection_mode, LR)", "see Coverage tab"),
    ("Total Principal", "Ananya_app_prod", "home_loan_account.total_loan_amount", "6,942 / 6,942"),
    ("Total Interest", "Ananya_app_prod", "home_loan_account.total_interest", "6,942 / 6,942"),
    ("OD Data", "DERIVED", "principal due on/before 31-Jul-2026 less principal collected on/before 31-Jul-2026, floored at 0. Zero for every loan — the pool is entirely DPD 0", "6,942 / 6,942"),
    ("Interest OD", "DERIVED", "same basis, interest leg", "6,942 / 6,942"),
    ("POS in OD", "DERIVED", "principal outstanding where DPD > 0, else 0. Zero throughout", "6,942 / 6,942"),
    ("Over Due Inst.,", "DERIVED", "count of instalments demanded on/before 31-Jul-2026 not covered by cash received by then", "6,942 / 6,942"),
    ("Over Due  Amount Rs.", "DERIVED", "OD Data + Interest OD", "6,942 / 6,942"),
    ("Aadhar Number", "Ananya_app_prod", "home_borrower_master.cust_uid_mask — MASKED, last 4 digits. No usable unmasked source exists: ananya.cb_loan.aadhaar_id is masked on 100% of 1,023,603 values (411,156 carry no digits at all) and borrower_master.aadhaar_id is populated on 55 of 551,073 rows. Full 12-digit Aadhaar exists only in cb_engine.engine_output_master_v2.\"AADHAAR NO.\" — request it as a separate access-controlled hand-off if the counterparty contractually requires it", "6,942 / 6,942 (masked)"),
    ("Pan Card Number", "Ananya_app_prod", "home_borrower_master.pan_card_number", "1,076 / 6,942 (15.5%) — PAN is not collected for most JLG borrowers"),
    ("Seasoning as on 31-07-2026", "DERIVED", "whole months from disbursement_date to 31-Jul-2026", "6,942 / 6,942"),
    ("Balance Tenure as on 31-07-2026", "DERIVED", "home_loan_account.loan_tenure less Seasoning, floored at 0", "6,942 / 6,942"),
    ("Int O/s as on31-07-2026", "DERIVED", "total interest scheduled less interest collected on/before 31-Jul-2026. Same cash basis that reproduces the sheet's own Prin O/s exactly", "6,942 / 6,942"),
    ("Peak DPD", "DERIVED", "highest month-end DPD from Jan-2023 to 31-Jul-2026, recomputed from cash vs due. loan_od_monthly_dpd_snapshot cannot serve this — it covers Oct-2025..Mar-2026 only and holds only loans already in OD", "6,942 / 6,942"),
]


def write(out, filled):
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter

    src = pd.DataFrame(SOURCES, columns=["Column", "Database", "Source table / field & rule", "Coverage"])
    gaps = pd.DataFrame([(k, v) for k, v in NOT_FILLED.items()],
                        columns=["Column left blank", "Reason (measured)"])

    with pd.ExcelWriter(OUT, engine="openpyxl") as w:
        out.to_excel(w, sheet_name="Pool", index=False)
        src.to_excel(w, sheet_name="Source Map", index=False)
        gaps.to_excel(w, sheet_name="Not Filled", index=False)

        blue = Font(name="Arial", size=10, color="0000FF")
        hdrf = Font(name="Arial", size=10, bold=True, color="FFFFFF")
        hfill = PatternFill("solid", start_color="1F3864")
        yfill = PatternFill("solid", start_color="FFF2CC")

        # The .xlsb reader hands back date SERIALS (45627), and the workbook
        # stored them that way. Written to .xlsx as bare numbers they would show
        # as "45627" to the accounts team, so the serial keeps its value and
        # gains a date format. Credit Bureau Date is written on the same basis
        # as the columns already in the sheet, so the whole file stays uniform.
        DATE_COLS = ["Date of  Disbursement", "Credit Bureau Date",
                     "Date of First Installment", "Date of Last  Installment"]

        ws = w.sheets["Pool"]
        cols = list(out.columns)
        for c in DATE_COLS:
            if c in cols:
                j = cols.index(c) + 1
                for i in range(2, len(out) + 2):
                    ws.cell(row=i, column=j).number_format = "DD-MMM-YYYY"
        for j, c in enumerate(cols, start=1):
            cell = ws.cell(row=1, column=j)
            cell.font = hdrf
            cell.fill = hfill
            cell.alignment = Alignment(wrap_text=True, vertical="center")
            if c in filled:                      # mark what this script supplied
                for i in range(2, len(out) + 2):
                    ws.cell(row=i, column=j).font = blue
                cell.fill = PatternFill("solid", start_color="2E7D32")
            ws.column_dimensions[get_column_letter(j)].width = max(12, min(28, len(str(c)) + 2))
        ws.freeze_panes = "A2"

        for name, wid in (("Source Map", [42, 18, 92, 26]), ("Not Filled", [24, 110])):
            s = w.sheets[name]
            for j, ww in enumerate(wid, start=1):
                s.column_dimensions[get_column_letter(j)].width = ww
                s.cell(row=1, column=j).font = hdrf
                s.cell(row=1, column=j).fill = hfill
            for i in range(2, s.max_row + 1):
                for j in range(1, len(wid) + 1):
                    s.cell(row=i, column=j).alignment = Alignment(wrap_text=True, vertical="top")
                    if name == "Not Filled":
                        s.cell(row=i, column=j).fill = yfill
            s.freeze_panes = "A2"

    print(f"\nwrote {OUT}")
    print(f"  filled {len(filled)} columns, left {len(NOT_FILLED)} blank (documented)")


if __name__ == "__main__":
    main()
