"""
/api/trend/series — one endpoint for all 13 Trend reports.

Reads rpt_trend_full (monthly grain × segment × branch × lo, additive
components; produced by pipeline trend_full). Ratios are computed HERE after
grouping, so any Analysis Parameter grouping and the user's data scope work
naturally. Months are financial-year based (April → March).
"""

from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text, bindparam

from auth.deps import get_current_user
from core.db import report_days, reports_conn
from core.scope import user_scope, LEVEL_COL

router = APIRouter()

# Additive measure components the SQL aggregation sums per (month × group). The
# ratios are formed from these AFTER grouping, so any grouping/scope is correct.
TREND_COMPONENTS = [
    "loans_eom", "pos_eom", "par0_pos", "par30_pos", "par60_pos", "par90_pos",
    "wo_loans_eom", "wo_pos_eom", "disb_count", "disb_amount", "demand",
    "collection", "collection_capped", "slip_count", "slip_pos",
    "prev_regular_pos", "reg_demand", "reg_collection", "par60_collection",
    # Collections from the 1-60 bucket. On rpt_trend_full since the engine was
    # built but never surfaced; the PAR 60 page pairs it with par60_collection
    # to show whether recovery is coming from early or deep arrears.
    "par1_60_collection",
    "wo_recovery",
    # write-off portion of the flow measures — "With W/O" folds these in (see
    # _apply_portfolio), so CE / roll-rate / slippage offer both views like POS.
    "demand_wo", "collection_capped_wo", "slip_count_wo", "slip_pos_wo",
    "prev_regular_pos_wo", "reg_demand_wo", "reg_collection_wo",
]

# base measure column -> its write-off-portion companion. "With W/O" adds the
# companion into the base (mirroring pos_eom += wo_pos_eom); "Excl W/O" leaves
# the base (already write-off-excluded in the pipeline) untouched.
WO_FLOW_PAIRS = {
    "demand": "demand_wo",
    "collection_capped": "collection_capped_wo",
    "slip_count": "slip_count_wo",
    "slip_pos": "slip_pos_wo",
    "prev_regular_pos": "prev_regular_pos_wo",
    "reg_demand": "reg_demand_wo",
    "reg_collection": "reg_collection_wo",
}

# measure -> (numerator cols summed, formula)
SUM = "sum"          # plain sum of one column
RATIO = "ratio"      # 100 * num / den
CAPPED = "capped"    # 100 * min(num, den) / den   (CE-style)
INV = "inv"          # 100 * (den - num) / den     (missed share, floor 0)

MEASURES: dict = {
    "pos":              (SUM,    "pos_eom", None),
    "loans":            (SUM,    "loans_eom", None),
    "par0_pct":         (RATIO,  "par0_pos", "pos_eom"),
    "par30_pct":        (RATIO,  "par30_pos", "pos_eom"),
    "par90_pct":        (RATIO,  "par90_pos", "pos_eom"),
    "roll_rate":        (RATIO,  "slip_pos", "prev_regular_pos"),
    "slip_count":       (SUM,    "slip_count", None),
    "slip_pos":         (SUM,    "slip_pos", None),
    "disb_amount":      (SUM,    "disb_amount", None),
    "disb_count":       (SUM,    "disb_count", None),
    # numerators already capped per loan-month in the pipeline
    "ce_pct":           (RATIO,  "collection_capped", "demand"),
    "reg_ce_pct":       (RATIO,  "reg_collection", "reg_demand"),
    # demand-weighted roll: missed demand of prev-Regular loans / their demand
    # (= 100 − Regular Bucket CE%; Excel's sheet is an empty pivot, so this
    #  standard complement definition is used)
    "demand_roll_rate": (INV,    "reg_collection", "reg_demand"),
    "par60_collection": (SUM,    "par60_collection", None),
    "par1_60_collection": (SUM,  "par1_60_collection", None),
    # STOCK of the deep-arrears book at month-end, and what share of it came
    # back that month. par60_collection is reconciled against
    # "August, 2026 Dashboards" -> "Trend - PAR60 Collection": 8 of 12 months
    # match to the rupee, mean absolute difference 0.78%.
    "par60_pos":        (SUM,    "par60_pos", None),
    # EXCL W/O ONLY — do not read this on the "With W/O" toggle.
    # _apply_portfolio adds the ENTIRE write-off POS (wo_pos_eom) to par60_pos
    # in the "with" view, but par60_collection has no _wo companion in
    # WO_FLOW_PAIRS, so the numerator stays live-book while the denominator
    # gains the whole written-off book. The ratio collapses toward zero and
    # means nothing. The Excel reconciliation above is on the stored (excl-W/O)
    # values, which is the view the PAR 60 page pins itself to.
    "par60_recovery_pct": (RATIO, "par60_collection", "par60_pos"),
    "wo_recovery":      (SUM,    "wo_recovery", None),
}

GROUP_DIMS = {
    "business_segment", "loan_source", "zone_name", "cluster_name",
    "region_name", "area_name", "branch_name", "lo_id",
    # Tier 1+2 dims (present after the rpt_trend_full rebuild; gated on the
    # table's actual columns so the backend degrades gracefully before then).
    "state_id", "district_id", "disb_year", "cycle_no", "prod_classification",
}

# AP dimensions the page offers that rpt_trend_full does not store under that
# name. The trend groups by the BASE column it does have, and row names are then
# relabelled to the "<id> - NAME" form using rpt_aum_status, so the trend's
# labels read identically to the Analysis Parameter table above it.
DIM_ALIAS = {
    "branch_label":  "branch_name",
    "area_label":    "area_name",
    "region_label":  "region_name",
    "cluster_label": "cluster_name",
    "zone_label":    "zone_name",
    "lo_name":       "lo_id",
}

