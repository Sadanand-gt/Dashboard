import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Skeleton from '@mui/material/Skeleton'
import Chip from '@mui/material/Chip'
import Button from '@mui/material/Button'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  CartesianGrid, Legend, Cell, ReferenceLine, LabelList,
} from 'recharts'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { useSlicerParams } from '../store/filterStore'
import { ExportCsvButton } from '../components/ExportCsvButton'

// ── Palette — DPD buckets run green (current) to red (deepest arrears) ────────
const BUCKET_COLORS: Record<string, string> = {
  'Regular': '#16A34A', '1 - 30': '#65A30D', '31 - 60': '#CA8A04',
  '61 - 90': '#EA580C', '91 - 180': '#DC2626', '181 - 360': '#B91C1C',
  '360 +': '#7F1D1D',
}
const INK = '#0F172A'
const MUTED = '#64748B'
const LINE = '#E2E8F0'

// The 11 cuts built by pipeline/queries/portfolio_cuts.sql. Location Type is not
// here: Excel sources RURAL/URBAN from the AUM Loandump and the replica has no
// equivalent column.
const CUTS = [
  'Business Segment', 'Geography', 'Original Tenure', 'Residual Tenure', 'ROI',
  'Ticket Size', 'Loan Purpose', 'Cycle', 'Repay Frequency', 'Caste', 'Religion',
]

const BUCKETS = [
  { key: 'regular', label: 'Regular' }, { key: '1_30', label: '1 - 30' },
  { key: '31_60', label: '31 - 60' }, { key: '61_90', label: '61 - 90' },
  { key: '91_180', label: '91 - 180' }, { key: '181_360', label: '181 - 360' },
  { key: '360_plus', label: '360 +' },
]

