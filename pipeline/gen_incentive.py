"""Incentive engine — BM track, current FY, month-wise.

WHY THIS IS PYTHON AND NOT A .sql FILE
    Every branch-month metric the calculation needs already exists in
    rpt_trend_full, which lives in the REPORT Postgres. Pipeline SQL runs against
    the REPLICA, and Postgres cannot join across databases. Recomputing the
    metrics on the replica would fork the definitions — exactly the drift that
    produced the LAP classification bug across six queries and two wrong CE
    attempts. Sourcing rpt_trend_full instead means incentive ties the dashboards
    by construction: same CE, same 0-bucket POS, same loan counts, permanently.

RULES (all verbatim from the extracted policy sources)
    Grade       band lookup on 0-BUCKET POS: <3Cr C, <6Cr B, <9Cr A, >=9Cr A+
    prev_grade  the SAME bands on the PREVIOUS month's 0-bucket POS
    Paid on     PREVIOUS grade                      (decision 2026-08-10)
    CE %        0B collection COUNT / 0B demand COUNT — a COUNT ratio
    Core Matrix prev_grade x disbursement band x CE band -> rupees
    Recovery    1-60 coll * 0.02 + 60+ coll * 0.04  (paid independently)
    Final       Core Matrix + Recovery + Upgrade    (ADDITION)
    LAP Booster NOT APPLIED                         (decision 2026-08-10)
    Eligibility STRICT — any exit_date disqualifies EVERY month of the FY

STILL UNVERIFIED. Not payable until reconciled against the July sheet the team
has already sent to the field.
"""
from __future__ import annotations

import logging
import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

# ── Grade bands on 0-bucket POS (DAX "Grade", verbatim) ──────────────────────
GRADE_BANDS = [(30_000_000, "Grade C"), (60_000_000, "Grade B"),
               (90_000_000, "Grade A"), (float("inf"), "Grade A+")]

# ── Core Matrix ──────────────────────────────────────────────────────────────
# payouts index 0..5 = CE bands 98.51-98.99, 99.00-99.24, 99.25-99.49,
#                                99.50-99.69, 99.70-99.99, 100.00
# Below 98.51% pays nothing — a hard cliff, not a taper.
# The published rows carry SEVEN columns; the leading "–" is that <98.51% column.
# Grade A+ maps to the Grade A matrix — confirmed in DAX "Core Matrix", which
# routes both to [Grade_A Incentive]. Not a copy error in the slab files.
CORE_MATRIX: dict[str, list[tuple[float, float, list[int]]]] = {
    "Grade A": [
        (0,       3_000_000, [ 500, 1000, 1500, 3000, 4000, 5000]),
        (3_000_000, 3_500_000, [1000, 1500, 3000, 4500, 6000, 7500]),
        (3_500_000, 4_000_000, [1500, 2000, 4500, 6000, 8000, 10000]),
        (4_000_000, 4_500_000, [2000, 3000, 6000, 8000, 10000, 12500]),
        (4_500_000, 5_000_000, [2500, 3500, 7500, 10000, 12500, 15000]),
        (5_000_000, 5_500_000, [3000, 4000, 9000, 12000, 15000, 17500]),
        (5_500_000, 6_000_000, [3500, 5000, 10500, 14000, 17500, 20000]),
        (6_000_000, float("inf"), [4000, 6000, 12000, 16000, 20000, 22500]),
    ],
    "Grade B": [
        (0,       2_500_000, [ 500, 1000, 1500, 2500, 3500, 4000]),
        (2_500_000, 3_000_000, [1000, 1500, 2500, 4000, 5000, 6500]),
        (3_000_000, 3_500_000, [1500, 2000, 4000, 5000, 7000, 8500]),
        (3_500_000, 4_000_000, [1750, 2500, 5000, 7000, 8500, 10500]),
        (4_000_000, 4_500_000, [2000, 3000, 6500, 8500, 10500, 13000]),
        (4_500_000, 5_000_000, [2500, 3500, 7500, 10000, 13000, 15000]),
        (5_000_000, 5_500_000, [3000, 4000, 9000, 12000, 15000, 17000]),
        (5_500_000, float("inf"), [3500, 5000, 10000, 13500, 17000, 19000]),
    ],
    "Grade C": [
        (0,       2_000_000, [ 500,  750, 1000, 2000, 2500, 3500]),
        (2_000_000, 2_500_000, [ 750, 1000, 2000, 3000, 4000, 5000]),
        (2_500_000, 3_000_000, [1000, 1500, 3000, 4000, 5500, 6500]),
        (3_000_000, 3_500_000, [1500, 2000, 4000, 5500, 6500, 8000]),
        (3_500_000, 4_000_000, [1750, 2500, 5000, 6500, 8000, 10000]),
        (4_000_000, 4_500_000, [2000, 3000, 6000, 8000, 10000, 11500]),
        (4_500_000, 5_000_000, [2500, 3500, 7000, 9500, 11500, 13000]),
        (5_000_000, float("inf"), [3000, 4000, 8000, 10500, 13000, 14500]),
    ],
}
CORE_MATRIX["Grade A+"] = CORE_MATRIX["Grade A"]

