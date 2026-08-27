/**
 * heat.ts — the one conditional-formatting engine for every report page.
 *
 * Shading is RELATIVE TO A BENCHMARK, never to a fixed cutoff. Two absolute
 * rules were removed in favour of this:
 *
 *   StandardReport   `v >= 5 red, v >= 2 amber` on PAR. JLG runs at 17.55% and
 *                    LAP at 3.60%, so it painted nearly every JLG branch red and
 *                    every LAP branch green and said nothing about either.
 *   ceColor()        `v >= 95 green, v >= 85 amber` on collection efficiency —
 *                    the same "target 95%" that was pulled out of the Executive
 *                    Summary for being a guess, still encoded silently in colour.
 *
 * The benchmark is chosen by the caller and MUST be stated on the page:
 *   · grouped two deep  → the MEDIAN of the rows sharing the second dimension,
 *     i.e. the row's own segment. Median, not mean, so one outlier cannot drag
 *     the line it is being judged against.
 *   · otherwise         → the Grand Total, the correctly weighted figure for the
 *     whole report and the only honest single benchmark.
 */

/** Which direction is "good", so shading can mean something.
 *  'bad-high'  — PAR, OD, DPD, slippage: above the benchmark is bad.
 *  'good-high' — CE, recovery, on-time, cashless: above the benchmark is good. */
export type Heat = 'bad-high' | 'good-high'

// Bands are ratios to the benchmark, so one scale travels across percentages,
// rupees and counts. Index 0 is far-better, 4 is far-worse; index 2 is "at the
// benchmark" and is deliberately unpainted so the eye only stops on difference.
export const BAND_MIN = [1.50, 1.15, 0.85, 0.50]
export const BAND_FILL = ['rgba(22,163,74,0.18)', 'rgba(22,163,74,0.10)', 'transparent',
                          'rgba(217,119,6,0.14)', 'rgba(220,38,38,0.18)']
export const BAND_INK = ['#14532D', '#14532D', '#0F172A', '#92400E', '#7F1D1D']
export const BAND_WT: (400 | 500 | 600 | 700)[] = [700, 500, 400, 600, 700]
/** Row spine. Neutral rows get none — a spine on every row is a border, not a signal. */
export const BAND_SPINE = ['#16A34A', '#86EFAC', 'transparent', '#FBBF24', '#DC2626']

/**
 * Which of the five bands a value falls in, or null when it cannot be judged.
 * Always returned on a WORSE-IS-HIGHER axis regardless of the column's own
 * direction, so 4 means "worst" everywhere and the spine reads the same on
 * every page.
 *
 * @param base    the value's own DENOMINATOR, for ratio measures. 0/0 arrives as
 *                0.00% and would otherwise shade as the worst value on the page:
 *                measured 2026-08-22, 15 branches showed a 0.00% sanction ratio
 *                purely because they had screened NO applications. A branch that
 *                did no origination is absent, not failing.
 * @param baseMin smallest denominator worth judging (default 1 — suppresses only
 *                the mathematically undefined case, not a materiality opinion).
 */
export function heatBand(
  value: unknown, benchmark: number | null | undefined, dir: Heat | undefined,
  base?: number | null, baseMin = 1,
): number | null {
  if (!dir) return null
  const v = Number(value ?? 0)
  if (!Number.isFinite(v) || benchmark == null || !Number.isFinite(benchmark) || benchmark === 0) return null
  if (base != null && (!Number.isFinite(Number(base)) || Number(base) < baseMin)) return null
  const ratio = dir === 'bad-high' ? v / benchmark : benchmark / (v || Number.EPSILON)
  const i = BAND_MIN.findIndex((m) => ratio >= m)
  return i === -1 ? 0 : 4 - i
}

/** Cell styling for a band. `filled` is for the PRIMARY column only — every
 *  other shaded column takes colour and weight but no fill, which is what keeps
 *  a four-column PAR block readable instead of one red wash. */
export function heatStyle(band: number | null, filled = false) {
  if (band == null || band === 2) return { color: '#0F172A', fontWeight: 400 as const }
  return {
    ...(filled ? { background: BAND_FILL[band] } : {}),
    color: BAND_INK[band],
    fontWeight: BAND_WT[band],
  }
}

/** Spine colour for a row, or transparent when it cannot be judged. */
export const spineColor = (band: number | null): string =>
  band == null ? 'transparent' : BAND_SPINE[band]

export const median = (xs: number[]): number | null => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return null
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Build the `benchFor(row, field)` lookup a page's shaded cells measure against.
 * Every report re-derives the same two rules, so they live here once:
 *
 *   grouped two deep → the MEDIAN of the rows sharing `name2`, i.e. the row's
 *                      own segment, so a branch is judged against its own book
 *   otherwise        → the Grand Total, the correctly weighted figure
 *
 * `grand` may be null (some reports carry no total row) — the median of all
 * rows is then used, which is still a fair line to judge against.
 */
export function makeBenchFor<T extends { name2?: string | null }>(
  rows: T[], grand: T | null | undefined, fields: string[], hasAp2: boolean,
): (row: T, field: string) => number | null {
  const num = (r: T, f: string) => Number((r as Record<string, unknown>)[f] ?? NaN)
  if (!hasAp2) {
    const m = new Map<string, number | null>()
    for (const f of fields) {
      const g = grand ? num(grand, f) : NaN
      m.set(f, Number.isFinite(g) && g !== 0 ? g : median(rows.map((r) => num(r, f))))
    }
    return (_r, f) => m.get(f) ?? null
  }
  const bySeg = new Map<string, Map<string, number | null>>()
  for (const r of rows) {
    const k = String(r.name2 ?? '—')
    if (bySeg.has(k)) continue
    const grp = rows.filter((x) => String(x.name2 ?? '—') === k)
    const m = new Map<string, number | null>()
    for (const f of fields) m.set(f, median(grp.map((x) => num(x, f))))
    bySeg.set(k, m)
  }
  return (r, f) => bySeg.get(String(r.name2 ?? '—'))?.get(f) ?? null
}

