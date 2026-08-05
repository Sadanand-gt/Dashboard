import type { User } from '../api/types'

// Route path → report key (mirrors backend core/reports_catalog.py)
export const PATH_REPORT_KEY: Record<string, string> = {
  '/dashboard':                 'exec_summary',
  '/dashboard/aum':             'aum',
  '/dashboard/aum-live':        'aum_live',
  '/dashboard/ageing':          'ageing',
  '/dashboard/od-status':       'od_status',
  '/dashboard/od-slippage':     'od_slippage',
  '/dashboard/dq-category':     'dq_category',
  '/dashboard/daily':           'daily',
  '/dashboard/mtd':             'mtd',
  '/dashboard/cashless':        'cashless',
  '/dashboard/disbursement':    'disbursement',
  '/dashboard/pos-par':         'pos_par',
  '/dashboard/delinquencies':   'delinquencies',
  '/dashboard/bucket-movement': 'bucket_movement',
  '/dashboard/case-movement':   'case_movement',
  '/dashboard/writeoff':        'writeoff',
  '/dashboard/trend':           'trend',
  '/dashboard/aml':             'aml',
  '/dashboard/ots':             'ots',
  '/dashboard/credit-bureau':   'credit_bureau',
}

/** Can this user see the report behind a route path?
 *  allowed_reports of ['*'] (or missing — legacy token) = all reports. */
export function canSeePath(user: User | null, path: string): boolean {
  if (!user) return false
  const allowed = user.allowed_reports
  if (!allowed || allowed.includes('*')) return true
  const key = PATH_REPORT_KEY[path]
  return key === undefined || allowed.includes(key)
}

/** First dashboard path the user may open (fallback for redirects). */
export function firstAllowedPath(user: User | null): string {
  for (const path of Object.keys(PATH_REPORT_KEY)) {
    if (canSeePath(user, path)) return path
  }
  return '/login'
}