# AP dimensions still not carried by rpt_trend_full (Tier 3 loan attributes +
# time-varying month-state dims). Selecting one is reported in `unsupported` so
# the UI states it instead of silently showing an unfiltered trend.
TREND_UNSUPPORTED_DIMS = {
    "dpd_bucket", "bucket_movement", "loan_status", "caste", "religion",
    "purpose_id", "facility_id", "lender_id", "od_movement_status",
    "curr_od_status",
}

# slicer query-param -> column shared by BOTH rpt_trend_full and rpt_aum_status.
# A param whose column is not (yet) in rpt_trend_full is reported unsupported and
# applied to neither the trend nor its live pin (so the two stay consistent).
TREND_FILTER_COL = {
    "zone": "zone_name", "cluster": "cluster_name", "region": "region_name",
    "area": "area_name", "branch": "branch_name", "lo": "lo_id",
    "branch_state": "state_id", "district": "district_id",
    "disb_year": "disb_year", "cycle": "cycle_no",
    "prod_class": "prod_classification",
}
# Slicers with no column in rpt_trend_full at all (Tier 3 + time-varying).
TREND_FILTER_NOCOL = {
    "od_bucket", "od_movement", "bucket_movement", "loan_status",
    "purpose", "facility", "lender", "caste", "religion",
}


def _trend_columns() -> set:
    """Actual columns of rpt_trend_full (cached). Gates the new dims so the
    backend degrades gracefully until the DBA rebuild adds them."""
    if _trend_columns._cache is None:
        try:
            with reports_conn() as c:
                _trend_columns._cache = set(
                    pd.read_sql("SELECT * FROM rpt_trend_full LIMIT 0", c).columns)
        except Exception:
            _trend_columns._cache = set()
    return _trend_columns._cache


_trend_columns._cache = None

# Point-in-time measures whose latest trend point can be pinned to the LIVE
# report (rpt_aum_status) — (numerator col, denominator col or None for absolute).
# Flow measures (disbursement, CE, slippage, recovery, roll rates) are NOT here:
# their latest completed month is authoritative and "live" is a partial month.
LIVE_ANCHOR: dict = {
    "pos":       ("total_pos", None),
    "loans":     ("loan_count", None),
    "par0_pct":  ("par0_pos", "total_pos"),
    "par30_pct": ("par30_pos", "total_pos"),
    "par90_pct": ("par90_pos", "total_pos"),
}


def _apply_portfolio(df: pd.DataFrame, portfolio: Optional[str]) -> pd.DataFrame:
    """Portfolio view for the trend, mirroring the live report.

    rpt_trend_full stores POS/PAR EXCLUDING written-off loans plus the
    write-off book separately (wo_pos_eom / wo_loans_eom). In the live report a
    written-off loan sits in POS **and in every PAR band**, so 'With W/O' folds
    the write-off book into POS, loan count and each PAR numerator.

    The flow measures (demand, collection, slippage, regular-bucket) are stored
    the same way — write-off-excluded, with a *_wo companion carrying the
    write-off portion (chronological: a loan counts in the live book until its
    write-off month). 'With W/O' folds each companion into its base so CE,
    roll-rate and slippage offer both views, matching each live report's toggle.

    If the columns are not present yet the frame is returned untouched
    (i.e. behaves as Excl. W/O) rather than failing.
    """
    if (portfolio or "with") != "with" or "wo_pos_eom" not in df.columns:
        return df
    out = df.copy()
    wo_pos = pd.to_numeric(out["wo_pos_eom"], errors="coerce").fillna(0)
    out["pos_eom"] = pd.to_numeric(out["pos_eom"], errors="coerce").fillna(0) + wo_pos
    for c in ("par0_pos", "par30_pos", "par60_pos", "par90_pos"):
        if c in out.columns:
            out[c] = pd.to_numeric(out[c], errors="coerce").fillna(0) + wo_pos
    if "wo_loans_eom" in out.columns:
        out["loans_eom"] = (pd.to_numeric(out["loans_eom"], errors="coerce").fillna(0)
                            + pd.to_numeric(out["wo_loans_eom"], errors="coerce").fillna(0))
    # Flow measures: base += its write-off portion (both columns present).
    for base, wo in WO_FLOW_PAIRS.items():
        if base in out.columns and wo in out.columns:
            out[base] = (pd.to_numeric(out[base], errors="coerce").fillna(0)
                         + pd.to_numeric(out[wo], errors="coerce").fillna(0))
    return out


def _fy(month_end: pd.Timestamp) -> str:
    """Financial-year label for a month (April → March), e.g. FY25-26."""
    start = month_end.year if month_end.month >= 4 else month_end.year - 1
    return f"FY{str(start)[2:]}-{str(start + 1)[2:]}"


def _mlabel(month_end: pd.Timestamp) -> str:
    return month_end.strftime("%b-%y")


# ── Live / month-end snapshot helpers ────────────────────────────────────────
# rpt_aum_status is the ACTUAL loan book (not a ledger recompute). Its daily
# rows are kept day-by-day, so every completed month leaves a true month-end
# snapshot behind. The pin and overlay read it via SQL GROUP BY (_read_live_agg),
# never a whole-table load. History is never rescaled: the reference workbook
# likewise keeps the last completed month and the live month as separate columns.

