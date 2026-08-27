import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import Button from '@mui/material/Button'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, Legend,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { api } from '../api/client'
import { useSlicerParams } from '../store/filterStore'

// ── Types ─────────────────────────────────────────────────────────────────────
export interface TrendMeasure {
  key: string          // backend measure key
  label: string        // toggle label
  format: 'inr' | 'num' | 'pct'
}

interface SeriesResponse {
  months: string[]
  labels: string[]
  fys: string[]
  rows: { name: string; name2?: string; values: (number | null)[] }[]
  /** AP dims / slicers rpt_trend_full has no column for (see backend). */
  unsupported?: string[]
  grand: (number | null)[]
  pinned?: boolean
  /** Label of the appended current-month point carrying the live report. */
  live_label?: string | null
  /** True when the appended current-month point is a PARTIAL (MTD) flow value. */
  partial_last?: boolean
  /** How many months came from a real month-end snapshot rather than the ledger. */
  snapshot_months?: number
}

const AP_DIMS = [
  { value: 'business_segment', label: 'Business Segment' },
  { value: 'zone_name',        label: 'Zone' },
  { value: 'cluster_name',     label: 'Cluster' },
  { value: 'region_name',      label: 'Region' },
  { value: 'area_name',        label: 'Area / Unit' },
  { value: 'branch_name',      label: 'Branch' },
  { value: 'lo_id',            label: 'Loan Officer' },
]

const LINE_COLORS = ['#1565C0', '#2E7D32', '#E65100', '#6A1B9A', '#C62828', '#00838F']

// ── Formatting: one consistent unit per view (Cr / L / raw) ──────────────────
function unitFor(vals: number[]): { div: number; suffix: string } {
  const max = Math.max(...vals.map(Math.abs), 0)
  if (max >= 1e7) return { div: 1e7, suffix: 'Cr' }
  if (max >= 1e5) return { div: 1e5, suffix: 'L' }
  return { div: 1, suffix: '' }
}

