"""
gen_origination_funnel.py — build rpt_origination_funnel + rpt_origination_meetings.

WHAT THIS ANSWERS THAT rpt_case_movement CANNOT
    Case Movement is branch-grain and month-to-date, which makes two questions
    unanswerable:

    1. WHERE IS EVERYTHING NOW. An MTD sanctioned/rejected pair says nothing
       about the applications that are still moving. On 2026-08-26 the August
       cohort was 88.7% decided with 1,572 live — 854 of them sitting at stage
       'B' and 449 at CGT. That queue IS the bottleneck, and it was invisible.

    2. WHOSE MONTH IS IT. "Punched this month" and "decided this month" are
       different populations. Of everything decided in August, 1,202 of 13,628
       (8.8%) came from applications punched in JULY — 146 sanctions, 1,056
       rejections. An MTD rate divides one population by the other. Here every
       application carries its punch cohort, so a cohort can be followed to
       completion and the carry-over is a measurement, not a caveat.

STAGE ATTRIBUTION
    loan_application.rejection_status holds the stage a rejection was produced
    at — the single most useful column in the source. Observed on JLG
    applications since 1 Jun 2026 (33,411 rejections):

        stage  share   median days to reject   dominant reason
          B    57.5%          0.0              BRJ  (11,699)
          C1   23.7%          1.0              MN
          R     9.2%         18.0              EX
          G1    3.4%          3.0              MN
          D     2.7%          0.0              BRJ
          S     1.6%          4.0              MN
          HV    0.9%          0.0              CRE_REJECT

    VERIFIED code meanings, from home_meeting_sch.meeting_purpose which uses the
    same vocabulary: C1 = CGT-1, G1 = GRT-1, HV = House Visit. A = approved and
    X = rejected are self-evident from the data. 'S' rows all carry a
    sanctioned_date, so it is the sanction stage.

    'B', 'D', 'R' and 'P1' are NOT named here. Their behaviour is recorded above
    so the business can name them, but this file does not guess: a stage label is
    read by an operations team as a statement about their own process.

CLIENT CATEGORY
    From cb_engine.engine_output_master_v2, joined REFERENCE = application_number
    (verified: 1,936 of 2,000 August references matched loan_application, and 0
    matched loan_application_il — IL is absent from cb_engine, as already
    documented for the BRE report). Coverage on JLG applications since 1 Jun:
    47,860 of 48,443 = 98.8%.

        cb 'New Fresh' -> New to Credit      no bureau record at all: MFI lenders,
                                             outstanding and Ananya loans are ALL
                                             null on every one of the 14,466 pulls
        cb 'New'       -> New to Company     2.10 outside MFI lenders, Rs 1.77 L
                                             outstanding, 0.05 Ananya loans
        cb 'Repeat'    -> Existing Borrower  2.21 Ananya loans
        cb 'Employee'  -> Employee

    This replaces the cust_type NC/EC split, which is circular — see the note in
    the DDL and in CaseMovement.tsx.

CROSS-DATABASE
    Like gen/run_credit_bureau, this reads TWO databases: the core replica and
    cb_engine. Postgres cannot join across them, so the bureau category is merged
    in pandas on application_number.
"""

from __future__ import annotations

import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import sqlalchemy as sa

sys.path.insert(0, str(Path(__file__).parent))
from db import run_query, get_cb_engine                          # noqa: E402
from report_store import pg_write_report_day                     # noqa: E402

FUNNEL_TABLE = "rpt_origination_funnel"
MEETING_TABLE = "rpt_origination_meetings"

# 13 months keeps a full year of cohorts plus the running one, so a cohort can be
# compared against the same month last year without holding the whole history.
MONTHS_BACK = 13

# Verified from home_meeting_sch.meeting_purpose, which shares the vocabulary.
# Deliberately partial — see the module docstring.
STAGE_LABEL = {
    "C1": "CGT",
    "G1": "GRT",
    "HV": "House Visit",
    "S": "Sanction",
    "A": "Approved",
    "X": "Rejected",
}
MEETING_LABEL = {"C1": "CGT", "G1": "GRT", "HV": "House Visit"}

CATEGORY = {
    "New Fresh": "New to Credit",
    "New": "New to Company",
    "Repeat": "Existing Borrower",
    "Employee": "Employee",
}

CREDIT_DECISION = {"A": "Approved", "R": "Rejected", "C": "Conditional"}


def _from_date() -> date:
    d = date.today().replace(day=1)
    y, m = d.year, d.month - MONTHS_BACK
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


