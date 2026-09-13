import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSlicerParams } from '../store/filterStore'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Paper from '@mui/material/Paper'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { api } from '../api/client'

type Freq = 'M' | 'Q' | 'Y'

const AXIS    = { fill: '#475569', fontSize: 11 }
const GRID    = { stroke: 'rgba(0,0,0,0.06)' }
const TOOLTIP = { background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 12, color: '#1E293B' }

type RawRow = Record<string, unknown>

// ── FY helpers ────────────────────────────────────────────────────────────────
// FY runs Apr → Mar. April of calendar year Y → FY(Y+1).
function parseMKey(mKey: string): { year: number; month: number } | null {
  const m = String(mKey).match(/^(\d{4})-(\d{2})$/)
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]) }
}

function fyYear(year: number, month: number): number {
  // Month >= 4 (Apr) → belongs to FY that starts this year; label = year+1
  return month >= 4 ? year + 1 : year
}

function fyQuarter(month: number): number {
  // Q1=Apr-Jun(4-6), Q2=Jul-Sep(7-9), Q3=Oct-Dec(10-12), Q4=Jan-Mar(1-3)
  if (month >= 4 && month <= 6)  return 1
  if (month >= 7 && month <= 9)  return 2
  if (month >= 10 && month <= 12) return 3
  return 4
}

function groupKey(mKey: string, freq: Freq): string {
  const p = parseMKey(mKey)
  if (!p) return mKey
  const fy = fyYear(p.year, p.month)
  if (freq === 'Y') return `FY${String(fy).slice(2)}`
  if (freq === 'Q') return `Q${fyQuarter(p.month)} FY${String(fy).slice(2)}`
  return mKey
}

function groupLabel(mKey: string, freq: Freq, rawLabel: string): string {
  if (freq === 'M') return rawLabel || mKey
  return groupKey(mKey, freq)
}

const NUM_COLS = [
  'demand', 'collection', 'disb_count', 'disb_amount',
  'total_loans', 'total_pos', 'par0_count', 'par0_pos',
  'par30_count', 'par30_pos', 'par90_count', 'par90_pos',
]

interface AggRow {
  period: string
  pos: number
  disb: number
  ce: number
  par0: number
  par30: number
  par90: number
}

interface BucketEntry {
  label: string
  order: string
  [col: string]: string | number
}

function aggregate(rows: RawRow[], freq: Freq): AggRow[] {
  const map = new Map<string, BucketEntry>()

  rows.forEach((r) => {
    const mKey = String(r.m_key ?? '')
    const key  = groupKey(mKey, freq)
    if (!map.has(key)) {
      const entry: BucketEntry = { label: groupLabel(mKey, freq, String(r.m_label ?? '')), order: mKey }
      NUM_COLS.forEach((c) => { entry[c] = 0 })
      map.set(key, entry)
    }
    const bucket = map.get(key)!
    NUM_COLS.forEach((col) => { bucket[col] = (Number(bucket[col]) ?? 0) + Number(r[col] ?? 0) })
    if (mKey < String(bucket.order)) bucket.order = mKey
  })

  return Array.from(map.values())
    .sort((a, b) => String(a.order).localeCompare(String(b.order)))
    .map((b) => {
      const totalPos  = Number(b.total_pos)
      const demand    = Number(b.demand)
      const collection = Number(b.collection)
      const disbAmount = Number(b.disb_amount)
      const par0Pos   = Number(b.par0_pos)
      const par30Pos  = Number(b.par30_pos)
      const par90Pos  = Number(b.par90_pos)
      return {
        period: String(b.label),
        pos:    +(totalPos   / 1e7).toFixed(2),
        disb:   +(disbAmount / 1e7).toFixed(2),
        ce:     demand > 0 ? +Math.min(collection / demand * 100, 100).toFixed(2) : 0,
        par0:   totalPos > 0 ? +(par0Pos  / totalPos * 100).toFixed(2) : 0,
        par30:  totalPos > 0 ? +(par30Pos / totalPos * 100).toFixed(2) : 0,
        par90:  totalPos > 0 ? +(par90Pos / totalPos * 100).toFixed(2) : 0,
      }
    })
}