# Rows are keyed by AP#1 alone, or by the (AP#1, AP#2) pair. The key is internal
# (stripped before the response); name/name2 carry the display values.
_KSEP = ""


def _gkey(v) -> str:
    """Group key for a row: a single value, or an AP#1/AP#2 tuple."""
    if isinstance(v, tuple):
        return _KSEP.join(str(x) for x in v)
    return str(v)


def _grouped(df: pd.DataFrame, dims: list):
    """groupby that yields scalar keys for one dim and tuples for two."""
    return df.groupby(dims[0] if len(dims) == 1 else dims)


def _vals(raw) -> list:
    """Parse a comma-separated slicer value (mirrors api/aum.py)."""
    if not raw or raw == "ALL":
        return []
    return [v for v in (x.strip() for x in str(raw).split(",")) if v and v != "ALL"]


def _filter_where(filters: dict, user: dict, cols: set, portfolio=None):
    """Build the WHERE fragment + bind params for slicer filters, data scope and
    (optionally) the portfolio, on a table whose columns are `cols`. Shared by
    the trend aggregation (rpt_trend_full) and the pin aggregation
    (rpt_aum_status), which carry the same filter/scope column names.

    Returns (where_list, params, unsupported) — or (None, None, unsupported) when
    the user cannot be scoped safely (caller must then return nothing).
    """
    where, params, unsupported = [], {}, []
    counter = {"i": 0}

    def add_in(col, values):
        key = f"p{counter['i']}"
        counter["i"] += 1
        where.append(f'"{col}" IN :{key}')
        params[key] = list(values)

    seg = _vals(filters.get("segment"))
    if seg and "business_segment" in cols:
        add_in("business_segment", seg)

    for param, col in TREND_FILTER_COL.items():
        vlist = _vals(filters.get(param))
        if not vlist:
            continue
        if col not in cols:
            unsupported.append(param)
            continue
        if param == "lo":
            vlist = list({v.split(" - ", 1)[0].strip() for v in vlist})
        add_in(col, vlist)
    for param in TREND_FILTER_NOCOL:
        if _vals(filters.get(param)):
            unsupported.append(param)

    level, svals = user_scope(user)          # data scope pushed into SQL
    if level:
        col = LEVEL_COL.get(level)
        if col and col in cols and svals:
            add_in(col, svals)
        else:
            return None, None, unsupported

    # Portfolio: "Excl. W/O" drops written-off loans (mirrors _live_for_portfolio).
    if portfolio is not None and (portfolio or "with") != "with" and "loan_status" in cols:
        where.append("loan_status <> 'Write-off'")
    return where, params, unsupported


def _exec_agg(sql: str, params: dict) -> pd.DataFrame:
    """Run a parameterised aggregation with expanding IN binds; empty on error."""
    stmt = text(sql)
    for k in params:
        stmt = stmt.bindparams(bindparam(k, expanding=True))
    try:
        with reports_conn() as c:
            return pd.read_sql(stmt, c, params=params)
    except Exception:
        return pd.DataFrame()


def _read_trend_agg(dims: list, filters: dict, user: dict):
    """SQL-aggregate rpt_trend_full to (month_end × dims) grain, summing the
    measure components. Filters and the user's data scope are pushed into the
    WHERE clause, so only the needed slice is read — rpt_trend_full is ~0.6M
    rows and loading it whole per request would be far too slow.

    Returns (DataFrame, unsupported[]). Unsupported = filters the user set that
    rpt_trend_full has no column for (reported, applied to neither trend nor pin).
    """
    cols = _trend_columns()
    dims = [d for d in dims if d in cols]          # never reference a missing column
    where, params, unsupported = _filter_where(filters, user, cols)
    if where is None:                              # unscopable → nothing
        return pd.DataFrame(), unsupported

    sums = ", ".join(f'sum("{c}") AS {c}' for c in TREND_COMPONENTS if c in cols)
    dimsql = "".join(f'"{d}", ' for d in dims)
    sql = f"SELECT month_end, {dimsql}{sums} FROM rpt_trend_full"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " GROUP BY month_end" + "".join(f', "{d}"' for d in dims)
    return _exec_agg(sql, params), unsupported


# Columns the pin reads from rpt_aum_status (see LIVE_ANCHOR).
LIVE_COMPONENTS = ["total_pos", "loan_count", "par0_pos", "par30_pos", "par90_pos"]


def _live_value_from(comp: dict, measure: str) -> float:
    """Measure value from a dict of summed rpt_aum_status components."""
    num_c, den_c = LIVE_ANCHOR[measure]
    n = float(comp.get(num_c, 0) or 0)
    if den_c is None:
        return round(n, 2)
    d = float(comp.get(den_c, 0) or 0)
    return round(n / d * 100, 2) if d > 0 else 0.0