def load_applications(frm: date) -> pd.DataFrame:
    """JLG + IL applications, with every stage marker each side carries."""
    jlg = run_query(f"""
        SELECT a.application_number::text          AS application_number,
               'JLG'                               AS loan_source,
               a.application_date::date            AS application_date,
               a.status                            AS status,
               a.rejection_status                  AS reject_stage,
               nullif(trim(a.rejection_reason::text),'') AS reject_reason,
               nullif(trim(a.rejection_type::text),'')   AS reject_type,
               a.rejection_date::date              AS rejection_date,
               a.sanctioned_date::date             AS sanctioned_date,
               a.approval_date::date               AS approval_date,
               a.hv_date::date                     AS hv_date,
               a.credit_submit_date::date          AS credit_submit_date,
               a.credit_status                     AS credit_status,
               a.applied_amount                    AS applied_amount,
               a.sanctioned_amount                 AS sanctioned_amount,
               cm.branch_id                        AS branch_id,
               -- The officer is on the CENTRE, not the application (same source
               -- gen_vintage uses). loan_application has ca_assigned_to, but that
               -- is the credit analyst, not the field officer.
               cm.assigned_to::varchar             AS lo_id,
               a.product_id::text                  AS product_id,
               CASE WHEN upper(a.product_id::text) LIKE '%TOPUP%'
                    THEN 1 ELSE 0 END              AS is_topup,
               coalesce(pc.product_classification, 'Other') AS prod_classification
        FROM public.loan_application a
        JOIN public.home_center_master cm ON cm.center_id = a.center_id
        LEFT JOIN public.loan_product     lp ON lp.product_id  = a.product_id
        LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
        WHERE a.application_date::date >= DATE '{frm}'""")

    # IL uses a different column for the sanction date and has no rejection_status;
    # its own status codes ARE the stage names (EN/BK/TV/HV/CC/SN/DS), so the last
    # stage reached is recovered from which date columns are populated.
    il = run_query(f"""
        SELECT a.application_number::text          AS application_number,
               'IL'                                AS loan_source,
               a.application_date::date            AS application_date,
               a.status                            AS status,
               NULL::text                          AS reject_stage,
               nullif(trim(a.rejection_reason::text),'') AS reject_reason,
               NULL::text                          AS reject_type,
               a.rejection_date::date              AS rejection_date,
               a.sanction_date::date               AS sanctioned_date,
               a.approval_date::date               AS approval_date,
               a.hv_date::date                     AS hv_date,
               a.credit_check_date::date           AS credit_submit_date,
               a.credit_status                     AS credit_status,
               a.applied_amount                    AS applied_amount,
               a.sanctioned_amount                 AS sanctioned_amount,
               a.branch_id                         AS branch_id,
               a.loan_officer::varchar             AS lo_id,
               a.product_id::text                  AS product_id,
               CASE WHEN upper(a.product_id::text) LIKE '%TOPUP%'
                    THEN 1 ELSE 0 END              AS is_topup,
               coalesce(pc.product_classification, 'Other') AS prod_classification
        FROM public.loan_application_il a
        LEFT JOIN public.loan_product_il  lp ON lp.product_id  = a.product_id
        LEFT JOIN public.product_category pc ON pc.category_id = lp.prod_category_id
        WHERE a.application_date::date >= DATE '{frm}'""")
    return pd.concat([jlg, il], ignore_index=True)


def load_bureau(frm: date) -> pd.DataFrame:
    """Client category per application from cb_engine.

    One application can have several pulls; the FIRST decides the category, since
    a later re-pull happens after the funnel has already acted on the first.
    """
    with get_cb_engine().connect() as c:
        cb = pd.read_sql(sa.text(f"""
            SELECT "REFERENCE"::text          AS application_number,
                   "CLIENT CATEGORY"          AS cb_category,
                   "FINAL RECOMMENDATION"     AS bureau_decision,
                   "CREATION DATE"            AS pulled_on
            FROM engine_output_master_v2
            WHERE "CREATION DATE" >= '{frm}'
              AND "REFERENCE" IS NOT NULL"""), c)
    if cb.empty:
        return cb
    cb["pulled_on"] = pd.to_datetime(cb["pulled_on"], errors="coerce")
    cb = (cb.sort_values("pulled_on")
            .drop_duplicates("application_number", keep="first")
            .drop(columns=["pulled_on"]))
    return cb


