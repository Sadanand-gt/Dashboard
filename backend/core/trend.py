"""
core/trend.py — Indian fiscal-year trend helpers shared by AUM & Disbursement.

FY convention: April → March.  FY label = ending year, e.g. Apr-2025..Mar-2026
= "FY26".  FY quarters: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar.

build_trend() consumes rpt_trend_monthly-shaped frames (m_key = 'YYYY-MM')
and returns {"fys": [...], "points": [...]} for the trend line charts.

metrics: {output_name: source_column}.
stock=True  → bucket value = LAST month in bucket (AUM / POS style)
stock=False → bucket value = SUM of months     (disbursement / flow style)
"""

import pandas as pd


def _with_fy(df: pd.DataFrame) -> pd.DataFrame:
    dt = pd.to_datetime(df["m_key"], format="%Y-%m")
    fy_end = dt.dt.year + (dt.dt.month >= 4).astype(int)
    return df.assign(
        _dt=dt,
        _fyord=fy_end,
        _fy="FY" + (fy_end % 100).astype(str).str.zfill(2),
        _mi=(dt.dt.month - 4) % 12,          # Apr=0 … Mar=11
        _q=((dt.dt.month - 4) % 12) // 3 + 1,  # FY quarter 1..4
        _mlabel=dt.dt.strftime("%b-%y"),
        _mname=dt.dt.strftime("%b"),
    )


def _bucket_value(g: pd.DataFrame, col: str, stock: bool) -> float:
    if stock:
        return float(g.sort_values("_dt").iloc[-1][col] or 0)
    return float(g[col].sum())


def _growth_series(points: list[dict], key: str) -> None:
    prev = None
    for p in points:
        v = p.get(key) or 0
        p["growth"] = round((v - prev) / prev * 100, 2) if prev else 0.0
        prev = v


