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
import Button from '@mui/material/Button'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  CartesianGrid, Legend, LabelList,
} from 'recharts'
import { api } from '../api/client'
import { useSlicerParams } from '../store/filterStore'
import { ExportCsvButton } from '../components/ExportCsvButton'
import { TrendSection } from '../components/TrendSection'

const INK = '#0F172A'
const MUTED = '#64748B'
const LINE = '#E2E8F0'
const WO = '#DC2626'      // written off
const REC = '#16A34A'     // recovered

const cr = (n: number) => n / 1e7
const fmtCr = (n: number) => `₹${cr(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Cr`
const fmtN = (n: number) => Math.round(n || 0).toLocaleString('en-IN')
const fmtPct = (n: number) => `${(n ?? 0).toFixed(2)}%`

const EXPORT_COLS: [string, string][] = [
  ['name', 'Group'],
  ['writeoff_count', '# Loans'],
  ['writeoff_amount', 'Write-off Amount'],
  ['sanctioned_amount', 'Sanctioned Amount'],
  ['recovery_amount', 'Recovered Amount'],
  ['recovery_pct', 'Recovery %'],
]

type Row = Record<string, any>

/**
 * Write-Off — write-off book and post-write-off recovery.
 *
 * No With / Excl W/O portfolio toggle: every loan here IS written off, so the
 * toggle would either change nothing or empty the page. The Write-off Year
 * picker takes its place — it selects the write-off VINTAGE, which is what makes
 * recovery readable (how much of the 2025 book has since come back).
 *
 * Business segment comes from the spec's product_id derivation, so JLG / IEL /
 * LAP match every other report.
 */
