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
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  CartesianGrid, Legend, ScatterChart, Scatter, ZAxis, Cell, ReferenceLine,
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
  ['name', 'Cut'],
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

type Row = Record<string, any>

export function PortfolioCuts() {
  const slicer = useSlicerParams()
  const [cut, setCut] = useState('Business Segment')
  const [portfolio, setPortfolio] = useState<'without' | 'with'>('without')
  const [measure, setMeasure] = useState<'pos' | 'n'>('pos')

  const params = { ...slicer, group_by: 'cut_value', pick: cut, portfolio }
  const { data, isLoading } = useQuery({
    queryKey: ['portfolio-cuts', params],
    queryFn: () => api.get('/api/portfolio-cuts/summary', { params }).then((r) => r.data),
  })

  const rows: Row[] = data?.rows ?? []
  const grand: Row = data?.grand ?? {}

  // Concentration vs risk: x = share of the book, y = PAR>30%, bubble = POS.
  // This is the view no single Excel sheet gives — it answers "which slices are
  // big AND deteriorating" in one glance.
  const scatter = useMemo(() => {
    const tot = Number(grand.pos_total) || 0
    return rows.map((r) => ({
      name: r.name,
      share: tot ? (Number(r.pos_total) / tot) * 100 : 0,
      par30: Number(r.par30_pct) || 0,
      pos: Number(r.pos_total) || 0,
      n: Number(r.n_total) || 0,
    }))
  }, [rows, grand])

  const avgPar30 = Number(grand.par30_pct) || 0

  // Rows plus the Grand Total, so the file reconciles on its own.
  const exportRows = useMemo(
    () => (rows.length ? [...rows, { ...grand, name: 'Grand Total' }] : []),
    [rows, grand])

  const stacked = useMemo(() => rows.map((r) => {
    const o: Row = { name: r.name }
    BUCKETS.forEach((b) => {
      o[b.label] = measure === 'pos' ? cr(Number(r[`pos_${b.key}`]) || 0) : Number(r[`n_${b.key}`]) || 0
    })
    return o
  }), [rows, measure])

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

      {/* ── charts ───────────────────────────────────────────────────────── */}
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
            Concentration vs risk
          </Box>
          <Box sx={{ fontSize: '0.7rem', color: MUTED, mb: 1 }}>
            share of POS (x) against PAR&gt;30% (y), bubble = POS. Top-right = large and deteriorating.
          </Box>
          {isLoading ? <Skeleton variant="rectangular" height={280} /> : (
            <ResponsiveContainer width="100%" height={280}>
              <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={LINE} />
                <XAxis type="number" dataKey="share" name="Share of POS" unit="%"
                       tick={{ fontSize: 10, fill: MUTED }}
                       label={{ value: 'share of POS %', position: 'insideBottom', offset: -8,
                                style: { fontSize: 10, fill: MUTED } }} />
                <YAxis type="number" dataKey="par30" name="PAR>30" unit="%"
                       tick={{ fontSize: 10, fill: MUTED }} />
                <ZAxis type="number" dataKey="pos" range={[60, 700]} />
                <ReferenceLine y={avgPar30} stroke="#94A3B8" strokeDasharray="4 4"
                               label={{ value: `book ${avgPar30.toFixed(2)}%`, position: 'right',
                                        style: { fontSize: 9, fill: MUTED } }} />
                <RTooltip cursor={{ strokeDasharray: '3 3' }} content={({ active, payload }: any) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload
                  return (
                    <Paper variant="outlined" sx={{ p: 1, fontSize: '0.72rem', borderColor: LINE }}>
                      <Box sx={{ fontWeight: 700, color: INK }}>{d.name}</Box>
                      <Box sx={{ color: MUTED }}>₹{fmtCr(d.pos)} Cr · {fmtN(d.n)} loans</Box>
                      <Box sx={{ color: MUTED }}>{d.share.toFixed(1)}% of book · PAR&gt;30 {d.par30.toFixed(2)}%</Box>
                    </Paper>
                  )
                }} />
                <Scatter data={scatter}>
                  {scatter.map((d, i) => (
                    <Cell key={i} fill={d.par30 > avgPar30 ? '#DC2626' : '#16A34A'} fillOpacity={0.65} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </Paper>
      </Box>

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
                <TableCell sx={{ fontWeight: 700, fontSize: '0.7rem' }}>{cut}</TableCell>
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
                <TableRow><TableCell colSpan={15} align="center"
                  sx={{ py: 5, color: MUTED, fontSize: '0.85rem' }}>
                  No loans for this selection.
                </TableCell></TableRow>
              )}
              {!isLoading && rows.map((r) => (
                <TableRow key={r.name} hover>
                  <TableCell sx={{ fontSize: '0.75rem', fontWeight: 600 }}>{r.name}</TableCell>
                  {BUCKETS.map((b) => (
                    <TableCell key={b.key} align="right" sx={{ fontSize: '0.75rem' }}>
                      {fmtN(r[`n_${b.key}`] ?? 0)}
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
              ))}
              {!isLoading && rows.length > 0 && (
                <TableRow sx={{ bgcolor: '#F8FAFC' }}>
                  <TableCell sx={{ fontSize: '0.75rem', fontWeight: 800 }}>Grand Total</TableCell>
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