# ═════════════════════════════════════════════════════════════════════════════
# LOAN OFFICER TRACK — a SEPARATE structure from BM. Transcribed verbatim from
# References/All Incentive Policy/LO_Matrices_Extracted.txt (which was read off
# the image-only LO PDF). Do not reuse any BM constant here:
#   * the LO CE floor is 98.75%, the BM's is 98.51%
#   * the disbursement ladder DIFFERS per grade (G1 -> 10L+, G2 -> 12L+, G3 -> 14L+)
#   * No Grade pays ONLY in the EARN zone (>= 99.70%) — a cliff, not a lower rate
#   * the recovery bonus is Rs 100 per overdue EMI (a COUNT), not a % of amount
#
# Attribution: the "LO mapped in Finpage" (policy footnote 1) is
# home_center_master.assigned_to — confirmed 2026-08-11.
# ═════════════════════════════════════════════════════════════════════════════

# Grade by 0-bucket AUM as on the 1ST of the month (= the prior month-end).
LO_GRADE_BANDS = [(2_500_000, "No Grade"), (5_000_000, "Grade 1"),
                  (10_000_000, "Grade 2"), (float("inf"), "Grade 3")]

LO_CE_FLOOR = 0.9875
# payouts index 0..5 = 98.75-98.99, 99.00-99.24, 99.25-99.49, 99.50-99.69,
#                      99.70-99.99, 100.00
LO_CE_EDGES = [0.9875, 0.9900, 0.9925, 0.9950, 0.9970, 1.0000]

# No Grade is the exception: only the EARN zone qualifies, so its payouts are
# indexed 0..1 = 99.70-99.99, 100.00 and anything below 99.70% pays nothing.
LO_NOGRADE_EDGES = [0.9970, 1.0000]

LO_MATRIX: dict[str, list[tuple[float, float, list[int]]]] = {
    "No Grade": [
        (0,          500_000, [1500, 2000]),
        (500_000,    800_000, [2500, 3000]),
        (800_000,  1_000_000, [4500, 5500]),
        (1_000_000, float("inf"), [6000, 7500]),
    ],
    "Grade 1": [
        (0,          500_000, [ 400,  600, 1000, 1500, 2000,  2500]),
        (500_000,    800_000, [ 750, 1000, 1750, 2500, 3000,  4000]),
        (800_000,  1_000_000, [1500, 2250, 3500, 5500, 7000,  8000]),
        (1_000_000, float("inf"), [2000, 3000, 4500, 6500, 8500, 10000]),
    ],
    "Grade 2": [
        (0,          500_000, [ 500,  700, 1150, 1750, 2250,  2750]),
        (500_000,    800_000, [ 850, 1150, 2000, 2750, 3500,  4500]),
        (800_000,  1_000_000, [1750, 2500, 4000, 6500, 8000,  9500]),
        (1_000_000, 1_200_000, [2250, 3500, 5000, 7500, 10000, 11500]),
        (1_200_000, float("inf"), [2750, 4000, 6000, 9000, 11000, 13000]),
    ],
    "Grade 3": [
        (0,          600_000, [ 600,  800, 1300, 2000, 2500,  3000]),
        (600_000,    900_000, [1000, 1500, 2250, 3000, 4000,  5000]),
        (900_000,  1_200_000, [2000, 3000, 4500, 7500, 9500, 11000]),
        (1_200_000, 1_400_000, [2500, 3750, 5750, 8500, 11500, 13500]),
        (1_400_000, float("inf"), [3000, 4500, 6500, 9500, 13500, 16000]),
    ],
}

