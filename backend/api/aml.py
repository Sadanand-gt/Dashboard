"""
aml.py — AML Risk Category (compliance monitoring).

Reads rpt_aml (active book, borrower AML risk + PEP / work-abroad / LUC flags)
through read_report() so the user's data scope applies automatically. Measures
are additive components, so High-risk %, PEP %, etc. can be computed under any
AP#1 × AP#2 grouping and any slicer combination.

Endpoints (all under /api/aml — gated to the "aml" report key):
  /api/aml/kpis          → headline monitoring totals (cards)
  /api/aml/group-summary → AP#1 × AP#2 matrix (also drives the concentration view)
  /api/aml/refresh       → data as-of (T-1)
"""

from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, Query

from auth.deps import get_current_user, require_export
from core.db import read_report

router = APIRouter()

# Dimensions offered as AP#1 / AP#2 and for the concentration view.
VALID_DIMS = {
    "business_segment", "loan_source",
    "risk_category", "pep_flag", "work_abroad_flag", "luc_flag",
    "zone_name", "cluster_name", "region_name", "area_name", "branch_name",
    "state_id", "district_id", "prod_classification",
    "zone_label", "cluster_label", "region_label", "area_label",
    "branch_label", "lo_name",
}

# Label dim → plain column fallback (table predates dba label columns / lo_name).
LABEL_FALLBACK = {
    "zone_label": "zone_name", "cluster_label": "cluster_name",
    "region_label": "region_name", "area_label": "area_name",
    "branch_label": "branch_name", "lo_name": "lo_id",
}

# Additive measure columns carried on rpt_aml.
MEASURES = ["loan_count", "total_pos", "high_count", "high_pos", "low_count",
            "pep_count", "abroad_count", "luc_pending_count",
            "risk_unknown_count", "pep_unknown_count"]


def _vals(raw: Optional[str]) -> list[str]:
    if not raw or raw == "ALL":
        return []
    return [v for v in (x.strip() for x in str(raw).split(",")) if v and v != "ALL"]


def _multi(df: pd.DataFrame, col: str, raw: Optional[str]) -> pd.DataFrame:
    vals = _vals(raw)
    if vals and col in df.columns:
        df = df[df[col].astype(str).isin(vals)]
    return df


def _multi_lo(df: pd.DataFrame, raw: Optional[str]) -> pd.DataFrame:
    vals = _vals(raw)
    if not vals or "lo_id" not in df.columns:
        return df
    ids = {v.split(" - ", 1)[0].strip() for v in vals}
    return df[df["lo_id"].astype(str).str.strip().isin(ids)]


def _dim(df: pd.DataFrame, col: str) -> str:
    return col if col in df.columns else LABEL_FALLBACK.get(col, col)


def _label(v) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _filtered(df: pd.DataFrame, f: dict) -> pd.DataFrame:
    """Apply segment + hierarchy + AML-specific slicers (scope already applied)."""
    df = _multi(df, "business_segment", f.get("segment"))
    df = _multi_lo(df, f.get("lo"))
    df = _multi(df, "zone_name", f.get("zone"))
    df = _multi(df, "cluster_name", f.get("cluster"))
    df = _multi(df, "region_name", f.get("region"))
    df = _multi(df, "area_name", f.get("area"))
    df = _multi(df, "branch_name", f.get("branch"))
    df = _multi(df, "prod_classification", f.get("prod_class"))
    df = _multi(df, "state_id", f.get("branch_state"))
    df = _multi(df, "district_id", f.get("district"))
    # AML-specific
    df = _multi(df, "risk_category", f.get("risk_category"))
    df = _multi(df, "pep_flag", f.get("pep"))
    df = _multi(df, "work_abroad_flag", f.get("work_abroad"))
    df = _multi(df, "luc_flag", f.get("luc"))
    df = _multi(df, "loan_id", f.get("loan_id"))
    return df


def _filters(
    segment: Optional[str] = Query(None), zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None), branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None), lo: Optional[str] = Query(None),
    risk_category: Optional[str] = Query(None), pep: Optional[str] = Query(None),
    work_abroad: Optional[str] = Query(None), luc: Optional[str] = Query(None),
    # Loan ID is a LOOKUP, not a grouping — one row per loan is unusable as
    # an AP dimension, so it filters instead. Comma-separated ids allowed.
    loan_id: Optional[str] = Query(None),
    portfolio: Optional[str] = Query(None),   # with | without (Excl W/O)
) -> dict:
    return {"segment": segment, "zone": zone, "cluster": cluster, "region": region,
            "area": area, "branch": branch, "prod_class": prod_class,
            "branch_state": branch_state, "district": district, "lo": lo,
            "risk_category": risk_category, "pep": pep,
            "work_abroad": work_abroad, "luc": luc, "portfolio": portfolio,
            "loan_id": loan_id}


