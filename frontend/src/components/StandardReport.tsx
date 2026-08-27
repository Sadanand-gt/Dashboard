import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Button from '@mui/material/Button'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import TableSortLabel from '@mui/material/TableSortLabel'
import Tooltip from '@mui/material/Tooltip'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Skeleton from '@mui/material/Skeleton'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import { api } from '../api/client'
import { useSlicerParams } from '../store/filterStore'
import { TrendSection, type TrendMeasure } from './TrendSection'
import { ExportCsvButton } from './ExportCsvButton'
import { heatBand, heatStyle, spineColor, median, type Heat } from './heat'

// ── Config types ──────────────────────────────────────────────────────────────
export type Fmt = 'inr' | 'num' | 'pct'

export interface ColDef {
  field: string
  label: string
  fmt: Fmt
  /** Colour-code the value against the report's own benchmark (higher = worse).
   *  Retained as the shorthand every existing page already passes; it is exactly
   *  `heat: 'bad-high'`. */
  risk?: boolean
  /** Conditional formatting for this column. See `Heat`. Columns without it are
   *  left plain — shading everything shades nothing. */
  heat?: Heat
  /** The one column whose shading drives the row's severity spine and the
   *  exception count. Defaults to the FIRST column carrying heat/risk. Only this
   *  column gets a filled cell; the other shaded columns get weight and colour
   *  but no fill, so four near-identical PAR columns do not become one red wash. */
  primary?: boolean
  /** For a RATIO column: the field holding its DENOMINATOR, and the smallest
   *  denominator worth judging (default 1).
   *
   *  Without this, 0/0 arrives as 0.00% and shades as the worst possible value.
   *  Measured on 2026-08-22: 15 branches showed a 0.00% sanction ratio purely
   *  because they screened NO applications that month — a branch that did no
   *  origination is not a failing branch, it is an absent one, and painting it
   *  red is worse than leaving it plain. */
  base?: { field: string; min?: number }
  /** Shown on hover over the column header. For any measure whose NAME does not
   *  fully define it — a rate needs its denominator stated, and a column that
   *  only covers one loan source has to say so on the column itself, not in a
   *  note somewhere else on the page. */
  hint?: string
}
export interface KpiDef {
  field: string
  label: string
  fmt: Fmt
  variant?: 'default' | 'green' | 'amber' | 'red'
}
export interface VariantDef {
  label: string
  options: { value: string; label: string }[]
}

interface Props {
  title: string
  /** report path prefix, e.g. 'aum-live' → /api/aum-live/summary */
  endpoint: string
  kpis: KpiDef[]
  columns: ColDef[]
  /** measure plotted in the bar chart, by AP#1 */
  chartField: string
  chartLabel: string
  chartFmt: Fmt
  variant?: VariantDef
  note?: string
  /** Show a With / Excl W/O portfolio toggle (reports whose table carries a
   *  loan_status split). Excl W/O drops written-off loans so PAR/POS match Excel. */
  portfolio?: boolean
  /** Optional monthly trend section rendered below the report; it follows this
   *  report's AP#1/AP#2 so the trend groups by the same dimension as the table. */
  trend?: { title: string; measures: TrendMeasure[] }
}

interface Row { name: string; name2?: string; [k: string]: string | number | undefined }
/** Optional single-select filter declared by the report's spec (e.g. Write-off Year).
 *  Options come from the API so they always reflect the user's data scope. */