# Rs per overdue EMI collected.
#   * Only FULL EMI collections count — partials do not (policy footnote 5).
#   * Collections by the Collection Team are EXCLUDED (footnote 7). Source:
#     repayment_detail.collected_by joined to home_employee_master, then filtered
#     on designation.
#   * UPI COUNTS FOR THE LO (decision 2026-08-11). 'UPI' is a literal value in
#     collected_by, not a person — 14,582 of July's 91,753 JLG collections (16%)
#     with payment_mode 'CL'. The policy is silent on it because UPI is the
#     ABSENCE of a collector, not a team. Business decision: the LO is credited.
#     Do not re-derive this from the policy text; it is not in there.
LO_OD_BONUS_PER_EMI = 100


def lo_grade(pos: float) -> str | None:
    if pd.isna(pos):
        return None
    for hi, name in LO_GRADE_BANDS:
        if pos < hi:
            return name
    return "Grade 3"


def lo_payout(grade: str | None, disb: float, ce: float) -> float:
    """Core payout for an LO. Returns 0 below the grade's CE floor — a cliff."""
    if grade is None or pd.isna(ce) or pd.isna(disb) or grade not in LO_MATRIX:
        return 0.0
    edges = LO_NOGRADE_EDGES if grade == "No Grade" else LO_CE_EDGES
    if ce < edges[0]:
        return 0.0
    band = max(i for i, e in enumerate(edges) if ce >= e)
    for lo_, hi, payouts in LO_MATRIX[grade]:
        if lo_ <= disb < hi:
            return float(payouts[band])
    return 0.0


CE_FLOOR = 0.9851
CE_EDGES = [0.9851, 0.9900, 0.9925, 0.9950, 0.9970, 1.0000]


def _grade(pos: float) -> str | None:
    if pd.isna(pos):
        return None
    for hi, name in GRADE_BANDS:
        if pos < hi:
            return name
    return "Grade A+"


def _ce_band(ce: float) -> int | None:
    """Index into a payouts list, or None when CE is below the floor."""
    if pd.isna(ce) or ce < CE_FLOOR:
        return None
    idx = 0
    for i, e in enumerate(CE_EDGES):
        if ce >= e:
            idx = i
    return idx


def _base_payout(grade: str | None, disb: float, band) -> float:
    # band arrives as float: a pandas column holding NaN is float64, so the
    # index has to be coerced back to int before it can subscript the list.
    if grade is None or pd.isna(band) or pd.isna(disb) or grade not in CORE_MATRIX:
        return 0.0
    for lo, hi, payouts in CORE_MATRIX[grade]:
        if lo <= disb < hi:
            return float(payouts[int(band)])
    return 0.0