// ── Component ─────────────────────────────────────────────────────────────────
export function TrendSection({ title, measures, portfolio: portfolioProp, ap1, ap2 }: {
  title: string
  measures: TrendMeasure[]
  /** When the host page owns the portfolio toggle, the trend follows it (one
   *  control drives the whole page). Omitted → the section keeps its own. */
  portfolio?: 'with' | 'excl'
  /** When the host page owns AP#1/AP#2, the trend groups by the same dimensions
   *  instead of showing its own "By" selector. */
  ap1?: string
  ap2?: string
}) {
  const [measureKey, setMeasureKey] = useState(measures[0].key)
  const [fy, setFy] = useState<string>('')          // '' = latest FY (set after load)
  const [ownPortfolio, setOwnPortfolio] = useState<'with' | 'excl'>('with')
  // The trend is the heaviest query on the page — don't load it until asked.
  const [open, setOpen] = useState(false)
  // Chart starts hidden — the table carries the numbers, the chart is a shape aid.
  const [showChart, setShowChart] = useState(false)
  const slicers = useSlicerParams()

  const controlled = portfolioProp !== undefined
  const portfolio = portfolioProp ?? ownPortfolio
  const apDriven = ap1 !== undefined
  // No "By" selector: AP-driven pages follow their own AP#1, everything else
  // groups by business segment. Every trend section is FY-driven only.
  const effGroupBy = apDriven ? (ap1 as string) : 'business_segment'
  const hasAp2 = apDriven && !!ap2 && ap2 !== 'none'

  const measure = measures.find((m) => m.key === measureKey) ?? measures[0]

  const params = useMemo(() => {
    const p = new URLSearchParams({ measure: measure.key, group_by: effGroupBy, portfolio })
    if (apDriven && ap2 && ap2 !== 'none') p.set('group_by_2', ap2)
    if (fy && fy !== 'ALL') p.set('fy', fy)
    for (const [k, v] of Object.entries(slicers)) p.set(k, v)
    return p.toString()
  }, [measure.key, effGroupBy, ap2, apDriven, fy, portfolio, slicers])

  const { data, isLoading } = useQuery<SeriesResponse>({
    queryKey: ['trend-series', params],
    queryFn: () => api.get(`/api/trend/series?${params}`).then((r) => r.data),
    enabled: open,
  })

  // default to the latest FY once known
  const effFy = fy || (data?.fys.length ? data.fys[data.fys.length - 1] : '')
  if (!fy && data?.fys.length) {
    setFy(data.fys[data.fys.length - 1])
  }

  const fmt = useMemo(() => {
    if (!data) return { cell: (v: number | null) => '—', unit: '' }
    const allVals = [...data.grand, ...data.rows.flatMap((r) => r.values)]
      .filter((v): v is number => v != null)
    if (measure.format === 'pct')
      return { cell: (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}%`), unit: '%' }
    if (measure.format === 'num')
      return { cell: (v: number | null) => (v == null ? '—' : v.toLocaleString('en-IN')), unit: '#' }
    const { div, suffix } = unitFor(allVals)
    return {
      cell: (v: number | null) => (v == null ? '—' : (v / div).toLocaleString('en-IN', { maximumFractionDigits: 2 })),
      unit: `₹ ${suffix}`.trim(),
    }
  }, [data, measure.format])

  // chart: top 6 series by latest value + Grand Total
  const chart = useMemo(() => {
    if (!data) return { points: [], series: [] as string[] }
    const last = (vs: (number | null)[]) => vs.length ? (vs[vs.length - 1] ?? 0) : 0
    const ranked = [...data.rows]
      .sort((a, b) => last(b.values) - last(a.values))
      .slice(0, 6)
    const points = data.labels.map((label, i) => {
      const pt: Record<string, string | number | null> = { label }
      ranked.forEach((r) => { pt[r.name] = r.values[i] })
      pt['Grand Total'] = data.grand[i]
      return pt
    })
    return { points, series: ranked.map((r) => r.name) }
  }, [data])

  // Collapsed: nothing is fetched until the user asks for the trend.
  if (!open) {
    return (
      <Paper sx={{ p: 2, mt: 3 }}>
        <Box className="flex items-center justify-between flex-wrap gap-2">
          <Box>
            <Box sx={{ fontSize: '0.85rem', fontWeight: 700, color: '#1E293B' }}>{title}</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#94A3B8' }}>
              Monthly, FY view (Apr–Mar) — loaded on demand to keep this page fast
            </Box>
          </Box>
          <Button variant="outlined" size="small" onClick={() => setOpen(true)}
            sx={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'none' }}>
            Show Trend Report
          </Button>
        </Box>
      </Paper>
    )
  }

  return (
    <Paper sx={{ p: 2.5, mt: 3 }}>
      <Box className="flex items-center justify-between flex-wrap gap-2" sx={{ mb: 1.5 }}>
        <Box>
          <Box sx={{ fontSize: '0.85rem', fontWeight: 700, color: '#1E293B' }}>{title}</Box>
          <Box sx={{ fontSize: '0.68rem', color: '#94A3B8' }}>
            Monthly, FY view (Apr–Mar){fmt.unit ? ` — values in ${fmt.unit}` : ''}
            {data?.live_label
              ? ` · ${data.live_label} = ${data.partial_last ? 'MTD, partial month' : 'live report (month to date)'}`
              : ''}
          </Box>
          {/* The monthly ledger is keyed by month × segment × branch × LO, so
              loan-attribute dimensions cannot be applied here. Say so rather
              than quietly showing an unfiltered trend. */}
          {!!data?.unsupported?.length && (
            <Box sx={{ fontSize: '0.68rem', color: '#B45309', mt: 0.3 }}>
              Not applied to the trend (not carried by the monthly ledger):{' '}
              {data.unsupported.join(', ')}
            </Box>
          )}
        </Box>
        <Box className="flex items-center gap-2 flex-wrap">
          {/* Hidden when the host page owns the portfolio — one control for the
              whole page (KPIs, AP table and trend all follow it). */}
          {!controlled && (
            <ToggleButtonGroup size="small" exclusive value={portfolio}
              onChange={(_, v) => v && setOwnPortfolio(v)}>
              <ToggleButton value="with" sx={{ fontSize: '0.68rem', px: 1.2, textTransform: 'none' }}>With W/O</ToggleButton>
              <ToggleButton value="excl" sx={{ fontSize: '0.68rem', px: 1.2, textTransform: 'none' }}>Excl. W/O</ToggleButton>
            </ToggleButtonGroup>
          )}
          {measures.length > 1 && (
            <ToggleButtonGroup size="small" exclusive value={measure.key}
              onChange={(_, v) => v && setMeasureKey(v)}>
              {measures.map((m) => (
                <ToggleButton key={m.key} value={m.key} sx={{ fontSize: '0.68rem', px: 1.2, textTransform: 'none' }}>
                  {m.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          )}
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel>FY</InputLabel>
            <Select value={effFy} label="FY" sx={{ fontSize: '0.78rem' }}
              onChange={(e) => setFy(e.target.value)}>
              <MenuItem value="ALL" sx={{ fontSize: '0.8rem' }}>All years</MenuItem>
              {(data?.fys ?? []).map((f) => <MenuItem key={f} value={f} sx={{ fontSize: '0.8rem' }}>{f}</MenuItem>)}
            </Select>
          </FormControl>
          {/* The table is the report; the chart is optional and starts hidden so
              opening a trend section costs one screen, not two. */}
          <Button size="small" variant="outlined" onClick={() => setShowChart((v) => !v)}
            sx={{ fontSize: '0.68rem', textTransform: 'none', py: 0.2, px: 1.2, whiteSpace: 'nowrap' }}>
            {showChart ? 'Hide chart' : 'Show chart'}
          </Button>
        </Box>
      </Box>

      {/* Chart — opt-in */}
      {showChart && (
      <Box sx={{ height: 260 }}>
        {isLoading || !data ? (
          <Box className="flex items-center justify-center h-full" sx={{ color: '#94A3B8', fontSize: '0.8rem' }}>
            Loading…
          </Box>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart.points} margin={{ top: 6, right: 18, bottom: 0, left: 6 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => fmt.cell(v) as string} width={72} />
              <RTooltip formatter={(v: number) => fmt.cell(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {chart.series.map((s, i) => (
                <Line key={s} dataKey={s} stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={1.8} dot={false} />
              ))}
              <Line dataKey="Grand Total" stroke="#0F172A" strokeWidth={2.4} strokeDasharray="5 3"
                dot={data?.partial_last
                  ? (p: any) => (p.index === chart.points.length - 1
                      ? <circle key="partial" cx={p.cx} cy={p.cy} r={4} fill="#fff" stroke="#0F172A" strokeWidth={2} />
                      : <g key={p.index} />)
                  : false} />
              {/* hollow dot marks the last point as a partial (MTD) month */}
            </LineChart>
          </ResponsiveContainer>
        )}
      </Box>
      )}

      {/* Table */}
      {data && data.rows.length > 0 && (
        <Box sx={{ overflowX: 'auto', mt: 1.5 }}>
          <Table size="small" sx={{ '& td, & th': { fontSize: '0.72rem', whiteSpace: 'nowrap', py: 0.4 } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>
                  {apDriven ? 'Analysis Parameter' : AP_DIMS.find((d) => d.value === effGroupBy)?.label}
                </TableCell>
                {hasAp2 && <TableCell sx={{ fontWeight: 700 }}>AP #2</TableCell>}
                {data.labels.map((l) => <TableCell key={l} align="right" sx={{ fontWeight: 700 }}>{l}</TableCell>)}
              </TableRow>
            </TableHead>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={`${r.name}|${r.name2 ?? ''}`} hover>
                  <TableCell>{r.name}</TableCell>
                  {hasAp2 && <TableCell>{r.name2 ?? ''}</TableCell>}
                  {r.values.map((v, i) => <TableCell key={i} align="right">{fmt.cell(v)}</TableCell>)}
                </TableRow>
              ))}
              <TableRow sx={{ '& td': { fontWeight: 700, borderTop: '2px solid rgba(0,0,0,0.15)' } }}>
                <TableCell>Grand Total</TableCell>
                {hasAp2 && <TableCell />}
                {data.grand.map((v, i) => <TableCell key={i} align="right">{fmt.cell(v)}</TableCell>)}
              </TableRow>
            </TableBody>
          </Table>
        </Box>
      )}
    </Paper>
  )
}