def _read_live_agg(dims: list, filters: dict, portfolio, user, report_day=None):
    """SQL-aggregate rpt_aum_status to per-group component sums for the pin —
    replacing the old whole-table (40k-row) load with a GROUP BY that returns
    ~one row per group. Same filters/scope/portfolio the trend series used.

    Returns (by_group: {gkey: {comp: val}}, grand: {comp: val}, asof: Timestamp
    or None). report_day=None → latest day; else that specific snapshot day.
    """
    cols = _aum_columns()
    dims = [d for d in dims if d in cols]
    where, params, _ = _filter_where(filters, user, cols, portfolio=portfolio)
    if where is None:
        return {}, {}, None
    if report_day is None:
        where.append("report_day = (SELECT max(report_day) FROM rpt_aum_status)")
    else:
        where.append("report_day = :rday")
        params["rday"] = report_day
    # The pin must represent the LIVE book, exactly like Current Outstanding.
    # rpt_aum_status also carries movement-only rows (on-book at prev month-end but
    # closed during the current month) for OD Status / Bucket Movement; without this
    # guard they inflated the pinned point (e.g. 94,119 live -> 94,397 pinned).
    if "open_now" in cols:
        where.append("open_now IS TRUE")

    sums = ", ".join(f'sum("{c}") AS {c}' for c in LIVE_COMPONENTS if c in cols)
    dimsql = "".join(f'"{d}", ' for d in dims)
    asof = ", max(as_of_date) AS asof" if "as_of_date" in cols else ""
    sql = f"SELECT {dimsql}{sums}{asof} FROM rpt_aum_status WHERE " + " AND ".join(where)
    if dims:
        sql += " GROUP BY " + ", ".join(f'"{d}"' for d in dims)
    df = _exec_agg(sql, params)
    if df.empty:
        return {}, {}, None

    comps = [c for c in LIVE_COMPONENTS if c in df.columns]
    by_group, grand = {}, {c: 0.0 for c in comps}
    for _, r in df.iterrows():
        cd = {c: float(r[c] or 0) for c in comps}
        for c in comps:
            grand[c] += cd[c]
        if dims:
            key = _KSEP.join(str(r[d]) for d in dims)
            by_group[key] = cd
    ts = pd.to_datetime(df["asof"]).max() if "asof" in df.columns else None
    asof_date = (ts - pd.Timedelta(days=1)) if pd.notna(ts) else None
    return by_group, grand, asof_date


def _aum_columns() -> set:
    """Actual columns of rpt_aum_status (cached)."""
    if _aum_columns._cache is None:
        try:
            with reports_conn() as c:
                _aum_columns._cache = set(
                    pd.read_sql("SELECT * FROM rpt_aum_status LIMIT 0", c).columns)
        except Exception:
            _aum_columns._cache = set()
    return _aum_columns._cache


_aum_columns._cache = None


def _relabel(rows: list, base_dim: str, label_dim: str, field: str = "name",
             live: pd.DataFrame = None) -> None:
    """Rewrite trend row names to the '<id> - NAME' labels used by the AP table.

    rpt_trend_full stores the plain name (branch_name / lo_id); rpt_aum_status
    carries the matching *_label / lo_name for the same value, so one lookup
    keeps the two tables' labels identical. `live` is the already-read
    rpt_aum_status (shared with the pin so it is fetched once per request).
    """
    if live is None:
        cols = _aum_columns()
        if base_dim not in cols or label_dim not in cols:
            return
        df = _exec_agg(
            f'SELECT DISTINCT "{base_dim}", "{label_dim}" FROM rpt_aum_status '
            "WHERE report_day = (SELECT max(report_day) FROM rpt_aum_status)", {})
        if df.empty:
            return
        m = (df.astype(str).drop_duplicates(subset=[base_dim])
             .set_index(base_dim)[label_dim].to_dict())
    else:
        if base_dim not in live.columns or label_dim not in live.columns:
            return
        m = (live[[base_dim, label_dim]].astype(str)
             .drop_duplicates(subset=[base_dim]).set_index(base_dim)[label_dim].to_dict())
    for r in rows:
        if field in r:
            r[field] = m.get(str(r[field]), r[field])


def _month_end_days() -> dict:
    """{month_end -> report_day} for report_days that captured a true month end.

    A run stamped report_day D holds data as of D-1, so the month-end snapshot
    for month M is the run of the day AFTER M's last day. Only exact matches
    are used — a mid-month run is not a month end.
    """
    out = {}
    for d in report_days("rpt_aum_status"):
        data_date = pd.Timestamp(d) - pd.Timedelta(days=1)
        if data_date == data_date + pd.offsets.MonthEnd(0):
            out[data_date] = d
    return out


def _overlay_snapshots(rows, grand, months, measure, dims, portfolio,
                       filters, user) -> int:
    """Replace reconstructed months with real month-end snapshots where we have
    them, aggregating each snapshot day in SQL (GROUP BY dim). Only stock
    measures (LIVE_ANCHOR) exist in rpt_aum_status; flows keep the ledger
    figures. Returns how many months were replaced."""
    if measure not in LIVE_ANCHOR:
        return 0
    wanted = {m: d for m, d in _month_end_days().items() if m in set(months)}
    if not wanted:
        return 0
    idx_of = {m: i for i, m in enumerate(months)}
    done = 0
    for m_end, day in wanted.items():
        by_group, grand_comp, _ = _read_live_agg(dims, filters, portfolio, user,
                                                 report_day=day)
        if not grand_comp:
            continue
        i = idx_of[m_end]
        live_vals = {k: _live_value_from(c, measure) for k, c in by_group.items()}
        for r in rows:
            if r["_k"] in live_vals:
                r["values"][i] = live_vals[r["_k"]]
        grand[i] = _live_value_from(grand_comp, measure)
        done += 1
    return done