def _prep(user: dict, f: dict) -> pd.DataFrame:
    """Loan-grain rows carrying the aggregate MEASURES as per-loan components.

    Reads rpt_aml_loans, NOT the aggregated rpt_aml (changed 2026-08-13).
    rpt_aml has no loan_status and no write-off concept, so the With / Excl W/O
    toggle returned identical numbers on both settings and the hierarchy filters
    only bit on the narrower set of dimensions that table carries. Reading the
    loan table makes the toggle and every filter work, and puts the cards, the
    matrix, the new-case counts and the CSV on ONE source.

    Each loan contributes 1 to its own counts, so the sums and group-bys
    downstream are unchanged — only the grain feeding them.
    """
    df = read_report(AML_TABLE)          # scope applied centrally
    if df.empty:
        return df

    # Active portfolio = Active + Death, matching Current Outstanding Excl W/O.
    # 'with' adds Write-off. 'Closed' is in neither, exactly as aum_status does.
    if "loan_status" in df.columns:
        df = df[df["loan_status"].isin(_aml_scope(f.get("portfolio") or "without"))]
    if df.empty:
        return df

    pos = pd.to_numeric(df.get("pos", 0), errors="coerce").fillna(0)
    risk, pepf = df.get("risk_category"), df.get("pep_flag")
    df = df.assign(
        loan_count=1,
        total_pos=pos,
        high_count=(risk == "High").astype(int),
        high_pos=pos.where(risk == "High", 0),
        low_count=(risk == "Low").astype(int),
        pep_count=(pepf == "PEP").astype(int),
        abroad_count=(df.get("work_abroad_flag") == "Works Abroad").astype(int),
        luc_pending_count=(df.get("luc_flag") == "LUC Pending").astype(int),
        risk_unknown_count=(risk == "Unclassified").astype(int),
        pep_unknown_count=(pepf == "Unknown").astype(int),
    )
    return _filtered(df, f)


@router.get("/aml/kpis")
def aml_kpis(f: dict = Depends(_filters), user: dict = Depends(get_current_user)):
    df = _prep(user, f)
    if df.empty:
        return {}
    s = {c: float(df[c].sum()) for c in MEASURES if c in df.columns}
    loans = s.get("loan_count", 0)
    high = s.get("high_count", 0)
    pep = s.get("pep_count", 0)
    return {
        "total_borrowers": int(loans),
        "total_pos": s.get("total_pos", 0.0),
        "high_count": int(high),
        "high_pct": round(high / loans * 100, 2) if loans else 0.0,
        "high_pos": s.get("high_pos", 0.0),
        "low_count": int(s.get("low_count", 0)),
        "pep_count": int(pep),
        "pep_pct": round(pep / loans * 100, 2) if loans else 0.0,
        "abroad_count": int(s.get("abroad_count", 0)),
        "luc_pending_count": int(s.get("luc_pending_count", 0)),
        "risk_unknown_count": int(s.get("risk_unknown_count", 0)),
        "pep_unknown_count": int(s.get("pep_unknown_count", 0)),
    }


def _row(r, g1: str, g2: Optional[str]) -> dict:
    loans = float(r["loan_count"])
    high = float(r["high_count"])
    pep = float(r["pep_count"])
    row = {
        "name": _label(r[g1]),
        "loans": int(loans),
        "pos": round(float(r["total_pos"]), 2),
        "high": int(high),
        "high_pct": round(high / loans * 100, 2) if loans else 0.0,
        "high_pos": round(float(r["high_pos"]), 2),
        "pep": int(pep),
        "pep_pct": round(pep / loans * 100, 2) if loans else 0.0,
        "abroad": int(float(r["abroad_count"])),
        "luc_pending": int(float(r["luc_pending_count"])),
    }
    if g2:
        row["name2"] = _label(r[g2])
    return row