def load_meetings(frm: date) -> pd.DataFrame:
    """Branch x month x purpose meeting counts — the operational queue."""
    return run_query(f"""
        SELECT date_trunc('month', ms.meeting_date)::date AS meeting_month,
               ms.meeting_purpose                         AS purpose,
               cm.branch_id                               AS branch_id,
               count(*) FILTER (WHERE ms.meeting_status = 'C') AS completed,
               count(*) FILTER (WHERE ms.meeting_status = 'S') AS pending,
               count(*) FILTER (WHERE ms.meeting_status = 'X') AS cancelled
        FROM public.home_meeting_sch ms
        JOIN public.home_center_master cm ON cm.center_id = ms.center_id
        WHERE ms.meeting_date >= DATE '{frm}'
          AND ms.meeting_purpose IN ('C1','G1','HV')
        GROUP BY 1, 2, 3""")


def load_hierarchy() -> pd.DataFrame:
    return run_query("""
        SELECT bm.branch_id, bm.branch_name, a.area_name,
               reg.branch_name AS region_name, clus.area_name AS cluster_name,
               z.area_name AS zone_name, bm.state_id, bm.district_id
        FROM public.brnch_master bm
        LEFT JOIN public.area_master  a    ON bm.area_id   = a.area_id
        LEFT JOIN public.brnch_master reg  ON bm.region_id = reg.branch_id
        LEFT JOIN public.area_master  clus ON reg.area_id  = clus.area_id
        LEFT JOIN public.area_master  z    ON clus.zone_id = z.area_id""")


def load_disbursed(frm: date) -> pd.DataFrame:
    """Applications that became a loan. application_number = loan_id on both
    sides, which is how the write-off and vintage builds already link them."""
    parts = []
    for tbl in ("home_loan_account", "loan_account_il"):
        parts.append(run_query(f"""
            SELECT loan_id::text AS application_number,
                   1 AS disbursed,
                   coalesce(total_loan_amount, 0) AS disbursed_amount
            FROM public.{tbl}
            WHERE disbursement_date IS NOT NULL
              AND disbursement_date::date >= DATE '{frm}'"""))
    return pd.concat(parts, ignore_index=True).drop_duplicates("application_number")