def build_trend(
    df: pd.DataFrame,
    freq: str,                 # month | quarter | year
    fy: str | None,            # e.g. "FY26"; None → latest FY in data
    yoy: bool,
    metrics: dict[str, str],   # {"pos": "total_pos", "loans": "total_loans"}
    stock: bool,
) -> dict:
    if df.empty or "m_key" not in df.columns:
        return {"fys": [], "points": []}

    df = _with_fy(df)
    fys = df[["_fy", "_fyord"]].drop_duplicates().sort_values("_fyord")
    fy_labels = fys["_fy"].tolist()
    sel_fy = fy if fy in fy_labels else fy_labels[-1]
    prev_fy_idx = fy_labels.index(sel_fy) - 1
    prev_fy = fy_labels[prev_fy_idx] if prev_fy_idx >= 0 else None

    main_key = next(iter(metrics))  # first metric drives growth / YoY

    # ── YEAR: FY-wise for all available years ────────────────────────────────
    if freq == "year":
        points = []
        for _, g in df.groupby("_fyord", sort=True):
            p = {"period": g.iloc[0]["_fy"]}
            for out, col in metrics.items():
                p[out] = _bucket_value(g, col, stock)
            points.append(p)
        _growth_series(points, main_key)
        return {"fys": fy_labels, "points": points}

    # ── QUARTER ───────────────────────────────────────────────────────────────
    if freq == "quarter":
        qdf = []
        for (fyord, q), g in df.groupby(["_fyord", "_q"], sort=True):
            row = {"_fyord": fyord, "_q": q, "_fy": g.iloc[0]["_fy"]}
            for out, col in metrics.items():
                row[out] = _bucket_value(g, col, stock)
            qdf.append(row)

        if yoy and prev_fy:
            cur = {r["_q"]: r for r in qdf if r["_fy"] == sel_fy}
            prv = {r["_q"]: r for r in qdf if r["_fy"] == prev_fy}
            points = []
            for q in (1, 2, 3, 4):
                c, p = cur.get(q), prv.get(q)
                cv = c[main_key] if c else None
                pv = p[main_key] if p else None
                points.append({
                    "period": f"Q{q}",
                    "cur": cv, "prev": pv,
                    "yoy_pct": round((cv - pv) / pv * 100, 2) if cv and pv else None,
                })
            return {"fys": fy_labels, "points": points,
                    "cur_fy": sel_fy, "prev_fy": prev_fy}

        if fy:  # a specific FY chosen → its quarters
            sel = [r for r in qdf if r["_fy"] == sel_fy]
        else:   # default → last four quarters
            sel = sorted(qdf, key=lambda r: (r["_fyord"], r["_q"]))[-4:]
        points = [
            {"period": f"Q{r['_q']} {r['_fy']}",
             **{m: r[m] for m in metrics}} for r in sel
        ]
        _growth_series(points, main_key)
        return {"fys": fy_labels, "points": points}

    # ── MONTH: FY months starting April ───────────────────────────────────────
    if yoy and prev_fy:
        cur = df[df["_fy"] == sel_fy]
        prv = df[df["_fy"] == prev_fy]
        cur_by = {int(r["_mi"]): r for _, r in cur.iterrows()}
        prv_by = {int(r["_mi"]): r for _, r in prv.iterrows()}
        month_names = ["Apr", "May", "Jun", "Jul", "Aug", "Sep",
                       "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]
        points = []
        for mi, name in enumerate(month_names):
            c, p = cur_by.get(mi), prv_by.get(mi)
            cv = float(c[metrics[main_key]] or 0) if c is not None else None
            pv = float(p[metrics[main_key]] or 0) if p is not None else None
            if cv is None and pv is None:
                continue
            points.append({
                "period": name,
                "cur": cv, "prev": pv,
                "yoy_pct": round((cv - pv) / pv * 100, 2) if cv and pv else None,
            })
        return {"fys": fy_labels, "points": points,
                "cur_fy": sel_fy, "prev_fy": prev_fy}

    sel = df[df["_fy"] == sel_fy].sort_values("_mi")
    points = []
    for _, r in sel.iterrows():
        p = {"period": r["_mlabel"]}
        for out, col in metrics.items():
            p[out] = float(r[col] or 0)
        points.append(p)
    _growth_series(points, main_key)
    return {"fys": fy_labels, "points": points}


def build_daily(
    df: pd.DataFrame,          # rpt_disb_daily: disb_date, disb_count, disb_amount
    fy: str | None,
    metrics: dict[str, str],
) -> dict:
    """Day-wise series within the selected FY (disbursement only).
    Always starts at 1st April of the FY; days with no disbursement are
    zero-filled so the series is gapless through the last data date."""
    if df.empty or "disb_date" not in df.columns:
        return {"fys": [], "points": []}
    dt = pd.to_datetime(df["disb_date"])
    fy_end = dt.dt.year + (dt.dt.month >= 4).astype(int)
    df = df.assign(
        _dt=dt, _fyord=fy_end,
        _fy="FY" + (fy_end % 100).astype(str).str.zfill(2),
    )
    fys = df[["_fy", "_fyord"]].drop_duplicates().sort_values("_fyord")
    fy_labels = fys["_fy"].tolist()
    sel_fy = fy if fy in fy_labels else fy_labels[-1]

    sel = df[df["_fy"] == sel_fy].sort_values("_dt")
    sel_fyord = int(sel.iloc[0]["_fyord"])
    fy_start = pd.Timestamp(year=sel_fyord - 1, month=4, day=1)
    last_day = sel["_dt"].max()

    by_date = {r["_dt"].normalize(): r for _, r in sel.iterrows()}
    points = []
    for d in pd.date_range(fy_start, last_day, freq="D"):
        r = by_date.get(d)
        p = {"period": d.strftime("%d-%b")}
        for out, col in metrics.items():
            p[out] = float(r[col] or 0) if r is not None else 0.0
        points.append(p)
    main_key = next(iter(metrics))
    _growth_series(points, main_key)
    return {"fys": fy_labels, "points": points}