interface FilterDef { param: string; label: string; options: string[] }
interface Resp {
  rows: Row[]
  grand: Row
  as_of: string | null
  dims: { value: string; label: string }[]
  filter?: FilterDef | null
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmtVal(v: unknown, f: Fmt): string {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return '—'
  if (f === 'pct') return `${n.toFixed(2)}%`
  if (f === 'num') return n.toLocaleString('en-IN')
  const a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
const BAR_COLORS = ['#1565C0', '#0F766E', '#7C3AED', '#D97706', '#DC2626', '#0891B2']

// KPI card tones — the same five variants KpiCard.tsx uses, so a StandardReport
// page and a purpose-built page look like one product.
const KPI_TONE: Record<string, { border: string; accent: string; bg: string; label: string }> = {
  default: { border: '#BFDBFE', accent: '#1565C0', bg: '#EFF6FF', label: '#1E40AF' },
  green:   { border: '#BBF7D0', accent: '#16A34A', bg: '#F0FDF4', label: '#15803D' },
  amber:   { border: '#FDE68A', accent: '#D97706', bg: '#FFFBEB', label: '#B45309' },
  red:     { border: '#FECACA', accent: '#DC2626', bg: '#FEF2F2', label: '#B91C1C' },
}

// Height of the sticky analysis-parameter bar.
const BAR_H = 58

export function StandardReport({
  title, endpoint, kpis, columns, chartField, chartLabel, chartFmt, variant, note, portfolio, trend,
}: Props) {
  // The table is the report; the chart is opt-in and starts hidden so a page
  // costs one screen, not two. Same default as TrendSection.
  const [showCharts, setShowCharts] = useState(false)
  const [ap1, setAp1] = useState('business_segment')
  const [ap2, setAp2] = useState('none')
  const [variantVal, setVariantVal] = useState(variant?.options[0].value ?? '')
  const [portfolioVal, setPortfolioVal] = useState<'with' | 'without'>('with')
  const [pick, setPick] = useState('ALL')
  const [sortBy, setSortBy] = useState<string>(chartField)
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const slicers = useSlicerParams()

  const params = useMemo(() => {
    const p = new URLSearchParams({ group_by: ap1 })
    if (ap2 !== 'none') p.set('group_by_2', ap2)
    if (variant && variantVal) p.set('variant', variantVal)
    if (portfolio) p.set('portfolio', portfolioVal)
    if (pick !== 'ALL') p.set('pick', pick)
    for (const [k, v] of Object.entries(slicers)) p.set(k, v)
    return p.toString()
  }, [ap1, ap2, variantVal, variant, portfolio, portfolioVal, pick, slicers])

  const { data, isLoading } = useQuery<Resp>({
    queryKey: [endpoint, params],
    queryFn: () => api.get(`/api/${endpoint}/summary?${params}`).then((r) => r.data),
  })

  const dims = data?.dims ?? [{ value: 'business_segment', label: 'Business Segment' }]
  const ap2Options = [{ value: 'none', label: '— None —' }, ...dims]
  const pickDef = data?.filter ?? null
  const pickOptions = useMemo(
    () => [{ value: 'ALL', label: `All ${pickDef?.label ?? ''}`.trim() },
           ...(pickDef?.options ?? []).map((o) => ({ value: o, label: o }))],
    [pickDef])
  const hasAp2 = ap2 !== 'none'
  const ap1Label = dims.find((d) => d.value === ap1)?.label ?? 'Group'
  const ap2Label = dims.find((d) => d.value === ap2)?.label ?? ''

  const rows = useMemo(() => {
    const r = [...(data?.rows ?? [])]
    r.sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy]
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''))
      return dir === 'asc' ? cmp : -cmp
    })
    return r
  }, [data, sortBy, dir])

  // Benchmark each shaded column against. Keyed by segment (AP#2 value) when the
  // report is grouped two-deep, so a branch is judged against its own book
  // rather than against a firm-wide average that mixes JLG with LAP; keyed by
  // '' otherwise, holding the Grand Total. See heatStyle.
  const benchmarks = useMemo(() => {
    const shaded = columns.filter((c) => c.heat || c.risk)
    const out = new Map<string, Map<string, number | null>>()
    if (!shaded.length) return out
    const src = data?.rows ?? []
    if (hasAp2) {
      const groups = new Map<string, Row[]>()
      for (const r of src) {
        const k = String(r.name2 ?? '—')
        const g = groups.get(k); g ? g.push(r) : groups.set(k, [r])
      }
      for (const [k, g] of groups) {
        const m = new Map<string, number | null>()
        for (const c of shaded) m.set(c.field, median(g.map((r) => Number(r[c.field] ?? NaN))))
        out.set(k, m)
      }
    } else {
      const m = new Map<string, number | null>()
      for (const c of shaded) {
        const g = data?.grand ? Number(data.grand[c.field] ?? NaN) : NaN
        // Grand Total is the right benchmark when it exists; a report without
        // one still gets a usable line from the median of its own rows.
        m.set(c.field, Number.isFinite(g) && g !== 0
          ? g : median(src.map((r) => Number(r[c.field] ?? NaN))))
      }
      out.set('', m)
    }
    return out
  }, [data, columns, hasAp2])

  const benchFor = (r: Row, field: string): number | null =>
    benchmarks.get(hasAp2 ? String(r.name2 ?? '—') : '')?.get(field) ?? null

  const dirOf = (c: ColDef): Heat | undefined => c.heat ?? (c.risk ? 'bad-high' : undefined)

  // The column that drives the spine and the exception count. Explicit `primary`
  // wins; otherwise the first shaded RATIO column, and only then the first
  // shaded column of any kind.
  //
  // The ratio preference matters: a count is confounded by group size, so a
  // large branch reads "worse" on rejections or slippage purely for being large.
  // A percentage is size-neutral and is the only fair thing to hang a severity
  // spine on. Case Movement is the case in point — first-shaded-column would
  // have picked rejected_mtd (a count) over Sanction % (a rate).
  // The chartField is the page's own declared headline measure, so it wins when
  // it is a directional rate — that is how Cashless lands on MTD Cashless %
  // rather than the noisier single-day T-1 figure. It is skipped when it is a
  // count (Delinquencies charts fresh_slippage) for the size reason above.
  const primaryCol = useMemo(
    () => columns.find((c) => c.primary && dirOf(c))
       ?? columns.find((c) => c.field === chartField && dirOf(c) && c.fmt === 'pct')
       ?? columns.find((c) => dirOf(c) && c.fmt === 'pct')
       ?? columns.find((c) => dirOf(c))
       ?? null,
    [columns, chartField])


  // Per-row band on the primary column, computed once and reused by the spine,
  // the cell and the exception count so the three can never disagree.
  const spineBand = useMemo(() => {
    const m = new Map<Row, number | null>()
    if (!primaryCol) return m
    const dir = dirOf(primaryCol)
    for (const r of rows) m.set(r, heatBand(r[primaryCol.field], benchFor(r, primaryCol.field), dir,
      primaryCol.base ? Number(r[primaryCol.base.field] ?? 0) : null, primaryCol.base?.min))
    return m
  }, [rows, primaryCol, benchmarks, hasAp2])


  // chart: aggregate to AP#1 only, top 8
  const chart = useMemo(() => {
    const by = new Map<string, number>()
    for (const r of data?.rows ?? []) {
      by.set(r.name, (by.get(r.name) ?? 0) + Number(r[chartField] ?? 0))
    }
    return [...by.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
  }, [data, chartField])

  // Export mirrors the visible table exactly — same columns, same order, plus
  // the Grand Total so the file reconciles on its own.
  const exportCols = useMemo<[string, string][]>(() => ([
    ['name', ap1Label] as [string, string],
    ...(hasAp2 ? [['name2', ap2Label] as [string, string]] : []),
    ...columns.map((c) => [c.field, c.label] as [string, string]),
  ]), [ap1Label, ap2Label, hasAp2, columns])

  const exportRows = useMemo(
    () => (rows.length ? [...rows, { ...(data?.grand ?? {}), name: 'Grand Total', name2: '' }] : []),
    [rows, data])

  const sortCell = (field: string, label: string, align: 'left' | 'right' = 'right',
                    sticky = false, hint?: string) => {
    const cell = (
      <TableCell key={field} align={align} sortDirection={sortBy === field ? dir : false}
        sx={{ fontWeight: 700, color: '#1E40AF', fontSize: '0.7rem', whiteSpace: 'nowrap',
              ...(sticky ? { position: 'sticky', left: 0, zIndex: 3, background: '#F8FAFF' } : {}) }}>
        <TableSortLabel active={sortBy === field} direction={sortBy === field ? dir : 'asc'}
          onClick={() => {
            if (sortBy === field) setDir(dir === 'asc' ? 'desc' : 'asc')
            else { setSortBy(field); setDir('desc') }
          }}>
          {label}
        </TableSortLabel>
      </TableCell>
    )
    return hint ? <Tooltip key={field} placement="top" title={hint}>{cell}</Tooltip> : cell
  }

  return (
    <Box className="space-y-2">
      {/* ── Top bar: AP#1 / AP#2 / variant / as-of ───────────────────────── */}
      {/* Frozen to the top: the analysis parameters govern every number below,
          so they must stay visible and changeable while the table scrolls. */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
        position: 'sticky', top: 0, zIndex: 30,
        background: '#FFFFFF', borderRadius: 2, px: 2, py: 0.9,
        border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px -4px rgba(15,23,42,0.28)',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 700, color: '#1E293B' }}>{title}</Box>
        <Box sx={{ width: 1, height: 22, background: 'rgba(0,0,0,0.09)' }} />
        <DimPick label="AP #1" value={ap1} options={dims} onChange={setAp1} />
        <DimPick label="AP #2" value={ap2} options={ap2Options} onChange={setAp2} />
        {pickDef && (
          <>
            <Box sx={{ width: 1, height: 22, background: 'rgba(0,0,0,0.09)' }} />
            <DimPick label={pickDef.label} value={pick} options={pickOptions} onChange={setPick} />
          </>
        )}
        {variant && (
          <>
            <Box sx={{ width: 1, height: 22, background: 'rgba(0,0,0,0.09)' }} />
            <Box>
              <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', mb: 0.3 }}>{variant.label}</Box>
              <ToggleButtonGroup size="small" exclusive value={variantVal}
                onChange={(_, v) => { if (v) setVariantVal(v) }} sx={{ height: 26 }}>
                {variant.options.map((o) => (
                  <ToggleButton key={o.value} value={o.value} sx={{ px: 1.2, fontSize: '0.7rem', textTransform: 'none' }}>{o.label}</ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>
          </>
        )}
        {portfolio && (
          <>
            <Box sx={{ width: 1, height: 22, background: 'rgba(0,0,0,0.09)' }} />
            <Box>
              <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', mb: 0.3 }}>Portfolio</Box>
              <ToggleButtonGroup size="small" exclusive value={portfolioVal}
                onChange={(_, v) => { if (v) setPortfolioVal(v) }} sx={{ height: 26 }}>
                <ToggleButton value="with" sx={{ px: 1.2, fontSize: '0.7rem', textTransform: 'none' }}>With W/O</ToggleButton>
                <ToggleButton value="without" sx={{ px: 1.2, fontSize: '0.7rem', textTransform: 'none' }}>Excl W/O</ToggleButton>
              </ToggleButtonGroup>
            </Box>
          </>
        )}
        <Box sx={{ flex: 1 }} />
        <ExportCsvButton rows={exportRows} columns={exportCols}
          filename={title.replace(/\s+/g, '_').toLowerCase()} />
        <Box sx={{ textAlign: 'right' }}>
          <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>As of</Box>
          <Box sx={{ fontSize: '0.8rem', fontWeight: 700, color: '#1E293B' }}>{data?.as_of ?? '—'}</Box>
        </Box>
      </Box>

      {/* ── KPI cards ────────────────────────────────────────────────────────
          A bare total says nothing about whether it is good. There is no
          prior-period figure on /summary to compare against, and rather than
          invent one these cards carry the comparison that IS derivable from the
          rows already loaded: how many groups sit worse than the benchmark on
          this measure. That is a real dispersion signal — "17.25% overall, but
          4 of 18 branches are well above it" — and it costs no extra request. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2,1fr)', md: `repeat(${Math.min(kpis.length, 5)},1fr)` }, gap: 1.5 }}>
        {kpis.map((k) => {
          const s = KPI_TONE[k.variant ?? 'default']
          const col = columns.find((c) => c.field === k.field && dirOf(c))
          const worse = col
            ? rows.filter((r) => (heatBand(r[col.field], benchFor(r, col.field), dirOf(col),
                col.base ? Number(r[col.base.field] ?? 0) : null, col.base?.min) ?? 2) >= 3).length
            : null
          return (
            <Paper key={k.field} elevation={0} sx={{
              p: 1.6, pl: 2, borderRadius: 2.5, background: s.bg, border: `1.5px solid ${s.border}`,
              position: 'relative', overflow: 'hidden',
            }}>
              <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: s.accent }} />
              <Box sx={{ fontSize: '0.62rem', fontWeight: 700, color: s.label, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{k.label}</Box>
              <Box sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.4rem', fontWeight: 700, color: s.accent, lineHeight: 1.2, mt: 0.4 }}>
                {isLoading ? <Skeleton width={90} /> : fmtVal(data?.grand?.[k.field], k.fmt)}
              </Box>
              {/* Only shown where the measure has a direction — a loan count has
                  no better or worse, so it gets no spurious commentary. */}
              {worse != null && !isLoading && (
                <Box sx={{ fontSize: '0.66rem', color: worse ? '#B91C1C' : '#15803D', fontWeight: 600, mt: 0.4 }}>
                  {worse ? `${worse} of ${rows.length} ${ap1Label.toLowerCase()} worse` : `no ${ap1Label.toLowerCase()} above benchmark`}
                </Box>
              )}
            </Paper>
          )
        })}
      </Box>

      {/* ── Chart — opt-in, hidden by default so the table is the report ──── */}
      <Paper sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Box sx={{ fontSize: '0.82rem', fontWeight: 700, color: '#1E293B' }}>
            {chartLabel} by {ap1Label}
          </Box>
          <Box sx={{ flex: 1 }} />
          <Button size="small" variant="outlined" onClick={() => setShowCharts((v) => !v)}
            sx={{ fontSize: '0.68rem', textTransform: 'none', py: 0.2, px: 1.2, whiteSpace: 'nowrap' }}>
            {showCharts ? 'Hide chart' : 'Show chart'}
          </Button>
        </Box>
        {showCharts && (
        <Box sx={{ height: 260 }}>
          {isLoading ? <Skeleton variant="rectangular" height={240} /> : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 16, right: 16, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748B' }} interval={0} />
                <YAxis tick={{ fontSize: 10, fill: '#64748B' }} width={54}
                  tickFormatter={(v: number) => chartFmt === 'inr' ? `${(v / 1e7).toFixed(0)}` : chartFmt === 'pct' ? `${v}%` : String(v)} />
                <RTooltip formatter={(v: number) => [fmtVal(v, chartFmt), chartLabel]}
                  contentStyle={{ fontSize: 11, borderRadius: 8 }} cursor={{ fill: 'rgba(21,101,192,0.06)' }} />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={54}>
                  {chart.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
                  <LabelList dataKey="value" position="top" style={{ fontSize: 10, fill: '#475569' }}
                    formatter={(v: number) => fmtVal(v, chartFmt)} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Box>
        )}
      </Paper>

      {/* ── Group table ──────────────────────────────────────────────────── */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ px: 2, py: 1.25, borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
            <Box sx={{ fontSize: '0.82rem', fontWeight: 700, color: '#1E293B' }}>
              {title} — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
            </Box>
          </Box>
          {note && <Box sx={{ fontSize: '0.68rem', color: '#94A3B8', mt: 0.2 }}>{note}</Box>}
        </Box>
        {isLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={28} />)}
          </Box>
        ) : (
          <Box sx={{ overflow: 'auto', maxHeight: 'calc(100vh - 260px)' }}>
            {/* Parked under the sticky parameter bar; at top:0 the column
                headers slide behind it and vanish while scrolling. */}
            <Table size="small" stickyHeader sx={{ '& thead th': { top: 0 } }}>
              <TableHead>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)' } }}>
                  {sortCell('name', ap1Label, 'left', true)}
                  {hasAp2 && sortCell('name2', ap2Label, 'left')}
                  {columns.map((c) => sortCell(c.field, c.label, 'right', false, c.hint))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r, i) => {
                  const sb = spineBand.get(r) ?? null
                  return (
                    <TableRow key={i} hover sx={{ '&:nth-of-type(even)': { background: '#FCFDFF' } }}>
                      {/* Frozen so the row label stays put when the columns
                          scroll, and carrying the SEVERITY SPINE: an exception
                          row is findable before a single number is read. */}
                      <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap',
                                       position: 'sticky', left: 0, zIndex: 2,
                                       background: 'inherit',
                                       borderLeft: `4px solid ${spineColor(sb)}`,
                                       borderRight: '1px solid rgba(0,0,0,0.06)' }}>{r.name}</TableCell>
                      {hasAp2 && <TableCell sx={{ color: '#475569', whiteSpace: 'nowrap' }}>{r.name2 ?? '—'}</TableCell>}
                      {columns.map((c) => {
                        const dir = dirOf(c)
                        const band = heatBand(r[c.field], benchFor(r, c.field), dir,
                          c.base ? Number(r[c.base.field] ?? 0) : null, c.base?.min)
                        return (
                          <TableCell key={c.field} align="right" sx={{
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: c === primaryCol ? '0.78rem' : '0.74rem',
                            ...heatStyle(band, c === primaryCol),
                          }}>{fmtVal(r[c.field], c.fmt)}</TableCell>
                        )
                      })}
                    </TableRow>
                  )
                })}
                {data?.grand && (
                  <TableRow sx={{ '& td': { fontWeight: 800, borderTop: '2px solid rgba(0,0,0,0.15)', background: '#F8FAFF' } }}>
                    {/* Never shaded and never spined: this row IS the benchmark
                        in the one-deep case, so colouring it against itself
                        would always read neutral and imply it was assessed. */}
                    <TableCell sx={{ position: 'sticky', left: 0, zIndex: 2,
                                     background: '#F8FAFF',
                                     borderLeft: '4px solid transparent',
                                     borderRight: '1px solid rgba(0,0,0,0.06)' }}>Grand Total</TableCell>
                    {hasAp2 && <TableCell />}
                    {columns.map((c) => (
                      <TableCell key={c.field} align="right" sx={{
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: c === primaryCol ? '0.78rem' : '0.74rem',
                      }}>
                        {fmtVal(data.grand[c.field], c.fmt)}
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>

      {/* Optional trend — driven by this report's AP#1/AP#2 and the portfolio
          toggle (falls back to "with" on pages without the toggle). */}
      {trend && (
        <TrendSection title={trend.title} measures={trend.measures}
          portfolio={portfolio && portfolioVal === 'without' ? 'excl' : 'with'}
          ap1={ap1} ap2={ap2 === 'none' ? undefined : ap2} />
      )}
    </Box>
  )
}

function DimPick({ label, value, options, onChange }: {
  label: string; value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <Box>
      <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', mb: 0.3 }}>{label}</Box>
      <FormControl size="small" sx={{ minWidth: 150 }}>
        <Select value={value} onChange={(e) => onChange(e.target.value)}
          sx={{ fontSize: '0.74rem', height: 26, '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(0,0,0,0.15)' } }}>
          {options.map((o) => <MenuItem key={o.value} value={o.value} sx={{ fontSize: '0.74rem' }}>{o.label}</MenuItem>)}
        </Select>
      </FormControl>
    </Box>
  )
}