def build_incentive(trend: pd.DataFrame, emp: pd.DataFrame,
                    fy_start: pd.Timestamp | None = None) -> pd.DataFrame:
    """trend: rpt_trend_full rows from ONE MONTH BEFORE the FY (April is paid on
    March's grade, so without the priming month every April row is
    NO_PREV_GRADE). emp: employee master + exit_date. fy_start drops the priming
    month from the result."""
    # ── branch x month metrics, straight from the published trend table ──────
    t = (trend.groupby(["month_end", "branch_id"], dropna=False)
              .agg(pos_eom=("pos_eom", "sum"),
                   par0_pos=("par0_pos", "sum"),
                   reg_demand_count=("reg_demand_count", "sum"),
                   reg_collection_count=("reg_collection_count", "sum"),
                   disb_amount=("disb_amount", "sum"),
                   par1_60_collection=("par1_60_collection", "sum"),
                   par60_collection=("par60_collection", "sum"))
              .reset_index())

    # 0-bucket POS = total POS minus everything at DPD >= 1. Same figure the
    # dashboards publish, so the grade cannot disagree with Current Outstanding.
    t["zero_bucket_pos"] = t["pos_eom"] - t["par0_pos"]

    t = t.sort_values(["branch_id", "month_end"])
    t["zero_bucket_pos_prev"] = t.groupby("branch_id")["zero_bucket_pos"].shift(1)

    t["grade"] = t["zero_bucket_pos"].map(_grade)
    t["prev_grade"] = t["zero_bucket_pos_prev"].map(_grade)

    # CE is a COUNT ratio over loans Regular at the previous month-end.
    t["ce_pct"] = np.where(t["reg_demand_count"] > 0,
                           t["reg_collection_count"] / t["reg_demand_count"],
                           np.nan)
    t["ce_band"] = t["ce_pct"].map(_ce_band)

    t["base_payout"] = [
        _base_payout(g, d, b)
        for g, d, b in zip(t["prev_grade"], t["disb_amount"], t["ce_band"])
    ]

    # ── one BM per branch: the master keeps historical postings ──────────────
    bm = emp[emp["designation_name"].str.contains("Branch Manager", case=False, na=False)]
    bm = bm[(bm["active"].str.upper() == "Y") & bm["exit_date"].isna()]
    bm = bm.sort_values("employee_id").drop_duplicates("branch_id", keep="last")

    df = t.merge(bm, on="branch_id", how="inner")

    # ── STRICT eligibility ───────────────────────────────────────────────────
    df["is_eligible"] = (df["exit_date"].isna()
                         & (df["active"].str.upper() == "Y")
                         & df["prev_grade"].notna()
                         & df["ce_band"].notna())
    df["ineligible_reason"] = np.select(
        [df["exit_date"].notna(),
         df["active"].str.upper() != "Y",
         df["prev_grade"].isna(),
         df["ce_pct"].isna(),
         df["ce_band"].isna()],
        ["EXITED", "NOT_ACTIVE", "NO_PREV_GRADE", "NO_DEMAND", "CE_BELOW_FLOOR"],
        default=None)

    # ── Recovery bonus (DAX "Recovery Bonus", verbatim) ─────────────────────
    #   1-60 bucket collection * 0.02  +  60+ bucket collection * 0.04
    #
    # PAID INDEPENDENTLY. The DAX carries the note "Recovery bonus paid
    # independently — not subject to CE multiplier or degradation rule", so it
    # does NOT depend on the CE band or the grade: a branch below the 98.51% CE
    # floor still earns bonus on what it recovered. Only EMPLOYMENT gates it —
    # the strict exit rule zeroes everything for anyone who has left.
    #
    # CONFIRMED 2026-08-11: "independently" means independent of CE and grade,
    # NOT of employment. A branch below the CE floor still earns bonus on what it
    # recovered; someone who has exited earns nothing. The policy is the
    # authority here — re-read it rather than reasoning from the code.
    df["recovery_bonus"] = (df["par1_60_collection"].fillna(0) * 0.02
                            + df["par60_collection"].fillna(0) * 0.04).round(2)
    df["ce_multiplier"] = np.nan   # BM track has no CE multiplier; DM/SH do
    df["upgrade_bonus"] = np.nan   # slab not yet read — excluded from the total

    employed = df["exit_date"].isna() & (df["active"].str.upper() == "Y")
    df["final_incentive"] = (
        np.where(df["is_eligible"], df["base_payout"], 0.0)
        + np.where(employed, df["recovery_bonus"], 0.0)
    ).round(2)

    # Drop the priming month — it exists only to give the FY's first month a
    # prev_grade and is not itself part of this FY's incentive.
    if fy_start is not None:
        df = df[pd.to_datetime(df["month_end"]) >= pd.Timestamp(fy_start)]
    return df.reset_index(drop=True)
