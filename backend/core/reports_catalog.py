"""
core/reports_catalog.py — the canonical list of dashboard reports.

Used for per-user report visibility control:
  * /auth/reports returns this catalog to the admin UI (checkbox list).
  * user_reports rows whitelist keys per user (no rows = all allowed).
  * The API gate maps request paths to a report key via PATH_REPORT_MAP
    and rejects calls to reports outside the user's whitelist.

Keys deliberately match the frontend route slugs.
"""

REPORT_CATALOG: list[dict] = [
    {"key": "exec_summary",    "label": "Executive Summary",   "path": "/dashboard"},
    {"key": "aum",             "label": "Current Outstanding", "path": "/dashboard/aum"},
    {"key": "aum_live",        "label": "AUM — DPD Detail",    "path": "/dashboard/aum-live"},
    {"key": "ageing",          "label": "Ageing Analysis",     "path": "/dashboard/ageing"},
    {"key": "od_status",       "label": "OD Status",           "path": "/dashboard/od-status"},
    {"key": "od_slippage",     "label": "OD Slippage",         "path": "/dashboard/od-slippage"},
    {"key": "dq_category",     "label": "DQ Category",         "path": "/dashboard/dq-category"},
    {"key": "daily",           "label": "T-1 Collection",      "path": "/dashboard/daily"},
    {"key": "mtd",             "label": "MTD Collection",      "path": "/dashboard/mtd"},
    {"key": "cashless",        "label": "Cashless Collection", "path": "/dashboard/cashless"},
    {"key": "disbursement",    "label": "Disbursement",        "path": "/dashboard/disbursement"},
    {"key": "pos_par",         "label": "POS & PAR",           "path": "/dashboard/pos-par"},
    {"key": "par60_collection","label": "PAR 60 Collection",   "path": "/dashboard/par60-collection"},
    # The Delinquencies PAGE was removed from the frontend on 2026-08-26 — PAR
    # tracking and fresh slippage are covered by OD Status and OD Slippage. The
    # key stays so /api/delinquencies remains grantable and reachable: the table
    # and the endpoint are untouched and are expected to be reused elsewhere.
    # Its `path` therefore has no route behind it today.
    {"key": "delinquencies",   "label": "Delinquencies (data only)", "path": "/dashboard/delinquencies"},
    {"key": "bucket_movement", "label": "Bucket Movement",     "path": "/dashboard/bucket-movement"},
    {"key": "case_movement",   "label": "Case Movement",       "path": "/dashboard/case-movement"},
    {"key": "writeoff",        "label": "Write-Off",           "path": "/dashboard/writeoff"},
    {"key": "trend",           "label": "Monthly Trend",       "path": "/dashboard/trend"},
    {"key": "aml",             "label": "AML Risk Category",   "path": "/dashboard/aml"},
    {"key": "ots",             "label": "OTS & Recovery",      "path": "/dashboard/ots"},
    {"key": "portfolio_cuts",  "label": "Portfolio Cuts",      "path": "/dashboard/portfolio-cuts"},
    {"key": "vintage",         "label": "Vintage Curve",       "path": "/dashboard/vintage"},
    {"key": "origination_funnel", "label": "Origination Funnel", "path": "/dashboard/origination-funnel"},
    {"key": "credit_bureau",   "label": "Credit Bureau & Sourcing", "path": "/dashboard/credit-bureau"},
]

REPORT_KEYS = [r["key"] for r in REPORT_CATALOG]

# API path prefix → report key(s) that grant access to it.
# Longest prefix wins. Prefixes not listed (auth, filters, health) are open
# to any authenticated user. Endpoints shared by several pages list every
# report that legitimately calls them.
PATH_REPORT_MAP: list[tuple[str, set]] = [
    ("/api/od-slippage",     {"od_slippage"}),
    ("/api/od-status",       {"od_status"}),
    ("/api/dq-category",     {"dq_category"}),
    ("/api/aum-live",        {"aum_live"}),
    ("/api/ageing",          {"ageing"}),
    ("/api/bucket-movement", {"bucket_movement"}),
    ("/api/case-movement",   {"case_movement"}),
    ("/api/delinquencies",   {"delinquencies"}),
    ("/api/cashless",        {"cashless"}),
    ("/api/trend-monthly",   {"trend"}),
    # trend sections are embedded on their host pages — any host report grants
    ("/api/trend/",          {"aum", "disbursement", "mtd", "od_slippage",
                              "bucket_movement", "writeoff", "delinquencies",
                              "trend", "exec_summary",
                              # PAR 60 Collection reads its WHOLE page from the
                              # trend engine (measure=par60_collection), not
                              # just an embedded section, so it needs this
                              # prefix or every call 403s.
                              "par60_collection"}),
    ("/api/aml",             {"aml"}),
    # Exec Summary reads the bureau + OTS grand totals for its sourcing/recovery
    # band, so exec_summary must also open these (same pattern as /api/trend/).
    ("/api/ots",             {"ots", "exec_summary"}),
    ("/api/portfolio-cuts",  {"portfolio_cuts", "exec_summary"}),
    ("/api/vintage",         {"vintage"}),
    # Ahead of any shorter "/api/origination" entry: report_for_path returns the
    # FIRST prefix that matches in list order, not the longest one.
    ("/api/origination-funnel", {"origination_funnel"}),
    ("/api/credit-bureau",   {"credit_bureau", "exec_summary"}),
    ("/api/pos-par",         {"pos_par"}),
    ("/api/writeoff",        {"writeoff"}),
    ("/api/disbursement",    {"disbursement"}),
    # collection endpoints serve the T-1, MTD and Cashless pages
    ("/api/collection",      {"daily", "mtd", "cashless", "par60_collection"}),
    # aum endpoints serve Exec Summary, Current Outstanding and Monthly Trend
    ("/api/aum",             {"exec_summary", "aum", "trend"}),
]


def report_for_path(path: str):
    """Return the set of report keys that grant access to an API path,
    or None if the path is not report-gated."""
    for prefix, keys in PATH_REPORT_MAP:
        if path.startswith(prefix):
            return keys
    return None