@router.get("/aml/group-summary")
def aml_group_summary(
    group_by: str = Query("risk_category"),
    group_by_2: Optional[str] = Query(None),
    f: dict = Depends(_filters),
    user: dict = Depends(get_current_user),
):
    g1 = group_by if group_by in VALID_DIMS else "risk_category"
    g2 = group_by_2 if group_by_2 and group_by_2 in VALID_DIMS and group_by_2 != "none" else None

    df = _prep(user, f)
    if df.empty:
        return []

    g1 = _dim(df, g1)
    g2 = _dim(df, g2) if g2 else None
    if g1 not in df.columns:
        return []
    cols = [g1, g2] if g2 and g2 in df.columns else [g1]
    sums = [c for c in MEASURES if c in df.columns]
    grp = df.groupby(cols, as_index=False, dropna=False)[sums].sum().sort_values("high_count", ascending=False)

    rows = [_row(r, g1, g2 if g2 and g2 in df.columns else None) for _, r in grp.iterrows()]

    loans = float(df["loan_count"].sum())
    high = float(df["high_count"].sum())
    pep = float(df["pep_count"].sum())
    rows.append({
        "name": "Grand Total",
        "loans": int(loans), "pos": round(float(df["total_pos"].sum()), 2),
        "high": int(high), "high_pct": round(high / loans * 100, 2) if loans else 0.0,
        "high_pos": round(float(df["high_pos"].sum()), 2),
        "pep": int(pep), "pep_pct": round(pep / loans * 100, 2) if loans else 0.0,
        "abroad": int(float(df["abroad_count"].sum())),
        "luc_pending": int(float(df["luc_pending_count"].sum())),
    })
    return rows


@router.get("/aml/refresh")
def aml_refresh(user: dict = Depends(get_current_user)):
    df = read_report("rpt_aml")
    if df.empty or "as_of_date" not in df.columns:
        return {"refresh": "—"}
    ts = pd.to_datetime(df["as_of_date"]).max() - pd.Timedelta(days=1)
    try:
        label = ts.strftime("%-d %b %Y") if pd.notna(ts) else "—"
    except ValueError:
        label = ts.strftime("%d %b %Y") if pd.notna(ts) else "—"
    return {"refresh": label}


# =============================================================================
# LOAN GRAIN (rpt_aml_loans) — With/Excl write-off, new-case detection, CSV.
#
# rpt_aml is aggregated and cannot answer any of the three: it has no loan ids
# to diff between days, no write-off flag, and no rows to export.
# =============================================================================

AML_TABLE = "rpt_aml_loans"

# The five categories flagged as new. Each is (column, value-that-counts).
FLAG_RULES = [
    ("high_risk",    "risk_category",    "High"),
    ("pep",          "pep_flag",         "PEP"),
    ("works_abroad", "work_abroad_flag", "Works Abroad"),
    ("luc_pending",  "luc_flag",         "LUC Pending"),
    ("unclassified", "risk_category",    "Unclassified"),
]

# Both the normalised label AND the raw source value are shipped. The labels are
# what the page shows; the raw columns are what the core tables hold, so a
# reviewer can confirm an "Unclassified" row really is blank at source instead of
# re-querying the database to check. Raw NULL/'' is exactly why a row reads
# Unclassified / Unknown.
AML_EXPORT_COLS = [
    "loan_id", "loan_source", "business_segment", "loan_status",
    "risk_category", "aml_risk_raw",
    "pep_flag", "political_exposure_flag_raw",
    "work_abroad_flag", "work_abroad_flag_raw",
    "luc_flag", "luc_india_raw",
    # Question 4. No *_raw twin: nationality IS the raw declared value — there
    # is no normalised label to sit beside, only 'Unknown' where it is blank.
    "nationality",
    "zone_name", "cluster_name", "region_name", "area_name", "branch_name",
    "branch_id", "lo_id", "prod_classification", "state_id", "district_id", "pos",
]


def _aml_scope(portfolio: str):
    """Active portfolio = Active + Death, matching Current Outstanding Excl W/O.
    'with' adds Write-off. 'Closed' is in neither, exactly as aum_status does."""
    return (["Active", "Death", "Write-off"] if (portfolio or "without") == "with"
            else ["Active", "Death"])


