"""
core/filters.py — shared slicer helpers used by every dashboard page.

The global slicer panel sends comma-separated multi-select values. These
helpers parse them and apply isin() filters. Business Segment (IEL/JLG/LAP)
is mapped onto loan_source (IL/JLG) for reports that only carry loan_source.
"""

from typing import Optional
import pandas as pd

# PBI business segment → legacy loan_source for reports without a
# business_segment column (daily, mtd, disbursement, pos_par, writeoff).
SEGMENT_TO_LOAN_SOURCE = {"IEL": "IL", "LAP": "IL", "JLG": "JLG"}


def vals(raw: Optional[str]) -> list[str]:
    """Parse a slicer value: comma-separated multi-select, ignoring ALL/blank."""
    if not raw or raw == "ALL":
        return []
    return [v for v in (x.strip() for x in str(raw).split(",")) if v and v != "ALL"]


def multi(df: pd.DataFrame, col: str, raw: Optional[str]) -> pd.DataFrame:
    """Filter df[col] to the selected values (multi-select via isin)."""
    selected = vals(raw)
    if selected and col in df.columns:
        df = df[df[col].astype(str).isin(selected)]
    return df


def hier(
    df: pd.DataFrame,
    cluster: Optional[str] = None, region: Optional[str] = None,
    area: Optional[str] = None, branch: Optional[str] = None,
    zone: Optional[str] = None,
) -> pd.DataFrame:
    """Apply the geography hierarchy slicers (multi-select)."""
    df = multi(df, "zone_name",    zone)
    df = multi(df, "cluster_name", cluster)
    df = multi(df, "region_name",  region)
    df = multi(df, "area_name",    area)
    df = multi(df, "branch_name",  branch)
    return df


def segment_filter(
    df: pd.DataFrame, segment: str = "ALL", loan_source: str = "ALL",
) -> pd.DataFrame:
    """Filter by Business Segment. Uses the business_segment column when present
    (AUM report); otherwise maps IEL/LAP→IL and JLG→JLG onto loan_source.
    Falls back to the legacy single loan_source param for compatibility."""
    seg = vals(segment)
    if seg:
        if "business_segment" in df.columns:
            df = df[df["business_segment"].astype(str).isin(seg)]
        elif "loan_source" in df.columns:
            sources = {SEGMENT_TO_LOAN_SOURCE.get(s, s) for s in seg}
            df = df[df["loan_source"].astype(str).isin(sources)]
    elif loan_source and loan_source != "ALL" and "loan_source" in df.columns:
        df = df[df["loan_source"] == loan_source]
    return df