def _append_live_point(rows, grand, months, labels, measure, dims, portfolio,
                       filters, user, fy=None) -> bool:
    """Add the live report as its own current-month point.

    The trend's last point is the last COMPLETED month; the live report is as of
    T-1 in the CURRENT month. Writing the live value onto the last completed
    month would both destroy that month's real figure and mislabel the live one,
    so it is appended as a separate point (replacing only a same-month point).

    The live month belongs to exactly one financial year, so when a single FY is
    selected it is only added to THAT year — otherwise the current month would
    show up at the end of every past FY. The per-group live values come from a
    SQL GROUP BY on rpt_aum_status (not a whole-table load).
    """
    by_group, grand_comp, asof = _read_live_agg(dims, filters, portfolio, user)
    if asof is None or not grand_comp:
        return False

    m_end = asof + pd.offsets.MonthEnd(0)
    if fy and _fy(m_end) != fy:
        return False
    live_vals = {k: _live_value_from(c, measure) for k, c in by_group.items()}

    if months and months[-1] == m_end:
        i = len(months) - 1                      # live supersedes a partial month
    else:
        months.append(m_end)
        labels.append(_mlabel(m_end))
        grand.append(None)
        for r in rows:
            r["values"].append(None)
        i = len(months) - 1
        known = {r["_k"] for r in rows}
        for key in live_vals:                    # groups that exist only now
            if key not in known:
                parts = key.split(_KSEP)
                row = {"_k": key, "name": parts[0], "values": [None] * len(months)}
                if len(dims) > 1:
                    row["name2"] = parts[1] if len(parts) > 1 else ""
                rows.append(row)

    for r in rows:
        if r["_k"] in live_vals:
            r["values"][i] = live_vals[r["_k"]]
    grand[i] = _live_value_from(grand_comp, measure)
    return True


# ── Flow-measure live current-month (PARTIAL) point ──────────────────────────
# Flow measures are NOT in LIVE_ANCHOR because the current month is a PARTIAL
# (MTD-through-T-1) month. But each report page already shows that partial month
# as its headline KPI, so the trend should carry it too — clearly marked partial.
# Each flow measure is sourced from the SAME report table its page's KPI reads,
# so the trend's appended point equals the KPI card by construction.
# (table, numerator col, denominator col or None). "__count__" -> COUNT(*).
FLOW_LIVE: dict = {
    "ce_pct":            ("rpt_collection",   "mtd_collection", "mtd_demand"),
    "demand":            ("rpt_collection",   "mtd_demand",     None),
    "collection":        ("rpt_collection",   "mtd_collection", None),
    "collection_capped": ("rpt_collection",   "mtd_ontime",     None),
    "disb_amount":       ("rpt_disbursement", "disb_amount",    None),
    "disb_count":        ("rpt_disbursement", "disb_count",     None),
    "slip_pos":          ("rpt_od_slippage",  "pos",            None),
    "slip_count":        ("rpt_od_slippage",  "__count__",      None),
    # No KPI table carries these MTD figures, so the pipeline computes them into
    # rpt_mtd_flow (current-month recovery + par>60 collection by segment/branch/lo).
    # Degrades to no July point until the DBA creates the table + pipeline runs.
    "wo_recovery":       ("rpt_mtd_flow",     "mtd_wo_recovery",      None),
    "par60_collection":  ("rpt_mtd_flow",     "mtd_par60_collection", None),
}
# Extra WHERE to isolate the current month's slice within a multi-period table.
# rpt_od_slippage also carries loans that slipped and were then written off
# (in_od_matrix = FALSE, added 2026-08-13). slip_pos / slip_count and roll_rate
# must stay on the OD Status matrix basis, which drops write-offs — so they are
# filtered here rather than at each call site.
FLOW_EXTRA_WHERE: dict = {"rpt_disbursement": "period_type = 'MTD'",
                          "rpt_od_slippage": "in_od_matrix IS TRUE"}
_FLOW_COLS_CACHE: dict = {}


def _flow_columns(table: str) -> set:
    if table not in _FLOW_COLS_CACHE:
        try:
            with reports_conn() as c:
                _FLOW_COLS_CACHE[table] = set(
                    pd.read_sql(f"SELECT * FROM {table} LIMIT 0", c).columns)
        except Exception:
            _FLOW_COLS_CACHE[table] = set()
    return _FLOW_COLS_CACHE[table]


def _read_flow_agg(table, num_col, den_col, dims, filters, portfolio, user):
    """SQL-aggregate a flow report table (latest report_day) to per-group
    numerator/denominator sums — same scope / filters / portfolio the trend used.
    Returns (by_group {gkey: (num, den)}, (grand_num, grand_den), asof_date)."""
    cols = _flow_columns(table)
    # Table absent (e.g. rpt_mtd_flow before the DBA creates it) or the measure's
    # column missing → degrade to no live point rather than erroring.
    if not cols or (num_col != "__count__" and num_col not in cols):
        return {}, (0.0, 0.0), None
    dims = [d for d in dims if d in cols]
    where, params, _ = _filter_where(filters, user, cols, portfolio=portfolio)
    if where is None:
        return {}, (0.0, 0.0), None
    if "report_day" in cols:                       # day-stamped tables → latest day;
        where.append(f"report_day = (SELECT max(report_day) FROM {table})")
    if table in FLOW_EXTRA_WHERE:                   # rpt_mtd_flow is a replace snapshot
        where.append(FLOW_EXTRA_WHERE[table])
    num_sql = "count(*)" if num_col == "__count__" else f'sum("{num_col}")'
    sel = f"{num_sql} AS _num" + (f', sum("{den_col}") AS _den' if den_col else "")
    dimsql = "".join(f'"{d}", ' for d in dims)
    sql = (f"SELECT {dimsql}{sel}, max(report_day) AS _rday FROM {table} WHERE "
           + " AND ".join(where))
    if dims:
        sql += " GROUP BY " + ", ".join(f'"{d}"' for d in dims)
    df = _exec_agg(sql, params)
    if df.empty:
        return {}, (0.0, 0.0), None
    by_group, gnum, gden = {}, 0.0, 0.0
    for _, r in df.iterrows():
        n = float(r["_num"] or 0)
        d = float(r["_den"] or 0) if den_col else 0.0
        gnum += n
        gden += d
        if dims:
            by_group[_KSEP.join(str(r[dm]) for dm in dims)] = (n, d)
    rday = pd.to_datetime(df["_rday"]).max()
    asof = (rday - pd.Timedelta(days=1)) if pd.notna(rday) else None
    return by_group, (gnum, gden), asof


