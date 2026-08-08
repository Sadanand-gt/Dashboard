import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import TableSortLabel from '@mui/material/TableSortLabel'
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

// ── Config types ──────────────────────────────────────────────────────────────
export type Fmt = 'inr' | 'num' | 'pct'

export interface ColDef {
  field: string
  label: string
  fmt: Fmt
  /** colour-code the value by risk level (higher = worse) */
  risk?: boolean
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
const riskColor = (v: number) => (v >= 5 ? '#DC2626' : v >= 2 ? '#D97706' : '#16A34A')
const BAR_COLORS = ['#1565C0', '#0F766E', '#7C3AED', '#D97706', '#DC2626', '#0891B2']

export function StandardReport({
  title, endpoint, kpis, columns, chartField, chartLabel, chartFmt, variant, note, portfolio, trend,
}: Props) {
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

  const sortCell = (field: string, label: string, align: 'left' | 'right' = 'right', sticky = false) => (
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

  return (
    <Box className="space-y-3">
      {/* ── Top bar: AP#1 / AP#2 / variant / as-of ───────────────────────── */}
      {/* Frozen to the top: the analysis parameters govern every number below,
          so they must stay visible and changeable while the table scrolls. */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
        position: 'sticky', top: 0, zIndex: 30,
        background: '#FFFFFF', borderRadius: 2, px: 2.5, py: 1.25,
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

      {/* ── KPI cards ────────────────────────────────────────────────────── */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2,1fr)', md: `repeat(${Math.min(kpis.length, 5)},1fr)` }, gap: 1.5 }}>
        {kpis.map((k) => (
          <Paper key={k.field} elevation={0} sx={{
            p: 1.5, borderRadius: 2, border: '1px solid rgba(15,23,42,0.09)',
            borderLeft: `3px solid ${{ green: '#16A34A', amber: '#D97706', red: '#DC2626', default: '#1565C0' }[k.variant ?? 'default']}`,
          }}>
            <Box sx={{ fontSize: '0.6rem', fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{k.label}</Box>
            <Box sx={{ fontSize: '1.2rem', fontWeight: 800, color: '#1E293B', mt: 0.3 }}>
              {isLoading ? <Skeleton width={80} /> : fmtVal(data?.grand?.[k.field], k.fmt)}
            </Box>
          </Paper>
        ))}
      </Box>

      {/* ── Chart ────────────────────────────────────────────────────────── */}
      <Paper sx={{ p: 2 }}>
        <Box sx={{ fontSize: '0.82rem', fontWeight: 700, color: '#1E293B', mb: 1 }}>
          {chartLabel} by {ap1Label}
        </Box>
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
      </Paper>

      {/* ── Group table ──────────────────────────────────────────────────── */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ px: 2, py: 1.25, borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
          <Box sx={{ fontSize: '0.82rem', fontWeight: 700, color: '#1E293B' }}>
            {title} — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
          </Box>
          {note && <Box sx={{ fontSize: '0.68rem', color: '#94A3B8', mt: 0.2 }}>{note}</Box>}
        </Box>
        {isLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={28} />)}
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto', maxHeight: 460 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)' } }}>
                  {sortCell('name', ap1Label, 'left', true)}
                  {hasAp2 && sortCell('name2', ap2Label, 'left')}
                  {columns.map((c) => sortCell(c.field, c.label))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i} hover sx={{ '&:nth-of-type(even)': { background: '#FCFDFF' } }}>
                    {/* frozen: the row label stays put when the columns scroll */}
                    <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap',
                                     position: 'sticky', left: 0, zIndex: 2,
                                     background: 'inherit',
                                     borderRight: '1px solid rgba(0,0,0,0.06)' }}>{r.name}</TableCell>
                    {hasAp2 && <TableCell sx={{ color: '#475569', whiteSpace: 'nowrap' }}>{r.name2 ?? '—'}</TableCell>}
                    {columns.map((c) => (
                      <TableCell key={c.field} align="right" sx={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.74rem',
                        color: c.risk ? riskColor(Number(r[c.field] ?? 0)) : '#0F172A',
                        fontWeight: c.risk ? 700 : 400,
                      }}>{fmtVal(r[c.field], c.fmt)}</TableCell>
                    ))}
                  </TableRow>
                ))}
                {data?.grand && (
                  <TableRow sx={{ '& td': { fontWeight: 800, borderTop: '2px solid rgba(0,0,0,0.15)', background: '#F8FAFF' } }}>
                    <TableCell sx={{ position: 'sticky', left: 0, zIndex: 2,
                                     background: '#F8FAFF',
                                     borderRight: '1px solid rgba(0,0,0,0.06)' }}>Grand Total</TableCell>
                    {hasAp2 && <TableCell />}
                    {columns.map((c) => (
                      <TableCell key={c.field} align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.74rem' }}>
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