export function WriteOff() {
  const slicer = useSlicerParams()
  const [dim, setDim] = useState('business_segment')
  const [year, setYear] = useState('ALL')
  const [showChart, setShowChart] = useState(true)

  const params = { ...slicer, group_by: dim, ...(year !== 'ALL' ? { pick: year } : {}) }
  const { data, isLoading } = useQuery({
    queryKey: ['writeoff', params],
    queryFn: () => api.get('/api/writeoff/summary', { params }).then((r) => r.data),
  })

  const rows: Row[] = data?.rows ?? []
  const grand: Row = data?.grand ?? {}
  const dims: { value: string; label: string }[] = data?.dims ?? []
  const years: string[] = data?.filter?.options ?? []

  const chart = useMemo(() => rows
    .map((r) => ({
      name: String(r.name),
      wo: cr(Number(r.writeoff_amount) || 0),
      rec: cr(Number(r.recovery_amount) || 0),
      pct: Number(r.recovery_pct) || 0,
    }))
    .sort((a, b) => b.wo - a.wo)
    .slice(0, 12), [rows])

  const exportRows = useMemo(
    () => (rows.length ? [...rows, { ...grand, name: 'Grand Total' }] : []),
    [rows, grand])

  const dimLabel = dims.find((d) => d.value === dim)?.label ?? 'Group'

  return (
    <Box sx={{ px: 1.5, pb: 1.5 }}>
      {/* ── sticky command bar ─────────────────────────────────────────────── */}
      <Box sx={{ position: 'sticky', top: 0, zIndex: 30, bgcolor: '#fff',
                 pt: 1.25, pb: 0.85, mx: -1.5, px: 1.5,
                 borderBottom: `1px solid ${LINE}`,
                 boxShadow: '0 2px 6px -4px rgba(15,23,42,0.25)' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Box sx={{ fontSize: '1.2rem', fontWeight: 700, color: INK }}>Write-Off</Box>
          <Box sx={{ fontSize: '0.75rem', color: MUTED }}>as of {data?.as_of ?? '—'}</Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, ml: 1 }}>
            <Box sx={{ fontSize: '0.68rem', color: MUTED, fontWeight: 700 }}>GROUP BY</Box>
            <FormControl size="small">
              <Select value={dim} onChange={(e) => setDim(e.target.value)}
                sx={{ fontSize: '0.72rem', height: 28, minWidth: 150 }}>
                {dims.map((d) => (
                  <MenuItem key={d.value} value={d.value} sx={{ fontSize: '0.72rem' }}>{d.label}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box sx={{ fontSize: '0.68rem', color: MUTED, fontWeight: 700 }}>WRITE-OFF YEAR</Box>
            <FormControl size="small">
              <Select value={year} onChange={(e) => setYear(e.target.value)}
                sx={{ fontSize: '0.72rem', height: 28, minWidth: 110 }}>
                <MenuItem value="ALL" sx={{ fontSize: '0.72rem' }}>All years</MenuItem>
                {years.map((y) => (
                  <MenuItem key={y} value={y} sx={{ fontSize: '0.72rem' }}>{y}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          <Box sx={{ flex: 1 }} />
          <Button size="small" variant="text" onClick={() => setShowChart((v) => !v)}
            sx={{ fontSize: '0.68rem', textTransform: 'none', color: MUTED, minWidth: 0, px: 1 }}>
            {showChart ? 'Hide chart' : 'Show chart'}
          </Button>
          <ExportCsvButton rows={exportRows} columns={EXPORT_COLS} filename="write_off" />
        </Box>
      </Box>

      {/* ── cards ──────────────────────────────────────────────────────────── */}
      <Box sx={{ display: 'grid', gap: 1.25, mt: 1.5, mb: 1.5,
                 gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(2,1fr)', md: 'repeat(4,1fr)' } }}>
        {[
          { label: 'Write-off Amount', value: fmtCr(grand.writeoff_amount), accent: WO,
            foot: `${fmtN(grand.writeoff_count)} loans` },
          { label: 'Sanctioned Amount', value: fmtCr(grand.sanctioned_amount), accent: '#1565C0',
            foot: 'original sanction of the written-off book' },
          { label: 'Recovered Amount', value: fmtCr(grand.recovery_amount), accent: REC,
            foot: 'collected after write-off' },
          { label: 'Recovery %', value: fmtPct(grand.recovery_pct), accent: '#D97706',
            foot: 'recovered ÷ write-off amount' },
        ].map((c) => (
          <Paper key={c.label} variant="outlined"
            sx={{ p: 1.5, borderColor: LINE, borderLeft: `3px solid ${c.accent}` }}>
            <Box sx={{ fontSize: '0.62rem', fontWeight: 700, color: MUTED,
                       textTransform: 'uppercase', letterSpacing: '0.07em' }}>{c.label}</Box>
            <Box sx={{ fontSize: '1.35rem', fontWeight: 800, color: INK, mt: 0.3 }}>
              {isLoading ? <Skeleton width={110} /> : c.value}
            </Box>
            <Box sx={{ fontSize: '0.66rem', color: MUTED, mt: 0.2 }}>{c.foot}</Box>
          </Paper>
        ))}
      </Box>

      {/* ── chart: written off vs recovered, same scale, side by side ──────── */}
      {showChart && (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: LINE }}>
          <Box sx={{ fontSize: '0.8rem', fontWeight: 700, color: INK, mb: 0.75 }}>
            Write-off and recovery by {dimLabel} · ₹ Cr
          </Box>
          {isLoading ? <Skeleton variant="rectangular" height={260} /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chart} margin={{ top: 14, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={LINE} vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: MUTED }} interval={0}
                       angle={chart.length > 5 ? -18 : 0} textAnchor={chart.length > 5 ? 'end' : 'middle'}
                       height={chart.length > 5 ? 56 : 26} />
                <YAxis tick={{ fontSize: 10, fill: MUTED }} width={48} />
                <RTooltip contentStyle={{ fontSize: 11, borderRadius: 8 }}
                  cursor={{ fill: 'rgba(15,23,42,0.04)' }}
                  formatter={(v: any, n: any) => [`₹${Number(v).toFixed(2)} Cr`,
                    n === 'wo' ? 'Write-off Amount' : 'Recovered Amount']} />
                <Legend wrapperStyle={{ fontSize: 10 }}
                  formatter={(v) => (v === 'wo' ? 'Write-off Amount' : 'Recovered Amount')} />
                <Bar dataKey="wo" fill={WO} radius={[3, 3, 0, 0]} maxBarSize={46} />
                <Bar dataKey="rec" fill={REC} radius={[3, 3, 0, 0]} maxBarSize={46}>
                  <LabelList dataKey="pct" position="top"
                             formatter={(v: number) => (v ? `${v.toFixed(1)}%` : '')}
                             style={{ fontSize: 9, fill: MUTED }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Paper>
      )}

      {/* ── table ──────────────────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ borderColor: LINE }}>
        <Box sx={{ px: 1.25, py: 0.75, borderBottom: `1px solid ${LINE}`,
                   fontSize: '0.8rem', fontWeight: 700, color: INK }}>
          {dimLabel}
        </Box>
        <Box sx={{ overflow: 'auto', maxHeight: 'calc(100vh - 330px)' }}>
          <Table size="small" stickyHeader sx={{ '& thead th': { top: 0 } }}>
            <TableHead>
              <TableRow>
                {[dimLabel, '# Loans', 'Write-off Amount', 'Sanctioned Amount',
                  'Recovered Amount', 'Recovery %'].map((h, i) => (
                  <TableCell key={h} align={i === 0 ? 'left' : 'right'}
                    sx={{ fontWeight: 700, fontSize: '0.7rem', whiteSpace: 'nowrap',
                          background: '#F8FAFF',
                          ...(i === 0 ? { position: 'sticky', left: 0, zIndex: 3 } : {}) }}>
                    {h}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6}><Skeleton height={150} /></TableCell></TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={6} align="center"
                  sx={{ py: 5, color: MUTED, fontSize: '0.85rem' }}>
                  No written-off loans for this selection.
                </TableCell></TableRow>
              )}
              {!isLoading && rows.map((r) => (
                <TableRow key={r.name} hover sx={{ '&:nth-of-type(even)': { background: '#FCFDFF' } }}>
                  <TableCell sx={{ fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap',
                                   position: 'sticky', left: 0, zIndex: 2, background: 'inherit',
                                   borderRight: `1px solid ${LINE}` }}>{r.name}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem' }}>{fmtN(r.writeoff_count)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{fmtCr(r.writeoff_amount)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem' }}>{fmtCr(r.sanctioned_amount)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', color: REC }}>{fmtCr(r.recovery_amount)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{fmtPct(r.recovery_pct)}</TableCell>
                </TableRow>
              ))}
              {!isLoading && rows.length > 0 && (
                <TableRow sx={{ bgcolor: '#F8FAFC' }}>
                  <TableCell sx={{ fontSize: '0.75rem', fontWeight: 800, position: 'sticky',
                                   left: 0, zIndex: 2, background: '#F8FAFC',
                                   borderRight: `1px solid ${LINE}` }}>Grand Total</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtN(grand.writeoff_count)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtCr(grand.writeoff_amount)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtCr(grand.sanctioned_amount)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800, color: REC }}>{fmtCr(grand.recovery_amount)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: '0.75rem', fontWeight: 800 }}>{fmtPct(grand.recovery_pct)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Paper>

      <Box sx={{ mt: 1.5 }}>
        <TrendSection title="Trend — Write-off Recovery"
          measures={[{ key: 'wo_recovery', label: '₹ Recovered', format: 'inr' }]}
          portfolio="with" ap1={dim} />
      </Box>
    </Box>
  )
}
