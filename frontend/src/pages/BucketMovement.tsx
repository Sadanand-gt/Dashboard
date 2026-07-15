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
import Divider from '@mui/material/Divider'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { useSlicerParams } from '../store/filterStore'
import { fmtInr, fmtNum, fmtPct } from './collectionShared'

interface MatrixRow { bucket: string; cells: number[]; total: number }
interface SummaryRow { bucket: string; value: number; improved_pct: number; static_pct: number; worsened_pct: number }
interface MatrixResp { buckets: string[]; pos: MatrixRow[]; loans: MatrixRow[]; summary_pos: SummaryRow[]; summary_loans: SummaryRow[] }
interface BmKpis {
  total_pos: number; loan_count: number
  improved_pct: number; static_pct: number; worsened_pct: number
  improved_count: number; static_count: number; worsened_count: number
}

type Metric = 'pos' | 'pct' | 'loans'

// Diagonal = static; below diagonal (curr > prev idx) = worsened (red); above = improved (green)
function cellTint(prevIdx: number, currIdx: number, v: number): string {
  if (!v) return 'transparent'
  if (currIdx === prevIdx) return 'rgba(100,116,139,0.06)'   // static — neutral
  if (currIdx > prevIdx) return 'rgba(220,38,38,0.10)'        // worsened — red
  return 'rgba(22,163,74,0.10)'                                // improved — green
}

