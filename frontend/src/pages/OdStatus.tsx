import { useState, useMemo, useRef, useLayoutEffect } from 'react'
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
import { DimSelect, fmtInr, fmtNum, fmtPct } from './collectionShared'

// Full analysis-parameter set — mirrors Current Outstanding (Excel "Analysis Parameters").
// Default AP#1 = Branch ID & Name (Excel "OD Status" sheet).
const AP_DIMS = [
  { value: 'branch_name',         label: 'Branch ID & Name'     },
  { value: 'business_segment',    label: 'Business Segment'     },
  { value: 'zone_name',           label: 'Zone'                 },
  { value: 'cluster_name',        label: 'Cluster'              },
  { value: 'region_name',         label: 'Region'               },
  { value: 'area_name',           label: 'Unit'                 },
  { value: 'state_id',            label: 'Branch State'         },
  { value: 'district_id',         label: 'District'             },
  { value: 'prod_classification', label: 'Prod. Classification' },
  { value: 'dpd_bucket',          label: 'OD Bucket'            },
  { value: 'bucket_movement',     label: 'Curr Bucket Movement' },
  { value: 'loan_status',         label: 'Loan Status'          },
  { value: 'disb_year',           label: 'Disbursement Year'    },
  { value: 'cycle_no',            label: 'Cycle'                },
  { value: 'caste',               label: 'Caste'                },
  { value: 'religion',            label: 'Religion'             },
  { value: 'purpose_id',          label: 'Purpose ID'           },
  { value: 'facility_id',         label: 'Facility ID'          },
  { value: 'lender_id',           label: 'Lender ID'            },
]
const AP2_OPTIONS = [{ value: 'none', label: '— None —' }, ...AP_DIMS]

interface Cell { count: number; pos_pct: number }
interface MatrixRow { name: string; name2?: string | null; cells: Cell[]; total_count: number; total_pos: number; is_total?: boolean }
interface MatrixResp { states: string[]; rows: MatrixRow[] }
interface OdKpis { total_pos: number; loan_count: number; slippage: number; continuing: number; regularized: number; not_od: number }

// Previous-slippage frequency (last 12 months) — filter beside the Portfolio view.
const FREQ_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: '0',   label: '0' },
  { value: '1',   label: '1' },
  { value: '2',   label: '2' },
  { value: '3',   label: '3+' },
]

const STATE_COLOR: Record<string, string> = {
  'OD Slippage': '#DC2626', 'Continuing': '#D97706', 'Regularized': '#16A34A', 'Not OD': '#64748B',
}
function odStatusColor(s: string): string { return STATE_COLOR[s] ?? '#64748B' }

