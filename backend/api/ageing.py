"""
ageing.py — Ageing Analysis report.

Replicates the Excel "Ageing Analysis" sheet: grouped by AP#1 (default Business
Segment) → AP#2 (default OD Bucket), with columns
    POS | % (of AP#1 group) | # Loans | OD Amt | CE % | OD-to-Disb %

Data is assembled from the two existing snapshot tables (no new pipeline):
  • rpt_aum_status   → POS, # Loans, OD Amt (arrear), sanctioned  [A/D/W book]
  • rpt_collection   → MTD demand & collection → CE%              [demand universe]
Both carry the same dimension columns, so we group each by the chosen AP dims
and merge on the AP key.  This keeps POS from the book and CE from collections,
exactly as the Excel does.
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional
import pandas as pd
from core.db import read_report
from core.filters import hier, segment_filter, multi
from auth.deps import get_current_user

router = APIRouter()

# Canonical DPD-bucket order so the ageing rows read Regular → 360+ → Write-Off
BUCKET_ORDER = {b: i for i, b in enumerate(
    ["Regular", "1 - 30", "31 - 60", "61 - 90", "91 - 180", "181 - 360", "360 +", "Write-Off"]
)}

DIM_COL = {
    "business_segment": "business_segment", "zone_name": "zone_name",
    "cluster_name": "cluster_name", "region_name": "region_name", "area_name": "area_name",
    "branch_name": "branch_name", "state_id": "state_id", "district_id": "district_id",
    "prod_classification": "prod_classification", "curr_od_status": "curr_od_status",
    "dpd_bucket": "dpd_bucket", "bucket_movement": "bucket_movement",
    "loan_status": "loan_status", "disb_year": "disb_year", "cycle_no": "cycle_no",
    "caste": "caste", "religion": "religion", "purpose_id": "purpose_id",
    "facility_id": "facility_id", "lender_id": "lender_id", "lo_id": "lo_id",
    "product_id": "product_id",
}


def _apply_filters(df, f) -> pd.DataFrame:
    if f.get("portfolio") == "without" and "loan_status" in df.columns:
        df = df[df["loan_status"] != "Write-off"]
    df = segment_filter(df, f.get("segment") or "ALL")
    df = hier(df, f.get("cluster"), f.get("region"), f.get("area"), f.get("branch"), zone=f.get("zone"))
    df = multi(df, "state_id",            f.get("branch_state"))
    df = multi(df, "district_id",         f.get("district"))
    df = multi(df, "prod_classification", f.get("prod_class"))
    df = multi(df, "curr_od_status",      f.get("od_status"))
    df = multi(df, "dpd_bucket",          f.get("od_bucket"))
    df = multi(df, "bucket_movement",     f.get("bucket_movement"))
    df = multi(df, "loan_status",         f.get("loan_status"))
    df = multi(df, "disb_year",           f.get("disb_year"))
    df = multi(df, "cycle_no",            f.get("cycle"))
    df = multi(df, "purpose_id",          f.get("purpose"))
    df = multi(df, "facility_id",         f.get("facility"))
    df = multi(df, "lender_id",           f.get("lender"))
    df = multi(df, "caste",               f.get("caste"))
    df = multi(df, "religion",            f.get("religion"))
    return df


def _filter_params(
    segment: Optional[str] = Query(None), zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None), region: Optional[str] = Query(None),
    area: Optional[str] = Query(None), branch: Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None), district: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None), od_status: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None), bucket_movement: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None), disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None), purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None), lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None), religion: Optional[str] = Query(None),
    portfolio: Optional[str] = Query(None),
) -> dict:
    return dict(
        segment=segment, zone=zone, cluster=cluster, region=region, area=area,
        branch=branch, branch_state=branch_state, district=district, prod_class=prod_class,
        od_status=od_status, od_bucket=od_bucket, bucket_movement=bucket_movement,
        loan_status=loan_status, disb_year=disb_year, cycle=cycle, purpose=purpose,
        facility=facility, lender=lender, caste=caste, religion=religion, portfolio=portfolio,
    )


def _safe(df: pd.DataFrame, key: str) -> str:
    col = DIM_COL.get(key, key)
    if col not in df.columns:
        df[col] = "N/A"
    return col


def _ce(collection: float, demand: float) -> float:
    """Capped CE% ≤ 100 (min(collection, demand) / demand)."""
    return round(min(collection, demand) / demand * 100, 2) if demand else 0.0


def _metrics(pos, loans, od, sanc, dem, col) -> dict:
    return {
        "pos": pos, "loans": int(loans), "od_amt": od,
        "ce": _ce(col, dem),
        "od_to_disb": round(od / sanc * 100, 2) if sanc else 0.0,
    }


def _bucket_sort_key(v: str):
    return (BUCKET_ORDER.get(v, 99), str(v))


@router.get("/ageing/group-summary")
def ageing_group_summary(
    group_by: str = Query("business_segment"),
    group_by_2: Optional[str] = Query("dpd_bucket"),
    filters: dict = Depends(_filter_params),
    user: dict = Depends(get_current_user),
):
    aum = read_report("rpt_aum_status")
    # movement-only rows (closed during the current month) are not the live book
    if "open_now" in aum.columns:
        aum = aum[aum["open_now"].fillna(True).astype(bool)]
    elif "loan_status" in aum.columns:
        aum = aum[aum["loan_status"].astype(str) != "Closed"]
    col = read_report("rpt_collection")
    if aum.empty:
        return []
    aum = _apply_filters(aum, filters)
    col = _apply_filters(col, filters) if not col.empty else col
    if aum.empty:
        return []

    # total_arrear is added by a later aum_status pipeline run; tolerate its
    # absence so the report still renders POS / % / #Loans / CE meanwhile.
    if "total_arrear" not in aum.columns:
        aum = aum.assign(total_arrear=0.0)
    if "total_sanctioned" not in aum.columns:
        aum = aum.assign(total_sanctioned=0.0)

    a1 = _safe(aum, group_by)
    has2 = bool(group_by_2 and group_by_2 != "none")
    a2 = _safe(aum, group_by_2) if has2 else None
    keys = [a1] + ([a2] if a2 else [])

    # AUM side: POS / loans / OD Amt / sanctioned
    ag = aum.groupby(keys, dropna=False).agg(
        pos=("total_pos", "sum"), loans=("loan_count", "sum"),
        od=("total_arrear", "sum"), sanc=("total_sanctioned", "sum"),
    ).reset_index()

    # Collection side: MTD demand / collection → CE
    if not col.empty:
        c1 = _safe(col, group_by)
        c2 = _safe(col, group_by_2) if has2 else None
        ckeys = [c1] + ([c2] if c2 else [])
        cg = col.groupby(ckeys, dropna=False).agg(
            dem=("mtd_demand", "sum"), col=("mtd_collection", "sum"),
        ).reset_index()
        cg.columns = keys + ["dem", "col"]
    else:
        cg = pd.DataFrame(columns=keys + ["dem", "col"])

    merged = ag.merge(cg, on=keys, how="left").fillna({"dem": 0, "col": 0})

    grand_pos = float(merged["pos"].sum()) or 1.0
    rows = []

    if has2:
        # AP#1 subtotal (group header) + its AP#2 rows, per group
        for g1, sub in merged.groupby(a1, dropna=False):
            gp = float(sub["pos"].sum())
            hdr = _metrics(gp, sub["loans"].sum(), float(sub["od"].sum()),
                           float(sub["sanc"].sum()), float(sub["dem"].sum()), float(sub["col"].sum()))
            hdr.update({"name": str(g1), "name2": None, "kind": "group", "pct": 100.0})
            rows.append(hdr)
            sub = sub.copy()
            sub["_ord"] = sub[a2].map(_bucket_sort_key) if group_by_2 == "dpd_bucket" else sub[a2].astype(str)
            for _, r in sub.sort_values("_ord").iterrows():
                m = _metrics(float(r["pos"]), r["loans"], float(r["od"]),
                             float(r["sanc"]), float(r["dem"]), float(r["col"]))
                m.update({"name": str(g1), "name2": str(r[a2]), "kind": "row",
                          "pct": round(float(r["pos"]) / gp * 100, 2) if gp else 0.0})
                rows.append(m)
    else:
        srt = merged.copy()
        srt["_ord"] = srt[a1].map(_bucket_sort_key) if group_by == "dpd_bucket" else -srt["pos"]
        for _, r in srt.sort_values("_ord").iterrows():
            m = _metrics(float(r["pos"]), r["loans"], float(r["od"]),
                         float(r["sanc"]), float(r["dem"]), float(r["col"]))
            m.update({"name": str(r[a1]), "name2": None, "kind": "row",
                      "pct": round(float(r["pos"]) / grand_pos * 100, 2)})
            rows.append(m)

    # Grand total
    gt = _metrics(float(merged["pos"].sum()), merged["loans"].sum(), float(merged["od"].sum()),
                  float(merged["sanc"].sum()), float(merged["dem"].sum()), float(merged["col"].sum()))
    gt.update({"name": "Grand Total", "name2": None, "kind": "total", "pct": 100.0})
    rows.append(gt)
    return rows


@router.get("/ageing/kpis")
def ageing_kpis(filters: dict = Depends(_filter_params), user: dict = Depends(get_current_user)):
    aum = read_report("rpt_aum_status")
    # movement-only rows (closed during the current month) are not the live book
    if "open_now" in aum.columns:
        aum = aum[aum["open_now"].fillna(True).astype(bool)]
    elif "loan_status" in aum.columns:
        aum = aum[aum["loan_status"].astype(str) != "Closed"]
    col = read_report("rpt_collection")
    if aum.empty:
        return {}
    aum = _apply_filters(aum, filters)
    col = _apply_filters(col, filters) if not col.empty else col
    pos = float(aum["total_pos"].sum())
    od = float(aum["total_arrear"].sum()) if "total_arrear" in aum.columns else 0.0
    sanc = float(aum["total_sanctioned"].sum()) if "total_sanctioned" in aum.columns else 0.0
    # Loans in OD = loans in an overdue DPD bucket (1-30 … 360+; excludes Regular & Write-Off)
    od_buckets = ["1 - 30", "31 - 60", "61 - 90", "91 - 180", "181 - 360", "360 +"]
    loans_in_od = int(aum[aum["dpd_bucket"].isin(od_buckets)]["loan_count"].sum()) if "dpd_bucket" in aum.columns else 0
    return {
        "total_pos": pos,
        "loan_count": int(aum["loan_count"].sum()),
        "od_amt": od,
        "od_pct": round(od / pos * 100, 2) if pos else 0,
        "loans_in_od": loans_in_od,
        "od_to_disb": round(od / sanc * 100, 2) if sanc else 0,
    }