def _flow_value(nd, measure):
    n, d = nd
    if MEASURES[measure][0] == RATIO:
        return round(n / d * 100, 2) if d > 0 else 0.0
    return round(n, 2)


def _read_regular_pos_last_month(dims, filters, user):
    """Regular (dpd=0) POS at the last COMPLETED month-end from rpt_trend_full —
    the denominator for a live roll_rate July point. Regular POS = pos_eom −
    par0_pos, which is PORTFOLIO-INVARIANT (a written-off loan sits in par0, never
    Regular, so the With-W/O fold cancels). Returns (by_group {gkey: reg}, grand)."""
    cols = _trend_columns()
    dims = [d for d in dims if d in cols]
    where, params, _ = _filter_where(filters, user, cols)
    if where is None:
        return {}, 0.0
    where.append("month_end = (SELECT max(month_end) FROM rpt_trend_full)")
    dimsql = "".join(f'"{d}", ' for d in dims)
    sql = (f'SELECT {dimsql}sum("pos_eom") - sum("par0_pos") AS _reg '
           f'FROM rpt_trend_full WHERE ' + " AND ".join(where))
    if dims:
        sql += " GROUP BY " + ", ".join(f'"{d}"' for d in dims)
    df = _exec_agg(sql, params)
    by_group, grand = {}, 0.0
    for _, r in df.iterrows():
        v = float(r["_reg"] or 0)
        grand += v
        if dims:
            by_group[_KSEP.join(str(r[d]) for d in dims)] = v
    return by_group, grand


def _append_flow_live_point(rows, grand, months, labels, measure, dims,
                            portfolio, filters, user, fy=None) -> bool:
    """Append the current (partial) MTD month for a flow measure. Same append
    mechanics as the stock pin; caller flags the point partial for the UI."""
    if measure == "roll_rate":
        # roll_rate = fresh-slippage POS ÷ Regular POS at the prior month-end.
        # Numerator = live July slip POS (rpt_od_slippage); denominator = Regular
        # POS at the last completed trend month (rpt_trend_full).
        num_bg, (ng, _), asof = _read_flow_agg(
            "rpt_od_slippage", "pos", None, dims, filters, portfolio, user)
        if asof is None:
            return False
        den_bg, dg = _read_regular_pos_last_month(dims, filters, user)
        vals = {k: round(num_bg[k][0] / den_bg[k] * 100, 2)
                for k in num_bg if den_bg.get(k, 0) > 0}
        grand_val = round(ng / dg * 100, 2) if dg > 0 else 0.0
    else:
        table, num_col, den_col = FLOW_LIVE[measure]
        by_group, grand_nd, asof = _read_flow_agg(
            table, num_col, den_col, dims, filters, portfolio, user)
        if asof is None:
            return False
        vals = {k: _flow_value(nd, measure) for k, nd in by_group.items()}
        grand_val = _flow_value(grand_nd, measure)
    m_end = asof + pd.offsets.MonthEnd(0)
    if fy and _fy(m_end) != fy:
        return False
    if months and months[-1] == m_end:
        i = len(months) - 1                          # supersede a same-month point
    else:
        months.append(m_end)
        labels.append(_mlabel(m_end))
        grand.append(None)
        for r in rows:
            r["values"].append(None)
        i = len(months) - 1
        known = {r["_k"] for r in rows}
        for key in vals:                             # groups that exist only now
            if key not in known:
                parts = key.split(_KSEP)
                row = {"_k": key, "name": parts[0], "values": [None] * len(months)}
                if len(dims) > 1:
                    row["name2"] = parts[1] if len(parts) > 1 else ""
                rows.append(row)
    for r in rows:
        if r["_k"] in vals:
            r["values"][i] = vals[r["_k"]]
    grand[i] = grand_val
    return True