const cr = (n: number) => (n / 1e7)
const fmtCr = (n: number) => cr(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtN = (n: number) => Math.round(n).toLocaleString('en-IN')
const fmtPct = (n: number) => `${(n ?? 0).toFixed(2)}%`

// Export mirrors the on-screen matrix, in the same column order, so a
// downloaded file and the page can be read side by side.
const EXPORT_COLS: [string, string][] = [
  ['segment', 'Business Segment'],
  ['cut', 'Cut'],
  ['n_regular', '# Regular'], ['n_1_30', '# 1-30'], ['n_31_60', '# 31-60'],
  ['n_61_90', '# 61-90'], ['n_91_180', '# 91-180'], ['n_181_360', '# 181-360'],
  ['n_360_plus', '# 360+'], ['n_total', '# Total'],
  ['pos_regular', 'POS Regular'], ['pos_1_30', 'POS 1-30'], ['pos_31_60', 'POS 31-60'],
  ['pos_61_90', 'POS 61-90'], ['pos_91_180', 'POS 91-180'], ['pos_181_360', 'POS 181-360'],
  ['pos_360_plus', 'POS 360+'], ['pos_total', 'POS Total'],
  ['par0_pct', 'PAR>0 %'], ['par30_pct', 'PAR>30 %'],
  ['par90_pct', 'PAR>90 %'], ['par60_pct', 'PAR>60 %'],
  ['wo3m_count', 'Write-off 3M #'], ['wo3m_amount', 'Write-off 3M Rs'],
]

// Additive measures — safe to sum when rolling rows up.
const SUM_FIELDS = [
  'n_regular', 'n_1_30', 'n_31_60', 'n_61_90', 'n_91_180', 'n_181_360', 'n_360_plus', 'n_total',
  'pos_regular', 'pos_1_30', 'pos_31_60', 'pos_61_90', 'pos_91_180', 'pos_181_360',
  'pos_360_plus', 'pos_total', 'par0_pos', 'par30_pos', 'par60_pos', 'par90_pos',
  'wo3m_count', 'wo3m_amount',
]

type Row = Record<string, any>

export function PortfolioCuts() {
  const slicer = useSlicerParams()
  const [cut, setCut] = useState('Business Segment')
  const [portfolio, setPortfolio] = useState<'without' | 'with'>('without')
  const [measure, setMeasure] = useState<'pos' | 'n'>('pos')
  const [showCharts, setShowCharts] = useState(true)

  // Excel's sheets are two-level pivots: Business Segment down the side with the
  // cut nested under it (verified against sheets 29-39, which carry
  // col0=Business Segment, col1=the cut). The page mirrors that shape.
  // Sheet 28 (Business Segment) is single-level in Excel — nesting a dimension
  // under itself would double every row — so that one cut asks for one level.
  const nested = cut !== 'Business Segment'
  const params = {
    ...slicer, group_by: 'business_segment', pick: cut, portfolio,
    ...(nested ? { group_by_2: 'cut_value' } : {}),
  }
  const { data, isLoading } = useQuery({
    queryKey: ['portfolio-cuts', params],
    queryFn: () => api.get('/api/portfolio-cuts/summary', { params }).then((r) => r.data),
  })

  const rows: Row[] = data?.rows ?? []
  const grand: Row = data?.grand ?? {}

  // Sum the additive measures and re-derive the PAR ratios from the summed POS —
  // a percentage cannot be averaged across rows.
  const roll = (items: Row[], name: string): Row => {
    const o: Row = { name }
    SUM_FIELDS.forEach((f) => { o[f] = items.reduce((a, b) => a + (Number(b[f]) || 0), 0) })
    const p = Number(o.pos_total) || 0
    o.par0_pct = p ? +(o.par0_pos / p * 100).toFixed(2) : 0
    o.par30_pct = p ? +(o.par30_pos / p * 100).toFixed(2) : 0
    o.par60_pct = p ? +(o.par60_pos / p * 100).toFixed(2) : 0
    o.par90_pct = p ? +(o.par90_pos / p * 100).toFixed(2) : 0
    return o
  }

  // Nested view: one block per Business Segment, its cut values beneath.
  const segments = useMemo(() => {
    const by = new Map<string, Row[]>()
    rows.forEach((r) => {
      const k = String(r.name ?? '—')
      if (!by.has(k)) by.set(k, [])
      by.get(k)!.push(r)
    })
    return [...by.entries()].map(([seg, items]) => ({
      seg, items, subtotal: roll(items, seg),
    }))
  }, [rows])

  // Charts read the CUT level, rolled across segments — the cut is the question
  // being asked; the segment split lives in the table.
  const byCut = useMemo(() => {
    const by = new Map<string, Row[]>()
    rows.forEach((r) => {
      // name2 is the cut when nested; when the cut IS Business Segment there is
      // only one level, so the cut lives in name.
      const k = String(r.name2 ?? r.name ?? '—')
      if (!by.has(k)) by.set(k, [])
      by.get(k)!.push(r)
    })
    return [...by.entries()].map(([k, items]) => roll(items, k))
  }, [rows])

  // Concentration vs risk: x = share of the book, y = PAR>30%, bubble = POS.
  // This is the view no single Excel sheet gives — it answers "which slices are
  // big AND deteriorating" in one glance.
  const risk = useMemo(() => {
    const tot = Number(grand.pos_total) || 0
    return byCut.map((r) => ({
      name: r.name,
      share: tot ? (Number(r.pos_total) / tot) * 100 : 0,
      par30: Number(r.par30_pct) || 0,
      pos: Number(r.pos_total) || 0,
      n: Number(r.n_total) || 0,
    })).sort((a, b) => b.par30 - a.par30)
  }, [byCut, grand])

  const avgPar30 = Number(grand.par30_pct) || 0

  // Rows plus the Grand Total, so the file reconciles on its own.
  // Export mirrors the nested table: each segment subtotal followed by its cuts.
  const exportRows = useMemo(() => {
    if (!rows.length) return []
    const out: Row[] = []
    if (!nested) {
      rows.forEach((r) => out.push({ ...r, segment: r.name, cut: r.name }))
      out.push({ ...grand, segment: 'Grand Total', cut: '' })
      return out
    }
    segments.forEach(({ seg, items, subtotal }) => {
      out.push({ ...subtotal, segment: seg, cut: 'ALL' })
      items.forEach((r) => out.push({ ...r, segment: seg, cut: r.name2 }))
    })
    out.push({ ...grand, segment: 'Grand Total', cut: '' })
    return out
  }, [rows, segments, grand, nested])

  const stacked = useMemo(() => byCut.map((r) => {
    const o: Row = { name: r.name }
    BUCKETS.forEach((b) => {
      o[b.label] = measure === 'pos' ? cr(Number(r[`pos_${b.key}`]) || 0) : Number(r[`n_${b.key}`]) || 0
    })
    return o
  }), [byCut, measure])

  return (
    <Box sx={{ p: 2.5 }}>
      {/* ── STICKY COMMAND BAR — title, cuts, view toggles, export ──────
           Frozen to the top so the cut you are looking at stays named and
           switchable while you scroll a long matrix. It sits ABOVE the KPI
           cards because the cut governs every number below it. ──────────── */}
      <Box sx={{ position: 'sticky', top: 0, zIndex: 30, bgcolor: '#fff',
                 pt: 2, pb: 1, mx: -2.5, px: 2.5,
                 borderBottom: `1px solid ${LINE}`,
                 boxShadow: '0 2px 6px -4px rgba(15,23,42,0.25)' }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5,
                   flexWrap: 'wrap', mb: 1 }}>
          <Box sx={{ fontSize: '1.2rem', fontWeight: 700, color: INK }}>Portfolio Cuts</Box>
          <Box sx={{ fontSize: '0.75rem', color: MUTED }}>
            live book · as of {data?.as_of ?? '—'}
          </Box>
          <Box sx={{ flex: 1 }} />
          <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'center', flexWrap: 'wrap' }}>
            <ToggleButtonGroup size="small" exclusive value={portfolio}
              onChange={(_, v) => v && setPortfolio(v)}>
              <ToggleButton value="without" sx={{ fontSize: '0.68rem', px: 1.25, py: 0.35 }}>Excl. W/O</ToggleButton>
              <ToggleButton value="with" sx={{ fontSize: '0.68rem', px: 1.25, py: 0.35 }}>With W/O</ToggleButton>
            </ToggleButtonGroup>
            <ToggleButtonGroup size="small" exclusive value={measure}
              onChange={(_, v) => v && setMeasure(v)}>
              <ToggleButton value="pos" sx={{ fontSize: '0.68rem', px: 1.25, py: 0.35 }}>₹ POS</ToggleButton>
              <ToggleButton value="n" sx={{ fontSize: '0.68rem', px: 1.25, py: 0.35 }}># Loans</ToggleButton>
            </ToggleButtonGroup>
            <Button size="small" variant="text" onClick={() => setShowCharts((v) => !v)}
              sx={{ fontSize: '0.68rem', textTransform: 'none', color: MUTED, minWidth: 0, px: 1 }}>
              {showCharts ? 'Hide charts' : 'Show charts'}
            </Button>
            <ExportCsvButton rows={exportRows} columns={EXPORT_COLS}
              filename={`portfolio_cuts_${cut.replace(/\s+/g, '_').toLowerCase()}`} />
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap' }}>
          {CUTS.map((c) => (
            <Chip key={c} label={c} size="small" clickable onClick={() => setCut(c)}
                  variant={cut === c ? 'filled' : 'outlined'}
                  sx={{ fontSize: '0.7rem', height: 24,
                        fontWeight: cut === c ? 700 : 500,
                        bgcolor: cut === c ? INK : 'transparent',
                        color: cut === c ? '#fff' : MUTED,
                        borderColor: LINE,
                        '&:hover': { bgcolor: cut === c ? INK : '#F1F5F9' } }} />
          ))}
        </Box>
      </Box>

      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      <Box sx={{ display: 'grid', gap: 1.5, mt: 2, mb: 2,
                 gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(3, 1fr)', md: 'repeat(6, 1fr)' } }}>
        <KpiCard label="Loans" value={isLoading ? '—' : fmtN(grand.n_total ?? 0)} sub="live book" loading={isLoading} />
        <KpiCard label="POS" value={isLoading ? '—' : `₹${fmtCr(grand.pos_total ?? 0)} Cr`} sub="outstanding" loading={isLoading} />
        <KpiCard label="PAR > 0" value={isLoading ? '—' : fmtPct(grand.par0_pct)} sub="of POS" variant="amber" loading={isLoading} />
        <KpiCard label="PAR > 30" value={isLoading ? '—' : fmtPct(grand.par30_pct)} sub="of POS" variant="amber" loading={isLoading} />
        <KpiCard label="PAR > 90" value={isLoading ? '—' : fmtPct(grand.par90_pct)} sub="of POS" variant="red" loading={isLoading} />
        <KpiCard label="Written off (3M)" value={isLoading ? '—' : fmtN(grand.wo3m_count ?? 0)}
                 sub={`₹${fmtCr(grand.wo3m_amount ?? 0)} Cr`} variant="red" loading={isLoading} />
      </Box>

      {/* ── charts (collapsible — the matrix is the deliverable) ─────────── */}
      {showCharts && (
      <Box sx={{ display: 'grid', gap: 2, mb: 2,
                 gridTemplateColumns: { xs: '1fr', lg: '1.15fr 1fr' } }}>
        <Paper variant="outlined" sx={{ p: 1.5, borderColor: LINE }}>
          <Box sx={{ fontSize: '0.82rem', fontWeight: 700, color: INK }}>
            DPD mix by {cut}
          </Box>
          <Box sx={{ fontSize: '0.7rem', color: MUTED, mb: 1 }}>
            {measure === 'pos' ? '₹ Cr' : 'loans'} per bucket — the taller the red, the deeper the arrears
          </Box>
          {isLoading ? <Skeleton variant="rectangular" height={280} /> : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={stacked} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={LINE} vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: MUTED }} interval={0}
                       angle={-20} textAnchor="end" height={58} />
                <YAxis tick={{ fontSize: 10, fill: MUTED }} />
                <RTooltip formatter={(v: any) => measure === 'pos'
                  ? `₹${Number(v).toFixed(2)} Cr` : fmtN(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {BUCKETS.map((b) => (
                  <Bar key={b.label} dataKey={b.label} stackId="a" fill={BUCKET_COLORS[b.label]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </Paper>

        <Paper variant="outlined" sx={{ p: 1.5, borderColor: LINE }}>
          <Box sx={{ fontSize: '0.82rem', fontWeight: 700, color: INK }}>
            PAR &gt; 30% by {cut}
          </Box>
          <Box sx={{ fontSize: '0.7rem', color: MUTED, mb: 1 }}>
            ranked worst first · dashed line = book average {avgPar30.toFixed(2)}%
          </Box>
          {isLoading ? <Skeleton variant="rectangular" height={280} /> : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={risk} layout="vertical"
                        margin={{ top: 4, right: 44, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={LINE} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: MUTED }} unit="%" />
                <YAxis type="category" dataKey="name" width={124}
                       tick={{ fontSize: 10, fill: MUTED }} interval={0} />
                <ReferenceLine x={avgPar30} stroke="#94A3B8" strokeDasharray="4 4" />
                <RTooltip cursor={{ fill: 'rgba(15,23,42,0.04)' }}
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0].payload
                    return (
                      <Paper variant="outlined" sx={{ p: 1, fontSize: '0.72rem', borderColor: LINE }}>
                        <Box sx={{ fontWeight: 700, color: INK }}>{d.name}</Box>
                        <Box sx={{ color: MUTED }}>PAR&gt;30 {d.par30.toFixed(2)}%</Box>
                        <Box sx={{ color: MUTED }}>₹{fmtCr(d.pos)} Cr · {d.share.toFixed(1)}% of book</Box>
                        <Box sx={{ color: MUTED }}>{fmtN(d.n)} loans</Box>
                      </Paper>
                    )
                  }} />
                <Bar dataKey="par30" radius={[0, 3, 3, 0]} maxBarSize={22}>
                  {risk.map((d, i) => (
                    <Cell key={i} fill={d.par30 > avgPar30 ? '#DC2626' : '#16A34A'} fillOpacity={0.85} />
                  ))}
                  <LabelList dataKey="par30" position="right"
                             formatter={(v: number) => `${v.toFixed(1)}%`}
                             style={{ fontSize: 9, fill: MUTED }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Paper>
      </Box>

      )}

      {/* ── the Excel matrix ─────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ borderColor: LINE }}>
        <Box sx={{ p: 1.5, pb: 1 }}>
          <Box sx={{ fontSize: '0.82rem', fontWeight: 700, color: INK }}>{cut}</Box>
          <Box sx={{ fontSize: '0.7rem', color: MUTED }}>
            # loans and ₹ POS by DPD bucket · POS in ₹ Cr · PAR % of POS
          </Box>
        </Box>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" stickyHeader sx={{ minWidth: 1180 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, fontSize: '0.7rem', position: 'sticky',
                                 left: 0, zIndex: 3, background: '#fff',
                                 borderRight: `1px solid ${LINE}` }}>{nested ? `Business Segment / ${cut}` : cut}</TableCell>
                {BUCKETS.map((b) => (
                  <TableCell key={`n${b.key}`} align="right" sx={{ fontWeight: 700, fontSize: '0.7rem' }}>{b.label}</TableCell>
                ))}
                <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.7rem', borderRight: `1px solid ${LINE}` }}>Total #</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.7rem' }}>₹ Total Cr</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.7rem' }}>PAR&gt;0 %</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.7rem' }}>PAR&gt;30 %</TableCell>
                <Tooltip title="DPD > 90. The Excel sheet's PAR>90 column is arithmetically DPD > 60; that figure is the next column." placement="top">
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.7rem' }}>PAR&gt;90 %</TableCell>
                </Tooltip>
                <Tooltip title="DPD > 60 — reproduces the Excel sheet's PAR>90 column" placement="top">
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.7rem', color: MUTED }}>PAR&gt;60 %</TableCell>
                </Tooltip>
                <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.7rem', borderLeft: `1px solid ${LINE}` }}>W/O 3M #</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.7rem' }}>W/O 3M ₹ Cr</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={15}><Skeleton height={180} /></TableCell></TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={16} align="center"
                  sx={{ py: 5, color: MUTED, fontSize: '0.85rem' }}>
                  No loans for this selection.
                </TableCell></TableRow>
              )}
              {/* Single-level: the cut IS Business Segment, so render it flat. */}
              {!isLoading && !nested && rows.map((r) => (
                <TableRow key={r.name} hover sx={{ '&:nth-of-type(even)': { background: '#FCFDFF' } }}>
                  <TableCell sx={{ fontSize: '0.75rem', fontWeight: 600, position: 'sticky',
                                   left: 0, zIndex: 2, background: 'inherit',
                                   borderRight: `1px solid ${LINE}` }}>{r.name}</TableCell>
                  {BUCKETS.map((bk) => (
                    <TableCell key={bk.key} align="right" sx={{ fontSize: '0.75rem' }}>
                      {fmtN(r[`n_${bk.key}`] ?? 0)}
                    </TableCell>
                  ))}
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700, borderRight: `1px solid ${LINE}` }}>
                    {fmtN(r.n_total ?? 0)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{fmtCr(r.pos_total ?? 0)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem' }}>{fmtPct(r.par0_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem' }}>{fmtPct(r.par30_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem' }}>{fmtPct(r.par90_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', color: MUTED }}>{fmtPct(r.par60_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', borderLeft: `1px solid ${LINE}` }}>{fmtN(r.wo3m_count ?? 0)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem' }}>{fmtCr(r.wo3m_amount ?? 0)}</TableCell>
                </TableRow>
              ))}
              {/* Business Segment subtotal, then its cut values beneath —
                  the same shape as the Excel pivot. */}
              {!isLoading && nested && segments.map(({ seg, items, subtotal }) => [
                <TableRow key={`s-${seg}`} sx={{ bgcolor: '#F1F5F9' }}>
                  <TableCell sx={{ fontSize: '0.75rem', fontWeight: 800, position: 'sticky',
                                   left: 0, zIndex: 2, background: '#F1F5F9',
                                   borderRight: `1px solid ${LINE}` }}>{seg}</TableCell>
                  {BUCKETS.map((bk) => (
                    <TableCell key={bk.key} align="right" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>
                      {fmtN(subtotal[`n_${bk.key}`] ?? 0)}
                    </TableCell>
                  ))}
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800, borderRight: `1px solid ${LINE}` }}>
                    {fmtN(subtotal.n_total ?? 0)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtCr(subtotal.pos_total ?? 0)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{fmtPct(subtotal.par0_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{fmtPct(subtotal.par30_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{fmtPct(subtotal.par90_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700, color: MUTED }}>{fmtPct(subtotal.par60_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700, borderLeft: `1px solid ${LINE}` }}>{fmtN(subtotal.wo3m_count ?? 0)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{fmtCr(subtotal.wo3m_amount ?? 0)}</TableCell>
                </TableRow>,
                ...items.map((r) => (
                  <TableRow key={`${seg}-${r.name2}`} hover sx={{ '&:nth-of-type(even)': { background: '#FCFDFF' } }}>
                    <TableCell sx={{ fontSize: '0.75rem', pl: 3, color: '#334155', position: 'sticky',
                                     left: 0, zIndex: 2, background: 'inherit',
                                     borderRight: `1px solid ${LINE}` }}>{r.name2 ?? '—'}</TableCell>
                    {BUCKETS.map((bk) => (
                      <TableCell key={bk.key} align="right" sx={{ fontSize: '0.75rem' }}>
                        {fmtN(r[`n_${bk.key}`] ?? 0)}
                      </TableCell>
                    ))}
                    <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700, borderRight: `1px solid ${LINE}` }}>
                      {fmtN(r.n_total ?? 0)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{fmtCr(r.pos_total ?? 0)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.75rem' }}>{fmtPct(r.par0_pct)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.75rem' }}>{fmtPct(r.par30_pct)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.75rem',
                      color: (r.par90_pct ?? 0) > (grand.par90_pct ?? 0) ? '#DC2626' : 'inherit',
                      fontWeight: (r.par90_pct ?? 0) > (grand.par90_pct ?? 0) ? 700 : 400 }}>
                      {fmtPct(r.par90_pct)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.75rem', color: MUTED }}>{fmtPct(r.par60_pct)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.75rem', borderLeft: `1px solid ${LINE}` }}>{fmtN(r.wo3m_count ?? 0)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.75rem' }}>{fmtCr(r.wo3m_amount ?? 0)}</TableCell>
                  </TableRow>
                )),
              ])}
              {!isLoading && rows.length > 0 && (
                <TableRow sx={{ bgcolor: '#F8FAFC' }}>
                  <TableCell sx={{ fontSize: '0.75rem', fontWeight: 800, position: 'sticky',
                                   left: 0, zIndex: 2, background: '#F8FAFC',
                                   borderRight: `1px solid ${LINE}` }}>Grand Total</TableCell>
                  {BUCKETS.map((b) => (
                    <TableCell key={b.key} align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>
                      {fmtN(grand[`n_${b.key}`] ?? 0)}
                    </TableCell>
                  ))}
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800, borderRight: `1px solid ${LINE}` }}>
                    {fmtN(grand.n_total ?? 0)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtCr(grand.pos_total ?? 0)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtPct(grand.par0_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtPct(grand.par30_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtPct(grand.par90_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800, color: MUTED }}>{fmtPct(grand.par60_pct)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800, borderLeft: `1px solid ${LINE}` }}>
                    {fmtN(grand.wo3m_count ?? 0)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtCr(grand.wo3m_amount ?? 0)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Paper>
    </Box>
  )
}
