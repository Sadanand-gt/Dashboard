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

from auth.deps import get_current_user
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
    return df


def _filters(
    segment: Optional[str] = Query(None), zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None), branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None), lo: Optional[str] = Query(None),
    risk_category: Optional[str] = Query(None), pep: Optional[str] = Query(None),
    work_abroad: Optional[str] = Query(None), luc: Optional[str] = Query(None),
) -> dict:
    return {"segment": segment, "zone": zone, "cluster": cluster, "region": region,
            "area": area, "branch": branch, "prod_class": prod_class,
            "branch_state": branch_state, "district": district, "lo": lo,
            "risk_category": risk_category, "pep": pep,
            "work_abroad": work_abroad, "luc": luc}


def _prep(user: dict, f: dict) -> pd.DataFrame:
    df = read_report("rpt_aml")          # scope applied centrally
    if df.empty:
        return df
    for c in MEASURES:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)
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