@router.get("/trend/series")
def trend_series(
    measure: str = Query("pos"),
    group_by: str = Query("business_segment", description="AP#1 — accepts the page's *_label dims too"),
    group_by_2: Optional[str] = Query(None, description="AP#2 — optional second split ('none' = off)"),
    fy: Optional[str] = Query(None, description="FY filter, e.g. FY25-26; blank = all years"),
    window: Optional[int] = Query(None, description="last N months (12/24/36/48/60); overrides fy"),
    pin: bool = Query(True, description="anchor the latest point to the live report (AUM measures)"),
    portfolio: str = Query("with", description="with | excl — include or exclude written-off loans"),
    segment: Optional[str] = Query(None),
    zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    lo: Optional[str] = Query(None),
    branch_state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    prod_class: Optional[str] = Query(None),
    od_bucket: Optional[str] = Query(None),
    od_movement: Optional[str] = Query(None),
    bucket_movement: Optional[str] = Query(None),
    loan_status: Optional[str] = Query(None),
    disb_year: Optional[str] = Query(None),
    cycle: Optional[str] = Query(None),
    purpose: Optional[str] = Query(None),
    facility: Optional[str] = Query(None),
    lender: Optional[str] = Query(None),
    caste: Optional[str] = Query(None),
    religion: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    if measure not in MEASURES:
        return {"error": f"unknown measure; choose {sorted(MEASURES)}"}

    filters = {
        "segment": segment, "zone": zone, "cluster": cluster, "region": region,
        "area": area, "branch": branch, "lo": lo, "branch_state": branch_state,
        "district": district, "prod_class": prod_class, "od_bucket": od_bucket,
        "od_movement": od_movement, "bucket_movement": bucket_movement,
        "loan_status": loan_status, "disb_year": disb_year, "cycle": cycle,
        "purpose": purpose, "facility": facility, "lender": lender,
        "caste": caste, "religion": religion,
    }
    tcols = _trend_columns()
    unsupported = []

    def _resolve(dim, fallback):
        """AP dim -> (trend column, label column). Falls back when unsupported
        or the column is not (yet) present in rpt_trend_full."""
        if not dim or dim == "none":
            return None, None
        base = DIM_ALIAS.get(dim, dim)
        if base in GROUP_DIMS and base in tcols:
            return base, (dim if dim in DIM_ALIAS else None)
        if dim in TREND_UNSUPPORTED_DIMS or base not in tcols:
            unsupported.append(dim)
        return fallback, None

    group_by, label_dim = _resolve(group_by, "business_segment")
    group_by_2, label_dim2 = _resolve(group_by_2, None)
    if group_by_2 == group_by:                   # same dim twice adds nothing
        group_by_2, label_dim2 = None, None

    dims = [group_by] + ([group_by_2] if group_by_2 else [])
    df, ignored = _read_trend_agg(dims, filters, user)
    unsupported.extend(ignored)
    if df.empty:
        live_fy0 = _fy(pd.Timestamp.today().normalize() - pd.Timedelta(days=1))
        return {"months": [], "labels": [], "fys": [live_fy0], "rows": [],
                "grand": [], "unsupported": sorted(set(unsupported))}

    df["month_end"] = pd.to_datetime(df["month_end"])
    df = _apply_portfolio(df, portfolio)

    df["fy"] = df["month_end"].map(_fy)
    # The live point's FY must be selectable even when the ledger has not yet
    # reached it (e.g. trend ends Mar-26 while the live month is Apr-26).
    live_fy = _fy(pd.Timestamp.today().normalize() - pd.Timedelta(days=1))
    all_fys = sorted(set(df["fy"].unique().tolist()) | {live_fy})
    # window (rolling last-N-months) takes precedence over a single-FY filter
    if window and window > 0:
        keep = sorted(df["month_end"].unique())[-window:]
        df = df[df["month_end"].isin(keep)]
    elif fy and fy in all_fys:
        df = df[df["fy"] == fy]
    # An empty selection is still worth building when the live point belongs to
    # it — the current FY may have no completed month in the ledger yet.
    if df.empty and not (fy == live_fy and not window):
        return {"months": [], "labels": [], "fys": all_fys, "rows": [], "grand": []}

    kind, num, den = MEASURES[measure]
    months = sorted(df["month_end"].unique().tolist())
    mi = {m: i for i, m in enumerate(months)}

    def _measure(n, d):
        """Vectorised measure from numerator/denominator Series (or scalars)."""
        n = pd.Series(n, dtype="float64") if not isinstance(n, pd.Series) else n.astype(float)
        if kind == SUM:
            return n.round(2)
        d = pd.Series(d, dtype="float64") if not isinstance(d, pd.Series) else d.astype(float)
        if kind == INV:
            v = (d - n).clip(lower=0) * 100.0 / d
        elif kind == CAPPED:
            v = n.clip(upper=d) * 100.0 / d
        else:                                       # RATIO
            v = n * 100.0 / d
        return v.where(d > 0, 0.0).round(2)

    # df is already at (month × dims) grain, so the measure is computed per row
    # in one vectorised pass — no nested groupby / per-cell .sum() (which was
    # 27k tiny sums ≈ 7s for a high-cardinality group dim).
    df = df.copy()
    df["_val"] = _measure(df[num], df[den] if den else None).values

    rows = []
    for key, g in _grouped(df, dims):
        by_m = dict(zip(g["month_end"], g["_val"]))
        parts = key if isinstance(key, tuple) else (key,)
        vals = [None] * len(months)
        for m, v in by_m.items():
            vals[mi[m]] = None if pd.isna(v) else float(v)
        row = {"_k": _gkey(key), "name": str(parts[0]), "values": vals}
        if group_by_2:
            row["name2"] = str(parts[1])
        rows.append(row)

    # Grand total: sum the components ACROSS groups per month, THEN form the
    # ratio (never an average of per-group ratios).
    gnum = df.groupby("month_end")[num].sum()
    gden = df.groupby("month_end")[den].sum() if den else None
    gvals = _measure(gnum, gden)
    grand = [None if pd.isna(gvals.get(m)) else float(gvals.get(m, 0)) for m in months]
    labels = [_mlabel(m) for m in months]

    # The pin, the snapshot overlay and the "<id> - NAME" relabel all read
    # rpt_aum_status via SQL GROUP BY / DISTINCT now — no whole-table load.
    snapped = _overlay_snapshots(rows, grand, months, measure, dims, portfolio,
                                 filters, user)

    pinned = False
    if pin and measure in LIVE_ANCHOR and months:
        pinned = _append_live_point(rows, grand, months, labels, measure, dims,
                                    portfolio, filters, user,
                                    fy=fy if not window else None)

    # Flow measures: append the current (partial) MTD month, flagged partial so
    # the UI can dash it and label it "MTD". Only when the current month falls in
    # the selected FY / window (else a past FY would gain a stray July point).
    partial_last = False
    if pin and (measure in FLOW_LIVE or measure == "roll_rate") and months:
        partial_last = _append_flow_live_point(
            rows, grand, months, labels, measure, dims,
            portfolio, filters, user, fy=fy if not window else None)

    # Show the same "<id> - NAME" labels the Analysis Parameter table uses.
    if label_dim:
        _relabel(rows, group_by, label_dim)
    if label_dim2:
        _relabel(rows, group_by_2, label_dim2, field="name2")
    rows.sort(key=lambda r: (r["name"], r.get("name2") or ""))
    for r in rows:                                # internal grouping key
        r.pop("_k", None)
    return {
        "months": [m.strftime("%Y-%m-%d") for m in months],
        "labels": labels,
        "fys": all_fys,
        "rows": rows,
        "grand": grand,
        "pinned": pinned,
        "partial_last": partial_last,
        "live_label": labels[-1] if (pinned or partial_last) else None,
        "snapshot_months": snapped,
        # AP dims / slicers the trend cannot honour (rpt_trend_full has no such
        # column). Surfaced so the UI states it rather than silently showing an
        # unfiltered trend.
        "unsupported": sorted(set(unsupported)),
        "group_by": group_by,
    }


@router.get("/trend/monthly")
def trend_monthly_full(
    pin: bool = Query(True),
    portfolio: str = Query("with", description="with | excl — include or exclude written-off loans"),
    segment: Optional[str] = Query(None),
    zone: Optional[str] = Query(None),
    cluster: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    area: Optional[str] = Query(None),
    branch: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    """Monthly Trend page feed — full history (all months) from rpt_trend_full,
    emitted in the same column shape the page already consumes so the page can
    roll it up to Monthly / Quarterly / FY.

    Uses the SAME engine as every other trend section (calc symmetry), and the
    the live report is appended as its own current-month row (see
    _append_live_point) rather than overwriting the last completed month.
    """
    filters = {"segment": segment, "zone": zone, "cluster": cluster,
               "region": region, "area": area, "branch": branch}
    df, _ = _read_trend_agg([], filters, user)      # month-grain, scoped, in SQL
    if df.empty:
        return []
    df["month_end"] = pd.to_datetime(df["month_end"])
    df = _apply_portfolio(df, portfolio)

    g = df.groupby("month_end", as_index=False).agg(
        total_pos=("pos_eom", "sum"),
        total_loans=("loans_eom", "sum"),
        par0_pos=("par0_pos", "sum"),
        par30_pos=("par30_pos", "sum"),
        par90_pos=("par90_pos", "sum"),
        demand=("demand", "sum"),
        collection=("collection_capped", "sum"),   # capped per loan-month = CE numerator
        disb_amount=("disb_amount", "sum"),
        disb_count=("disb_count", "sum"),
    ).sort_values("month_end")

    # aum_status component -> this endpoint's stock column.
    LIVE_TO_G = {"total_pos": "total_pos", "loan_count": "total_loans",
                 "par0_pos": "par0_pos", "par30_pos": "par30_pos",
                 "par90_pos": "par90_pos"}

    # Real month-end snapshots replace the ledger recompute where available
    # (aggregated per day in SQL, no whole-table load).
    wanted = {m: d for m, d in _month_end_days().items() if m in set(g["month_end"])}
    for m_end, day in wanted.items():
        _, comp, _ = _read_live_agg([], filters, portfolio, user, report_day=day)
        if not comp:
            continue
        for lc, gc in LIVE_TO_G.items():
            g.loc[g["month_end"] == m_end, gc] = float(comp.get(lc, 0))

    # The live report is the CURRENT (part-)month — appended as its own row, not
    # written over the last completed month, and history is never rescaled.
    # Flow columns (demand/collection/disbursement) stay blank for it.
    if pin and len(g):
        _, comp, asof = _read_live_agg([], filters, portfolio, user)
        if comp and asof is not None:
            m_end = asof + pd.offsets.MonthEnd(0)
            vals = {gc: float(comp.get(lc, 0)) for lc, gc in LIVE_TO_G.items()}
            if g["month_end"].iloc[-1] == m_end:
                for c, v in vals.items():
                    g.loc[g.index[-1], c] = v
            else:
                row = {c: 0.0 for c in g.columns}
                row["month_end"] = m_end
                row.update(vals)
                g = pd.concat([g, pd.DataFrame([row])], ignore_index=True)

    out = []
    for _, r in g.iterrows():
        m = r["month_end"]
        out.append({
            "m_key": m.strftime("%Y-%m"),
            "m_label": m.strftime("%b-%y"),
            "total_pos": round(float(r["total_pos"]), 2),
            "total_loans": int(round(float(r["total_loans"]))),
            "par0_pos": round(float(r["par0_pos"]), 2),
            "par30_pos": round(float(r["par30_pos"]), 2),
            "par90_pos": round(float(r["par90_pos"]), 2),
            "par0_count": 0, "par30_count": 0, "par90_count": 0,
            "demand": round(float(r["demand"]), 2),
            "collection": round(float(r["collection"]), 2),
            "disb_amount": round(float(r["disb_amount"]), 2),
            "disb_count": int(round(float(r["disb_count"]))),
        })
    return out