export function OdStatus() {
  // Two-row sticky header: MUI pins BOTH rows at top:0, so the 2nd row slides
  // under the 1st while scrolling. Measure row 1 and park row 2 right below it.
  const hdrRow1Ref = useRef<HTMLTableRowElement>(null)
  const [hdrRow1H, setHdrRow1H] = useState(44)

  const [ap1, setAp1] = useState('business_segment')
  const [ap2, setAp2] = useState('none')                // AP #2 (optional second group-by)
  const [includeWO, setIncludeWO] = useState(false)     // default Excl. W/O (matches Excel)
  const [freq, setFreq] = useState('all')               // Previous-slippage frequency filter

  const slicer = useSlicerParams()
  const params = useMemo(() => ({
    ...slicer, ...(includeWO ? {} : { portfolio: 'without' }),
  }), [slicer, includeWO])

  const { data: kpis, isLoading: kpiLoading } = useQuery<OdKpis>({
    queryKey: ['od-kpis', freq, params],
    queryFn: () => api.get('/api/od-status/kpis', { params: { ...params, freq } }).then((r) => r.data),
  })
  const { data: matrix, isLoading: mLoading } = useQuery<MatrixResp>({
    queryKey: ['od-matrix', ap1, ap2, freq, params],
    queryFn: () => api.get('/api/od-status/matrix', {
      params: { ...params, group_by: ap1, ...(ap2 !== 'none' ? { group_by_2: ap2 } : {}), freq },
    }).then((r) => r.data),
  })
  const { data: refreshData } = useQuery<{ refresh: string }>({
    queryKey: ['aum-refresh'],
    queryFn: () => api.get('/api/aum/refresh').then((r) => r.data),
  })

  const states = matrix?.states ?? []
  const ap1Label = AP_DIMS.find((o) => o.value === ap1)?.label ?? ''
  const ap2Label = AP_DIMS.find((o) => o.value === ap2)?.label ?? ''
  const hasAp2 = ap2 !== 'none'

  // Re-measure the 1st header row whenever the header can change shape.
  useLayoutEffect(() => {
    const h = hdrRow1Ref.current?.getBoundingClientRect().height
    if (h && Math.abs(h - hdrRow1H) > 0.5) setHdrRow1H(h)
  }, [states.length, hasAp2, mLoading, hdrRow1H])

  return (
    <Box className="space-y-3">
      {/* Top bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: '#0F172A', flexShrink: 0 }}>OD Status</Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="AP #1" value={ap1} options={AP_DIMS} onChange={setAp1} minWidth={160} />
        <DimSelect label="AP #2" value={ap2} options={AP2_OPTIONS} onChange={setAp2} minWidth={160} />
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}>
          <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Portfolio</Box>
          <ToggleButtonGroup value={includeWO ? 'with' : 'without'} exclusive size="small"
            onChange={(_, v) => { if (v !== null) setIncludeWO(v === 'with') }} sx={{ height: 26 }}>
            <ToggleButton value="with" sx={{ px: 1.2, fontSize: '0.68rem', height: 26 }}>With W/O</ToggleButton>
            <ToggleButton value="without" sx={{ px: 1.2, fontSize: '0.68rem', height: 26 }}>Excl. W/O</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <Tooltip title="No. of previous slippages in the last 12 months" placement="bottom">
          <Box sx={{ flexShrink: 0 }}>
            <DimSelect label="Freq (12M)" value={freq} options={FREQ_OPTIONS} onChange={setFreq} minWidth={92} />
          </Box>
        </Tooltip>
        <Box sx={{ flex: 1, minWidth: 8 }} />
        <Tooltip title="Snapshot as of (T-1)" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>As of</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' }}>{refreshData?.refresh ?? '—'}</Box>
          </Box>
        </Tooltip>
      </Box>

      {/* KPIs — counts by OD movement status */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        <KpiCard label="Total POS" value={kpis ? fmtInr(kpis.total_pos) : '—'} sub={kpis ? `${fmtNum(kpis.loan_count)} loans` : ''} variant="default" loading={kpiLoading} />
        <KpiCard label="OD Slippage" value={kpis ? fmtNum(kpis.slippage) : '—'} sub="loans" variant="red" loading={kpiLoading} />
        <KpiCard label="Continuing" value={kpis ? fmtNum(kpis.continuing) : '—'} sub="loans" variant="amber" loading={kpiLoading} />
        <KpiCard label="Regularized" value={kpis ? fmtNum(kpis.regularized) : '—'} sub="loans" variant="green" loading={kpiLoading} />
        <KpiCard label="Not OD" value={kpis ? fmtNum(kpis.not_od) : '—'} sub="loans" variant="default" loading={kpiLoading} />
      </Box>

      {/* OD Status matrix */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF' }}>
          <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>OD Status — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}</Box>
          <Box sx={{ fontSize: '0.7rem', color: '#94A3B8' }}>each status: # loans · POS % of row</Box>
        </Box>
        {mLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={30} />)}</Box>
        ) : (
          <Box sx={{ overflowX: 'auto', maxHeight: 420 }}>
            <Table size="small" stickyHeader sx={{ minWidth: hasAp2 ? 960 : 820 }}>
              <TableHead>
                {/* Two-row sticky header: MUI puts top:0 on BOTH rows, which makes
                    the 2nd row slide under the 1st while scrolling. Pin row 1 at
                    top:0 and row 2 just below it (HDR_ROW_H). rowSpan cells span
                    both rows, so they stay anchored at top:0. */}
                <TableRow ref={hdrRow1Ref} sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 700, color: '#1E40AF', fontSize: '0.7rem', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 3 } }}>
                  <TableCell rowSpan={2}>{ap1Label}</TableCell>
                  {hasAp2 && <TableCell rowSpan={2}>{ap2Label}</TableCell>}
                  {states.map((s) => <TableCell key={s} align="center" colSpan={2} sx={{ color: odStatusColor(s) }}>{s}</TableCell>)}
                  <TableCell align="right" rowSpan={2}>Total #</TableCell>
                </TableRow>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 600, color: '#64748B', fontSize: '0.66rem', position: 'sticky', top: hdrRow1H, zIndex: 3 } }}>
                  {states.map((s) => [
                    <TableCell key={s + '#'} align="right">#</TableCell>,
                    <TableCell key={s + '%'} align="right">POS %</TableCell>,
                  ])}
                </TableRow>
              </TableHead>
              <TableBody>
                {(matrix?.rows ?? []).map((row, ri) => (
                  <TableRow key={ri} sx={row.is_total
                    ? { borderTop: '2px solid #BFDBFE', background: '#EFF6FF', '& td': { fontWeight: 700, color: '#1E40AF' } }
                    : { '&:hover': { background: '#FAFBFF' } }}>
                    <TableCell sx={{ fontWeight: row.is_total ? 700 : 600, whiteSpace: 'nowrap' }}>{row.name}</TableCell>
                    {hasAp2 && <TableCell sx={{ color: '#475569', whiteSpace: 'nowrap' }}>{row.is_total ? '' : (row.name2 ?? '—')}</TableCell>}
                    {row.cells.map((c, ci) => [
                      <TableCell key={ci + '#'} align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.74rem', color: c.count ? '#0F172A' : '#CBD5E1' }}>{c.count || '—'}</TableCell>,
                      <TableCell key={ci + '%'} align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: c.pos_pct ? odStatusColor(states[ci]) : '#CBD5E1' }}>{c.pos_pct ? fmtPct(c.pos_pct) : '—'}</TableCell>,
                    ])}
                    <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', fontWeight: 700, background: '#F8FAFF' }}>{fmtNum(row.total_count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Box>
  )
}
