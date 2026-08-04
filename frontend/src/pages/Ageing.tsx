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
import Divider from '@mui/material/Divider'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { useSlicerParams } from '../store/filterStore'
import { COLLECTION_DIMS, DimSelect, fmtInr, fmtNum, fmtPct } from './collectionShared'

// Ageing AP set = same analysis parameters as Current Outstanding
const AGEING_DIMS = [
  { value: 'business_segment',    label: 'Business Segment'     },
  ...COLLECTION_DIMS.filter((d) => d.value !== 'business_segment'),
]
const AP2_OPTIONS = [{ value: 'none', label: '— None —' }, ...AGEING_DIMS]

interface AgeingRow {
  name: string
  name2: string | null
  kind: 'group' | 'row' | 'total'
  pos: number
  pct: number
  loans: number
  od_amt: number
  ce: number
  od_to_disb: number
}
interface AgeingKpis {
  total_pos: number; loan_count: number; od_amt: number
  od_pct: number; loans_in_od: number; od_to_disb: number
}

// OD-to-Disb: higher = worse → red
function odColor(v: number): string {
  if (v < 1) return '#16A34A'
  if (v < 3) return '#D97706'
  return '#DC2626'
}

export function Ageing() {
  const [ap1, setAp1] = useState('business_segment')
  const [ap2, setAp2] = useState('none')
  const [includeWO, setIncludeWO] = useState(false)  // default Excl. W/O (matches Excel)

  const slicer = useSlicerParams()
  const params = useMemo(() => ({
    ...slicer, ...(includeWO ? {} : { portfolio: 'without' }),
  }), [slicer, includeWO])
  const tableParams = useMemo(() => ({
    ...params, group_by: ap1, group_by_2: ap2,
  }), [params, ap1, ap2])

  const { data: kpis, isLoading: kpiLoading } = useQuery<AgeingKpis>({
    queryKey: ['ageing-kpis', params],
    queryFn: () => api.get('/api/ageing/kpis', { params }).then((r) => r.data),
  })
  const { data: rows = [], isLoading: tableLoading } = useQuery<AgeingRow[]>({
    queryKey: ['ageing-group', tableParams],
    queryFn: () => api.get('/api/ageing/group-summary', { params: tableParams }).then((r) => r.data),
  })
  const { data: refreshData } = useQuery<{ refresh: string }>({
    queryKey: ['aum-refresh'],
    queryFn: () => api.get('/api/aum/refresh').then((r) => r.data),
  })

  const ap1Label = AGEING_DIMS.find((o) => o.value === ap1)?.label ?? ''
  const ap2Label = AGEING_DIMS.find((o) => o.value === ap2)?.label ?? ''
  const hasAp2 = ap2 !== 'none'

  return (
    <Box className="space-y-3">
      {/* Top bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: '#0F172A', flexShrink: 0 }}>Ageing Analysis</Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="AP #1" value={ap1} options={AGEING_DIMS} onChange={setAp1} minWidth={170} />
        <DimSelect label="AP #2" value={ap2} options={AP2_OPTIONS} onChange={setAp2} minWidth={170} />
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

      {/* KPI cards */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        <KpiCard label="Total POS" value={kpis ? fmtInr(kpis.total_pos) : '—'} sub={kpis ? `${fmtNum(kpis.loan_count)} loans` : ''} variant="default" loading={kpiLoading} />
        <KpiCard label="OD Amount" value={kpis ? fmtInr(kpis.od_amt) : '—'} sub={kpis ? `${fmtPct(kpis.od_pct)} of POS` : ''} variant="amber" loading={kpiLoading} />
        <KpiCard label="Loans in OD" value={kpis ? fmtNum(kpis.loans_in_od) : '—'} sub={kpis ? `of ${fmtNum(kpis.loan_count)} loans` : ''} variant="red" loading={kpiLoading} />
        <KpiCard label="OD-to-POS %" value={kpis ? fmtPct(kpis.od_to_disb) : '—'} variant={kpis && kpis.od_to_disb < 1 ? 'green' : kpis && kpis.od_to_disb < 3 ? 'amber' : 'red'} loading={kpiLoading} />
      </Box>

      {/* Table */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF' }}>
          <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>
            Ageing Analysis — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
          </Box>
          <Box sx={{ fontSize: '0.7rem', color: '#94A3B8' }}>% = POS share within {ap1Label}</Box>
        </Box>
        {tableLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={34} />)}</Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 760 }}>
              <TableHead>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 700, color: '#1E40AF', fontSize: '0.72rem', whiteSpace: 'nowrap' } }}>
                  <TableCell>Analysis Parameter</TableCell>
                  <TableCell align="right">POS</TableCell>
                  <TableCell align="right">%</TableCell>
                  <TableCell align="right"># Loans</TableCell>
                  <TableCell align="right">OD Amt</TableCell>
                  <TableCell align="right">OD-to-POS %</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r, i) => {
                  const isGroup = r.kind === 'group'
                  const isTotal = r.kind === 'total'
                  const bold = isGroup || isTotal
                  const label = isTotal ? 'Grand Total' : (r.kind === 'row' && hasAp2 ? r.name2 : r.name)
                  return (
                    <TableRow key={i} sx={{
                      ...(isTotal ? { borderTop: '2px solid #BFDBFE', background: '#EFF6FF' } : {}),
                      ...(isGroup ? { background: '#F8FAFF' } : {}),
                      '&:hover': isTotal ? {} : { background: '#F8FAFF' },
                      '& td': bold ? { fontWeight: 700, color: isTotal ? '#1E40AF' : '#0F172A' } : {},
                    }}>
                      <TableCell sx={{ pl: r.kind === 'row' && hasAp2 ? 3.5 : 2, whiteSpace: 'nowrap' }}>{label}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtInr(r.pos)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', color: '#64748B' }}>{fmtPct(r.pct)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem' }}>{fmtNum(r.loans)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap', color: r.od_amt > 0 ? '#B45309' : '#94A3B8' }}>{r.od_amt > 0 ? fmtInr(r.od_amt) : '—'}</TableCell>
                      <TableCell align="right"><PctChip v={r.od_to_disb} color={odColor(r.od_to_disb)} muteZero /></TableCell>
                    </TableRow>
                  )
                })}
                {rows.length === 0 && (
                  <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6, color: '#94A3B8', fontSize: '0.85rem' }}>No data for this selection.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Box>
  )
}

function PctChip({ v, color, muteZero }: { v: number; color: string; muteZero?: boolean }) {
  if (muteZero && !v) return <Box component="span" sx={{ color: '#94A3B8', fontSize: '0.76rem' }}>—</Box>
  return <Chip label={fmtPct(v)} size="small" sx={{
    height: 18, fontSize: '0.68rem', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700,
    background: `${color}18`, color, border: `1px solid ${color}40`, '& .MuiChip-label': { px: 0.75 },
  }} />
}