// ── Time-slab helpers (last N months of monthly data) ─────────────────────────
const TIME_SLABS = [
  { label: '12M', months: 12 },
  { label: '24M', months: 24 },
  { label: '36M', months: 36 },
  { label: '48M', months: 48 },
  { label: '60M', months: 60 },
  { label: 'All', months: 0 },
]

// ── Component ─────────────────────────────────────────────────────────────────
export function TrendMonthly() {
  const [freq,     setFreq]     = useState<Freq>('M')
  // Charts are opt-in and start hidden, matching every other page.
  const [showCharts, setShowCharts] = useState(false)
  const [timeSlab, setTimeSlab] = useState('12M')
  // /api/trend/monthly already accepted portfolio; the page just never sent it,
  // so this view was pinned to "With W/O" while every trend SECTION offered both.
  const [portfolio, setPortfolio] = useState<'with' | 'excl'>('excl')  // default Excl. W/O — the active portfolio, consistent across every page
  const slicer = useSlicerParams()

  // Full-history monthly series from rpt_trend_full — the same engine behind
  // every other trend section, with the latest month pinned to the live report.
  const { data: rawRows = [] } = useQuery<RawRow[]>({
    queryKey: ['trend-monthly-full', slicer, portfolio],
    queryFn: () => api.get('/api/trend/monthly', { params: { ...slicer, portfolio } }).then((r) => r.data),
  })

  // Apply time slab filter on raw monthly rows before aggregation
  const slicedRaw = useMemo(() => {
    const slab = TIME_SLABS.find((s) => s.label === timeSlab)
    if (!slab || slab.months === 0) return rawRows
    const sorted = [...rawRows].sort((a, b) =>
      String(a.m_key ?? '').localeCompare(String(b.m_key ?? ''))
    )
    return sorted.slice(-slab.months)
  }, [rawRows, timeSlab])

  const data = useMemo(() => aggregate(slicedRaw, freq), [slicedRaw, freq])

  return (
    <Box className="space-y-4">

      {/* ── Controls ── */}
      <Box
        sx={{
          display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap',
          background: '#FFFFFF', borderRadius: 2, px: 2.5, py: 1.5,
          border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}
      >
        {/* Frequency toggle */}
        <Box>
          <Box sx={{ fontSize: '0.62rem', color: '#94A3B8', mb: 0.4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Frequency
          </Box>
          <ToggleButtonGroup
            value={freq}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setFreq(v) }}
          >
            <ToggleButton value="M" sx={{ px: 1.5, py: 0.5 }}>Monthly</ToggleButton>
            <ToggleButton value="Q" sx={{ px: 1.5, py: 0.5 }}>Quarterly</ToggleButton>
            <ToggleButton value="Y" sx={{ px: 1.5, py: 0.5 }}>Yearly (FY)</ToggleButton>
          </ToggleButtonGroup>
        </Box>

        {/* Portfolio toggle — matches every other report page */}
        <Box>
          <Box sx={{ fontSize: '0.62rem', color: '#94A3B8', mb: 0.4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Portfolio
          </Box>
          <ToggleButtonGroup
            value={portfolio}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setPortfolio(v) }}
          >
            <ToggleButton value="with" sx={{ px: 1.5, py: 0.5 }}>With W/O</ToggleButton>
            <ToggleButton value="excl" sx={{ px: 1.5, py: 0.5 }}>Excl. W/O</ToggleButton>
          </ToggleButtonGroup>
        </Box>

        {/* Time slab filter */}
        <Box>
          <Box sx={{ fontSize: '0.62rem', color: '#94A3B8', mb: 0.4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Time Period
          </Box>
          <ToggleButtonGroup
            value={timeSlab}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setTimeSlab(v) }}
          >
            {TIME_SLABS.map((s) => (
              <ToggleButton key={s.label} value={s.label} sx={{ px: 1.2, py: 0.5 }}>
                {s.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        <Box sx={{ flex: 1 }} />

        <Box sx={{ fontSize: '0.72rem', color: '#94A3B8' }}>
          {data.length} period{data.length !== 1 ? 's' : ''} · IL + JLG combined
        </Box>
      </Box>

      {/* ── Charts ── */}
      {data.length === 0 ? (
        <Paper>
          <Box sx={{ px: 4, py: 10, textAlign: 'center', fontSize: '0.875rem', color: '#94A3B8' }}>
            No data — run the pipeline to populate this report.
          </Box>
        </Paper>
      ) : (
        <Box className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TrendPanel title="POS Trend (₹ Cr)">
            <LineChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID.stroke} vertical={false} />
              <XAxis dataKey="period" tick={AXIS} axisLine={{ stroke: 'rgba(0,0,0,0.1)' }} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [`₹${v} Cr`, 'POS']} />
              <Line type="monotone" dataKey="pos" name="POS (₹ Cr)" stroke="#1565C0" strokeWidth={2.5} dot={data.length < 20} activeDot={{ r: 5 }} />
            </LineChart>
          </TrendPanel>

          <TrendPanel title="Collection Efficiency %">
            <LineChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID.stroke} vertical={false} />
              <XAxis dataKey="period" tick={AXIS} axisLine={{ stroke: 'rgba(0,0,0,0.1)' }} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [`${v}%`, 'CE%']} />
              <Line type="monotone" dataKey="ce" name="CE%" stroke="#16A34A" strokeWidth={2.5} dot={data.length < 20} activeDot={{ r: 5 }} />
            </LineChart>
          </TrendPanel>

          <TrendPanel title="PAR Trend %">
            <LineChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID.stroke} vertical={false} />
              <XAxis dataKey="period" tick={AXIS} axisLine={{ stroke: 'rgba(0,0,0,0.1)' }} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [`${v}%`]} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#64748B' }} />
              <Line type="monotone" dataKey="par0"  name="PAR 0+"  stroke="#D97706" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="par30" name="PAR 30+" stroke="#DC2626" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="par90" name="PAR 90+" stroke="#7F1D1D" strokeWidth={2} dot={false} />
            </LineChart>
          </TrendPanel>

          <TrendPanel title="Disbursement Trend (₹ Cr)">
            <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID.stroke} vertical={false} />
              <XAxis dataKey="period" tick={AXIS} axisLine={{ stroke: 'rgba(0,0,0,0.1)' }} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} />
              <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [`₹${v} Cr`, 'Disbursement']} />
              <Bar dataKey="disb" name="Disbursement" fill="#1565C0" barSize={freq === 'M' ? 12 : 24} radius={[3, 3, 0, 0]} />
            </BarChart>
          </TrendPanel>
        </Box>
      )}
    </Box>
  )
}

function TrendPanel({ title, children }: { title: string; children: React.ReactNode }) {
  // Each panel opens closed. Charts are opt-in across the whole dashboard, so a
  // page costs one screen rather than several.
  const [show, setShow] = useState(false)
  return (
    <Paper>
      <Box
        sx={{
          px: 2.5, py: 1.75, borderBottom: '1px solid rgba(0,0,0,0.06)',
          fontWeight: 700, fontSize: '0.85rem', color: '#1E293B', background: '#FAFBFF',
          display: 'flex', alignItems: 'center', gap: 1,
        }}
      >
        {title}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="outlined" onClick={() => setShow((v) => !v)}
          sx={{ fontSize: '0.68rem', textTransform: 'none', py: 0.2, px: 1.2, whiteSpace: 'nowrap' }}>
          {show ? 'Hide chart' : 'Show chart'}
        </Button>
      </Box>
      {show && (
      <Box sx={{ height: 280, p: 2 }}>
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </Box>
      )}
    </Paper>
  )
}