export function BucketMovement() {
  const [metric, setMetric] = useState<Metric>('pos')
  const [includeWO, setIncludeWO] = useState(true)

  const slicer = useSlicerParams()
  const params = useMemo(() => ({
    ...slicer, ...(includeWO ? {} : { portfolio: 'without' }),
  }), [slicer, includeWO])

  const { data: kpis, isLoading: kpiLoading } = useQuery<BmKpis>({
    queryKey: ['bm-kpis', params],
    queryFn: () => api.get('/api/bucket-movement/kpis', { params }).then((r) => r.data),
  })
  const { data, isLoading: mLoading } = useQuery<MatrixResp>({
    queryKey: ['bm-matrix', params],
    queryFn: () => api.get('/api/bucket-movement/matrix', { params }).then((r) => r.data),
  })
  const { data: refreshData } = useQuery<{ refresh: string }>({
    queryKey: ['aum-refresh'],
    queryFn: () => api.get('/api/aum/refresh').then((r) => r.data),
  })

  const buckets = data?.buckets ?? []
  const rows = data ? (metric === 'loans' ? data.loans : data.pos) : []
  const posRows = data?.pos ?? []

  const fmtCell = (v: number, ri: number, ci: number): string => {
    if (!v) return '—'
    if (metric === 'loans') return fmtNum(v)
    if (metric === 'pos') return fmtInr(v)
    // pct = share of the previous-bucket row total (POS)
    const rowTot = posRows[ri]?.total ?? 0
    return rowTot ? fmtPct((posRows[ri].cells[ci] / rowTot) * 100) : '—'
  }

  return (
    <Box className="space-y-3">
      {/* Top bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: '#0F172A', flexShrink: 0 }}>Bucket Movement</Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}>
          <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Metric</Box>
          <ToggleButtonGroup value={metric} exclusive size="small" onChange={(_, v) => { if (v) setMetric(v) }} sx={{ height: 26 }}>
            <ToggleButton value="pos" sx={{ px: 1.2, fontSize: '0.68rem', height: 26 }}>POS ₹</ToggleButton>
            <ToggleButton value="pct" sx={{ px: 1.2, fontSize: '0.68rem', height: 26 }}>POS %</ToggleButton>
            <ToggleButton value="loans" sx={{ px: 1.2, fontSize: '0.68rem', height: 26 }}># Loans</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}>
          <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Portfolio</Box>
          <ToggleButtonGroup value={includeWO ? 'with' : 'without'} exclusive size="small"
            onChange={(_, v) => { if (v !== null) setIncludeWO(v === 'with') }} sx={{ height: 26 }}>
            <ToggleButton value="with" sx={{ px: 1.2, fontSize: '0.68rem', height: 26 }}>With W/O</ToggleButton>
            <ToggleButton value="without" sx={{ px: 1.2, fontSize: '0.68rem', height: 26 }}>Excl. W/O</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <Box sx={{ flex: 1, minWidth: 8 }} />
        <Tooltip title="Snapshot as of (T-1)" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>As of</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' }}>{refreshData?.refresh ?? '—'}</Box>
          </Box>
        </Tooltip>
      </Box>

      {/* KPIs */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        <KpiCard label="Total POS" value={kpis ? fmtInr(kpis.total_pos) : '—'} sub={kpis ? `${fmtNum(kpis.loan_count)} loans` : ''} variant="default" loading={kpiLoading} />
        <KpiCard label="Static" value={kpis ? fmtPct(kpis.static_pct) : '—'} sub={kpis ? `${fmtNum(kpis.static_count)} loans` : ''} variant="default" loading={kpiLoading} />
        <KpiCard label="Improved" value={kpis ? fmtPct(kpis.improved_pct) : '—'} sub={kpis ? `${fmtNum(kpis.improved_count)} loans` : ''} variant="green" loading={kpiLoading} />
        <KpiCard label="Worsened" value={kpis ? fmtPct(kpis.worsened_pct) : '—'} sub={kpis ? `${fmtNum(kpis.worsened_count)} loans` : ''} variant="red" loading={kpiLoading} />
      </Box>

      {/* Transition matrix */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF' }}>
          <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>
            Previous Month → Current Month ({metric === 'pos' ? 'POS ₹' : metric === 'pct' ? 'POS % of row' : '# Loans'})
          </Box>
          <Box sx={{ fontSize: '0.7rem', color: '#94A3B8' }}>green = improved · red = worsened</Box>
        </Box>
        {mLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={32} />)}</Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 820 }}>
              <TableHead>
                <TableRow>
                  <TableCell colSpan={2} sx={{ background: '#F8FAFF', border: 'none' }} />
                  <TableCell colSpan={buckets.length + 1} align="center" sx={{ background: '#EFF6FF', fontWeight: 700, color: '#1E40AF', fontSize: '0.72rem', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>Current Month</TableCell>
                </TableRow>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 700, color: '#1E40AF', fontSize: '0.7rem', whiteSpace: 'nowrap' } }}>
                  <TableCell>Previous Month</TableCell>
                  <TableCell />
                  {buckets.map((b) => <TableCell key={b} align="right">{b}</TableCell>)}
                  <TableCell align="right">Grand Total</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, ri) => {
                  const isTotal = row.bucket === 'Grand Total'
                  const prevIdx = buckets.indexOf(row.bucket)
                  return (
                    <TableRow key={ri} sx={isTotal
                      ? { borderTop: '2px solid #BFDBFE', background: '#EFF6FF', '& td': { fontWeight: 700, color: '#1E40AF' } }
                      : { '&:hover': { background: '#FAFBFF' } }}>
                      <TableCell colSpan={2} sx={{ fontWeight: isTotal ? 700 : 600, color: '#0F172A', whiteSpace: 'nowrap' }}>{row.bucket}</TableCell>
                      {row.cells.map((v, ci) => (
                        <TableCell key={ci} align="right"
                          sx={{
                            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.74rem', whiteSpace: 'nowrap',
                            background: isTotal ? undefined : cellTint(prevIdx, ci, v),
                            color: v ? '#0F172A' : '#CBD5E1',
                          }}>
                          {fmtCell(v, ri, ci)}
                        </TableCell>
                      ))}
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', fontWeight: 700, whiteSpace: 'nowrap', background: '#F8FAFF' }}>
                        {metric === 'loans' ? fmtNum(row.total) : metric === 'pos' ? fmtInr(row.total) : '100%'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>

      {/* Movement summary — Improved / Static / Worsened by previous bucket.
          Basis follows the metric toggle: POS-weighted, or # Loans-weighted. */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ px: 2.5, py: 1.25, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF', fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>
          Movement Summary — {metric === 'loans' ? '# Loans' : 'POS'} % by Previous Bucket
        </Box>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 480 }}>
            <TableHead>
              <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 700, color: '#1E40AF', fontSize: '0.72rem' } }}>
                <TableCell>Previous Bucket</TableCell>
                <TableCell align="right">{metric === 'loans' ? '# Loans' : 'POS'}</TableCell>
                <TableCell align="right">Improved</TableCell>
                <TableCell align="right">Static</TableCell>
                <TableCell align="right">Worsened</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {((metric === 'loans' ? data?.summary_loans : data?.summary_pos) ?? []).map((s, i) => {
                const isTotal = s.bucket === 'Total'
                return (
                  <TableRow key={i} sx={isTotal ? { borderTop: '2px solid #BFDBFE', background: '#EFF6FF', '& td': { fontWeight: 700, color: '#1E40AF' } } : { '&:hover': { background: '#FAFBFF' } }}>
                    <TableCell sx={{ fontWeight: isTotal ? 700 : 600 }}>{s.bucket}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', whiteSpace: 'nowrap' }}>{metric === 'loans' ? fmtNum(s.value) : fmtInr(s.value)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', color: '#16A34A' }}>{fmtPct(s.improved_pct)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', color: '#64748B' }}>{fmtPct(s.static_pct)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', color: '#DC2626' }}>{fmtPct(s.worsened_pct)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Box>
      </Paper>
    </Box>
  )
}
