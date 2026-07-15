// Shared number/currency formatting for report pages.

export function fmtInr(v: number | undefined | null): string {
  if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) return '—'
  const n = Number(v)
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

export function fmtNum(v: number | undefined | null): string {
  return (Number(v) || 0).toLocaleString('en-IN')
}

export function fmtPct(v: number | undefined | null, decimals = 2): string {
  return `${(Number(v) || 0).toFixed(decimals)}%`
}

/** Sum a numeric field across a list of report rows. */
export function sumField(rows: Record<string, unknown>[], key: string): number {
  return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0)
}