def main() -> None:
    t0 = time.time()
    as_of = date.today() - pd.Timedelta(days=1).to_pytimedelta()
    frm = _from_date()
    print(f"origination funnel  cohorts from {frm}  data date {as_of}")

    print("reading applications ...", flush=True)
    df = load_applications(frm)
    print(f"  applications: {len(df):,}")

    print("reading bureau categories (cb_engine) ...", flush=True)
    cb = load_bureau(frm)
    print(f"  bureau pulls: {len(cb):,}")

    print("reading meetings + hierarchy + disbursals ...", flush=True)
    meet = load_meetings(frm)
    hier = load_hierarchy()
    disb = load_disbursed(frm)

    # ── Applications ────────────────────────────────────────────────────────
    df["application_date"] = pd.to_datetime(df.application_date)
    df["cohort_month"] = df.application_date.values.astype("datetime64[M]")
    for c in ("rejection_date", "sanctioned_date", "approval_date",
              "hv_date", "credit_submit_date"):
        df[c] = pd.to_datetime(df[c], errors="coerce")

    if not cb.empty:
        df = df.merge(cb, on="application_number", how="left")
    else:
        df["cb_category"] = None
        df["bureau_decision"] = None
    # A JLG application with no pull is genuinely unscreened; IL is absent from
    # cb_engine entirely, so it is labelled for what it is rather than being
    # lumped in with JLG applications that skipped the bureau.
    df["client_category"] = np.where(
        df.cb_category.notna(), df.cb_category.map(CATEGORY),
        np.where(df.loan_source.eq("IL"), "Not screened (IL)", "Not screened"))

    df = df.merge(disb, on="application_number", how="left")
    df["disbursed"] = df.disbursed.fillna(0).astype("int16")
    df["disbursed_amount"] = pd.to_numeric(df.disbursed_amount, errors="coerce").fillna(0)

    # Outcome. JLG marks rejection with 'X' and approval with 'A'; IL uses 'XR'
    # and 'DS'. Falling back to the dates keeps both honest if a code changes:
    # a row carrying a rejection_date IS rejected whatever its status says.
    rejected = df.status.isin(["X", "XR"]) | df.rejection_date.notna()
    approved = (~rejected) & (df.status.isin(["A", "DS"]) | df.sanctioned_date.notna())
    df["outcome"] = np.select([rejected, approved], ["Rejected", "Approved"],
                              default="In Process")

    df["current_stage"] = np.where(df.outcome.eq("In Process"), df.status, None)
    df["days_to_decision"] = np.where(
        rejected, (df.rejection_date - df.application_date).dt.days,
        np.where(approved, (df.sanctioned_date - df.application_date).dt.days, np.nan))

    # Summable 0/1 companions to `outcome`. A report aggregates by SUMMING, so a
    # text column cannot be counted at read time without a per-value pivot; these
    # let every rate be recomputed from summed numerator and denominator at any
    # grouping, which is what stops a region's rate being an average of its
    # branches' rates.
    df["applications"] = 1
    df["is_approved"] = approved.astype("int16")
    df["is_rejected"] = rejected.astype("int16")
    df["is_inprocess"] = df.outcome.eq("In Process").astype("int16")
    # DECIDED, not applications, is the honest denominator for a sanction rate: a
    # cohort still in flight would otherwise read low simply for being young.
    df["decided"] = df.is_approved + df.is_rejected
    df["decision_days"] = pd.to_numeric(df.days_to_decision, errors="coerce").fillna(0)

    df["hv_done"] = df.hv_date.notna().astype("int16")
    df["credit_submitted"] = df.credit_submit_date.notna().astype("int16")
    df["credit_decision"] = (df.credit_status.astype(str).str.strip()
                               .map(CREDIT_DECISION).fillna("Pending"))
    df["sanctioned"] = df.sanctioned_date.notna().astype("int16")
    df["approved"] = df.approval_date.notna().astype("int16")

    df = df.merge(hier, on="branch_id", how="left")
    dup = int(df.duplicated(subset=["application_number", "loan_source"]).sum())
    if dup:
        print(f"  !! {dup} duplicate (application_number, loan_source) rows — a join fanned out")

    cols = ["application_number", "loan_source", "cohort_month", "application_date",
            "outcome", "current_stage", "reject_stage", "reject_reason", "reject_type",
            "days_to_decision", "client_category", "bureau_decision",
            "applications", "is_approved", "is_rejected", "is_inprocess",
            "decided", "decision_days",
            "hv_done", "credit_submitted", "credit_decision", "sanctioned",
            "approved", "disbursed", "applied_amount", "sanctioned_amount",
            "disbursed_amount", "zone_name", "cluster_name", "region_name",
            "area_name", "branch_name", "branch_id", "state_id", "district_id",
            "lo_id", "product_id", "prod_classification", "is_topup", "report_day"]
    for c in cols:
        if c not in df.columns:
            df[c] = None
    out = df[[c for c in cols if c != "report_day"]].copy()
    out["cohort_month"] = out.cohort_month.dt.date
    out["application_date"] = out.application_date.dt.date
    out["days_to_decision"] = pd.to_numeric(out.days_to_decision, errors="coerce").astype("Int64")
    for c in ("applied_amount", "sanctioned_amount", "disbursed_amount"):
        out[c] = pd.to_numeric(out[c], errors="coerce").fillna(0)

    rows, days = pg_write_report_day(out, FUNNEL_TABLE, as_of.isoformat())
    print(f"\n  {FUNNEL_TABLE}: {rows:,} rows @ {as_of}  ({days} day(s) stored)")

    # ── Meetings ────────────────────────────────────────────────────────────
    meet["purpose"] = meet.purpose.map(MEETING_LABEL).fillna(meet.purpose)
    meet = meet.merge(hier, on="branch_id", how="left")
    mcols = ["meeting_month", "purpose", "completed", "pending", "cancelled",
             "zone_name", "cluster_name", "region_name", "area_name",
             "branch_name", "branch_id"]
    for c in mcols:
        if c not in meet.columns:
            meet[c] = None
    mrows, _ = pg_write_report_day(meet[mcols], MEETING_TABLE, as_of.isoformat())
    print(f"  {MEETING_TABLE}: {mrows:,} rows @ {as_of}"
          f"   in {(time.time()-t0)/60:.1f} min")

    # ── Shape check ─────────────────────────────────────────────────────────
    mix = out.outcome.value_counts().to_dict()
    print(f"\n  outcome mix: {mix}")
    cov = (out.client_category.ne("Not screened")
           & out.client_category.ne("Not screened (IL)")).mean() * 100
    print(f"  bureau category coverage: {cov:.1f}%")
    live = out[out.outcome.eq("In Process")]
    if not live.empty:
        print(f"  live cases by stage: {live.current_stage.value_counts().head(6).to_dict()}")
    rej = out[out.outcome.eq("Rejected") & out.reject_stage.notna()]
    if not rej.empty:
        print(f"  rejections by stage: {rej.reject_stage.value_counts().head(6).to_dict()}")
    if out.outcome.eq("Approved").sum() == 0:
        print("  !! no approved applications — check the status codes, "
              "they differ between loan_application and loan_application_il")


if __name__ == "__main__":
    main()