def _aml_loans(f: dict, portfolio: str, day=None):
    df = read_report(AML_TABLE) if day is None else None
    if day is not None:
        from core.db import read_report_at_days
        df = read_report_at_days(AML_TABLE, [day])
    if df is None or df.empty:
        return df if df is not None else pd.DataFrame()
    if "loan_status" in df.columns:
        df = df[df["loan_status"].isin(_aml_scope(portfolio))]
    # _filtered is aml.py's own helper: it applies segment, the full hierarchy,
    # prod_class, LO and the risk / PEP / abroad / LUC selections. Calling
    # core.filters.segment_filter here was a NameError — aml.py never imported
    # it — so both loan-grain endpoints raised on every request.
    return _filtered(df, f)


@router.get("/aml/new-cases")
def aml_new_cases(
    portfolio: str = Query("without"),
    segment: Optional[str] = Query(None), zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    """Loans newly carrying each risk flag: present today, absent on the previous
    report_day. A GROSS count — netting arrivals against departures would report
    zero while ten new high-risk borrowers appeared, which is the opposite of
    what a compliance alert is for.

    Returns prior_day=None on the table's first day (nothing to compare against);
    the page states that rather than showing a misleading zero."""
    from core.db import report_days
    f = {"segment": segment, "zone": zone, "cluster": cluster,
         "region": region, "area": area, "branch": branch}
    days = report_days(AML_TABLE)
    today = _aml_loans(f, portfolio)
    out = {"prior_day": None, "counts": {k: 0 for k, _, _ in FLAG_RULES}, "loans": {}}
    if today.empty or len(days) < 2:
        return out
    prev = _aml_loans(f, portfolio, day=days[-2])
    if prev.empty:
        return out
    out["prior_day"] = str(days[-2])
    for key, col, val in FLAG_RULES:
        if col not in today.columns:
            continue
        now_ids = set(today.loc[today[col] == val, "loan_id"])
        was_ids = set(prev.loc[prev[col] == val, "loan_id"]) if col in prev.columns else set()
        new_ids = now_ids - was_ids
        out["counts"][key] = len(new_ids)
        out["loans"][key] = sorted(int(i) for i in list(new_ids)[:500])
    return out


@router.get("/aml/loans")
def aml_loans_export(
    portfolio: str = Query("without"),
    segment: Optional[str] = Query(None), zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    user: dict = Depends(require_export),
):
    """Loan-wise rows for the CSV, under the same filters and scope as the page."""
    f = {"segment": segment, "zone": zone, "cluster": cluster,
         "region": region, "area": area, "branch": branch}
    df = _aml_loans(f, portfolio)
    if df.empty:
        return {"rows": [], "columns": AML_EXPORT_COLS}
    cols = [c for c in AML_EXPORT_COLS if c in df.columns]
    return {"rows": df[cols].fillna("").to_dict("records"), "columns": cols}


# =============================================================================
# CLIENT RISK CATEGORIZATION — the four questions the source system asks
#
# The origination form's "Client Risk Categorization" panel asks exactly four
# things, and this endpoint answers all four off one pass so the page can put
# them side by side:
#
#     1. I am Politically Exposed                     political_exposure_flag
#     2. Client / Spouse working Abroad               work_abroad_flag
#     3. Loan amount will be utilised in India only   luc_india
#     4. Nationality                                  citizenship
#
# PENDING IS PART OF THE ANSWER, NOT A FOOTNOTE. A borrower with no answer
# recorded is not low risk — they are unassessed, and for a compliance report
# that is the finding. Every question therefore carries its own pending count
# and names the source field that is blank, rather than folding blanks into
# "No".
# =============================================================================

# (key, short card label, the question as the FORM words it, source column,
#  normalised column, the answer that is a RISK FLAG, tone for that answer)
#
# The card shows the short label; the form's own wording is the hover text. The
# full question is what makes the number unambiguous, but four long sentences
# across a card row costs more space than it earns.
RISK_QUESTIONS = [
    ("pep", "Politically Exposed", "I am Politically Exposed",
     "political_exposure_flag", "pep_flag", "PEP", "alert"),
    ("abroad", "Working Abroad", "Client / Spouse working Abroad",
     "work_abroad_flag", "work_abroad_flag", "Works Abroad", "alert"),
    ("luc", "India-only Utilisation", "Loan amount will be utilised in India only",
     "luc_india", "luc_flag", "LUC Pending", "warn"),
    ("nationality", "Nationality", "Nationality",
     "citizenship", "nationality", None, None),
]

# The grading the four answers feed into. Same card shape so it reads as part of
# the same row, but kept OUT of RISK_QUESTIONS: it is an outcome, not a question,
# and its blanks are a slightly different population (a borrower can carry an
# aml_risk grade with the questionnaire still unanswered, and vice versa).
RISK_GRADE = ("risk", "AML Risk Grade",
              "Borrower AML risk grading held in the core system — the outcome "
              "the four questions feed into. Unclassified means no grade has "
              "been assigned at all.",
              "aml_risk", "risk_category", "High", "alert")


@router.get("/aml/questions")
def aml_questions(f: dict = Depends(_filters), user: dict = Depends(get_current_user)):
    """One card's worth of answer per Client Risk Categorization question."""
    df = _prep(user, f)
    if df.empty:
        return {"questions": [], "total_loans": 0, "total_pos": 0.0,
                "unassessed": {"count": 0, "pos": 0.0, "fields": []}}

    total = int(len(df))
    tpos = float(pd.to_numeric(df.get("pos", 0), errors="coerce").fillna(0).sum())
    pos_s = pd.to_numeric(df.get("pos", 0), errors="coerce").fillna(0)

    out = []
    for key, label, question, src_col, col, flag_val, tone in [RISK_GRADE] + RISK_QUESTIONS:
        if col not in df.columns:
            # nationality before dba_add_aml_nationality.sql has run. Say so
            # rather than rendering an empty card that reads like "no risk".
            out.append({"key": key, "label": label, "question": question,
                        "source_field": src_col, "available": False,
                        "answers": [], "pending": None,
                        "flag_count": 0, "flag_pos": 0.0})
            continue
        vals = df[col].astype(str)
        answers = []
        pending = {"count": 0, "pos": 0.0}
        for v, idx in vals.groupby(vals).groups.items():
            cnt, p = int(len(idx)), float(pos_s.loc[idx].sum())
            if v in ("Unknown", "Unclassified", "nan", "None", ""):
                pending = {"count": pending["count"] + cnt, "pos": pending["pos"] + p}
                continue
            answers.append({"label": v, "count": cnt, "pos": round(p, 2),
                            "pct": round(cnt / total * 100, 2) if total else 0.0,
                            "flag": (flag_val is not None and v == flag_val),
                            "tone": tone if (flag_val is not None and v == flag_val) else "ok"})
        answers.sort(key=lambda a: -a["count"])
        flagged = next((a for a in answers if a["flag"]), None)
        out.append({
            "key": key, "label": label, "question": question,
            "source_field": src_col, "available": True, "answers": answers,
            "pending": {**pending, "pos": round(pending["pos"], 2),
                        "pct": round(pending["count"] / total * 100, 2) if total else 0.0},
            "flag_count": flagged["count"] if flagged else 0,
            "flag_pos": flagged["pos"] if flagged else 0.0,
            "flag_label": flag_val,
        })

    # One borrower blank on one question is almost always blank on all of them,
    # so the page can state this as a single unassessed population instead of
    # four unrelated gaps. `fields` lists which questions that population is
    # actually missing, so the claim is shown rather than asserted.
    cols = [c for _, _, _, _, c, _, _ in RISK_QUESTIONS if c in df.columns]
    if cols:
        blank = pd.Series(False, index=df.index)
        for c in cols:
            blank = blank | df[c].astype(str).isin(["Unknown", "Unclassified", "nan", "None", ""])
        allblank = pd.Series(True, index=df.index)
        for c in cols:
            allblank = allblank & df[c].astype(str).isin(["Unknown", "Unclassified", "nan", "None", ""])
        unassessed = {
            "count": int(blank.sum()), "pos": round(float(pos_s[blank].sum()), 2),
            "all_four": int(allblank.sum()),
            "pct": round(float(blank.sum()) / total * 100, 2) if total else 0.0,
            "fields": [{"question": q, "source_field": sc,
                        "count": int(df[c].astype(str)
                                     .isin(["Unknown", "Unclassified", "nan", "None", ""]).sum())}
                       for _, _, q, sc, c, _, _ in RISK_QUESTIONS if c in df.columns],
        }
    else:
        unassessed = {"count": 0, "pos": 0.0, "all_four": 0, "pct": 0.0, "fields": []}

    return {"questions": out, "total_loans": total, "total_pos": round(tpos, 2),
            "unassessed": unassessed, "as_of": _as_of_date(df)}


def _as_of_date(df: pd.DataFrame):
    if "as_of_date" in df.columns and not df.empty:
        return str(df["as_of_date"].max())
    return None
