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
import { DimSelect, fmtNum, fmtPct } from './collectionShared'

// Analysis parameters available for DQ Category (columns present in rpt_dq_category).
const DQ_DIMS = [
  { value: 'business_segment',    label: 'Business Segment'     },
  { value: 'zone_name',           label: 'Zone'                 },
  { value: 'cluster_name',        label: 'Cluster'              },
  { value: 'region_name',         label: 'Region'               },
  { value: 'area_name',           label: 'Unit'                 },
  { value: 'branch_name',         label: 'Branch ID & Name'     },
  { value: 'state_id',            label: 'Branch State'         },
  { value: 'district_id',         label: 'District'             },
  { value: 'prod_classification', label: 'Prod. Classification' },
  { value: 'dpd_bucket',          label: 'OD Bucket'            },
  { value: 'loan_status',         label: 'Loan Status'          },
  { value: 'disb_year',           label: 'Disbursement Year'    },
  { value: 'cycle_no',            label: 'Cycle'                },
  { value: 'purpose_id',          label: 'Purpose ID'           },
  { value: 'facility_id',         label: 'Facility ID'          },
  { value: 'lender_id',           label: 'Lender ID'            },
  { value: 'caste',               label: 'Caste'                },
  { value: 'religion',            label: 'Religion'             },
]
const AP2_OPTIONS = [{ value: 'none', label: '— None —' }, ...DQ_DIMS]

interface DqRow {
  name: string; name2?: string | null
  early_eligible: number; early_count: number; early_pct: number
  infant_eligible: number; infant_count: number; infant_pct: number
  is_total?: boolean
}
interface DqKpis {
  early_eligible: number; early_count: number; early_pct: number
  infant_eligible: number; infant_count: number; infant_pct: number
}

function PctChip({ v }: { v: number }) {
  // Higher DQ% = worse (more early delinquency), so invert the collection colour scale.
  const c = v <= 1 ? '#16A34A' : v <= 3 ? '#D97706' : '#DC2626'
  return <Chip label={fmtPct(v)} size="small" sx={{ height: 18, fontSize: '0.68rem', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, background: `${c}18`, color: c, border: `1px solid ${c}40`, '& .MuiChip-label': { px: 0.75 } }} />
}

export function DqCategory() {
  const [ap1, setAp1] = useState('business_segment')   // Excel default AP#1 = BUSINESS SEGMENT
  const [ap2, setAp2] = useState('none')
  const [includeWO, setIncludeWO] = useState(false)    // default Excl. W/O

  const slicer = useSlicerParams()
  const params = useMemo(() => ({
    ...slicer, ...(includeWO ? {} : { portfolio: 'without' }),
  }), [slicer, includeWO])
  const tableParams = useMemo(() => ({
    ...params, group_by: ap1, ...(ap2 !== 'none' ? { group_by_2: ap2 } : {}),
  }), [params, ap1, ap2])

  const { data: kpis, isLoading: kpiLoading } = useQuery<DqKpis>({
    queryKey: ['dq-kpis', params],
    queryFn: () => api.get('/api/dq-category/kpis', { params }).then((r) => r.data),
  })
  const { data: rows = [], isLoading: tableLoading } = useQuery<DqRow[]>({
    queryKey: ['dq-group', tableParams],
    queryFn: () => api.get('/api/dq-category/group-summary', { params: tableParams }).then((r) => r.data),
  })
  const { data: refreshData } = useQuery<{ refresh: string }>({
    queryKey: ['dq-refresh'],
    queryFn: () => api.get('/api/dq-category/refresh').then((r) => r.data),
  })

  const ap1Label = DQ_DIMS.find((o) => o.value === ap1)?.label ?? ''
  const ap2Label = DQ_DIMS.find((o) => o.value === ap2)?.label ?? ''
  const hasAp2 = ap2 !== 'none'

  return (
    <Box className="space-y-3">
      {/* Top bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: '#0F172A', flexShrink: 0 }}>DQ Category</Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="AP #1" value={ap1} options={DQ_DIMS} onChange={setAp1} minWidth={160} />
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
        <Box sx={{ flex: 1, minWidth: 8 }} />
        <Tooltip title="Snapshot as of (T-1)" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>As of</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' }}>{refreshData?.refresh ?? '—'}</Box>
          </Box>
        </Tooltip>
      </Box>

      {/* KPI cards — DQ % and DQ Count for Early & Infant */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        <KpiCard label="Early DQ %" value={kpis ? fmtPct(kpis.early_pct) : '—'} sub={kpis ? `of ${fmtNum(kpis.early_eligible)} eligible` : ''} variant={kpis && kpis.early_pct <= 1 ? 'green' : kpis && kpis.early_pct <= 3 ? 'amber' : 'red'} loading={kpiLoading} />
        <KpiCard label="Infant DQ %" value={kpis ? fmtPct(kpis.infant_pct) : '—'} sub={kpis ? `of ${fmtNum(kpis.infant_eligible)} eligible` : ''} variant={kpis && kpis.infant_pct <= 1 ? 'green' : kpis && kpis.infant_pct <= 3 ? 'amber' : 'red'} loading={kpiLoading} />
        <KpiCard label="Early DQ Count" value={kpis ? fmtNum(kpis.early_count) : '—'} sub="eligible & OD" variant="default" loading={kpiLoading} />
        <KpiCard label="Infant DQ Count" value={kpis ? fmtNum(kpis.infant_count) : '—'} sub="eligible & OD" variant="default" loading={kpiLoading} />
      </Box>

      {/* Table */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF' }}>
          <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>
            DQ Category — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
          </Box>
          <Box sx={{ fontSize: '0.7rem', color: '#94A3B8' }}>DQ % = POS-weighted OD share of eligible</Box>
        </Box>
        {tableLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={32} />)}</Box>
        ) : (
          <Box sx={{ overflowX: 'auto', maxHeight: 520 }}>
            <Table size="small" stickyHeader sx={{ minWidth: hasAp2 ? 900 : 760 }}>
              <TableHead>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 700, color: '#1E40AF', fontSize: '0.7rem', whiteSpace: 'nowrap' } }}>
                  <TableCell rowSpan={2}>{ap1Label}</TableCell>
                  {hasAp2 && <TableCell rowSpan={2}>{ap2Label}</TableCell>}
                  <TableCell align="center" colSpan={3} sx={{ borderLeft: '2px solid #BFDBFE' }}>Early DQ</TableCell>
                  <TableCell align="center" colSpan={3} sx={{ borderLeft: '2px solid #FDE68A' }}>Infant DQ</TableCell>
                </TableRow>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 600, color: '#64748B', fontSize: '0.66rem' } }}>
                  <TableCell align="right" sx={{ borderLeft: '2px solid #DBEAFE' }}>Eligible</TableCell>
                  <TableCell align="right">Count</TableCell>
                  <TableCell align="right">%</TableCell>
                  <TableCell align="right" sx={{ borderLeft: '2px solid #FEF3C7' }}>Eligible</TableCell>
                  <TableCell align="right">Count</TableCell>
                  <TableCell align="right">%</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, i) => {
                  const isGrand = row.is_total || row.name === 'Grand Total'
                  return (
                    <TableRow key={i} sx={isGrand
                      ? { borderTop: '2px solid #BFDBFE', background: '#EFF6FF', '& td': { fontWeight: 700, color: '#1E40AF' } }
                      : { '&:hover': { background: '#F8FAFF' } }}>
                      <TableCell sx={{ fontWeight: isGrand ? 700 : 600, whiteSpace: 'nowrap' }}>{row.name}</TableCell>
                      {hasAp2 && <TableCell sx={{ color: '#475569', whiteSpace: 'nowrap' }}>{isGrand ? '' : (row.name2 ?? '—')}</TableCell>}
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', borderLeft: '2px solid #DBEAFE' }}>{fmtNum(row.early_eligible)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem' }}>{fmtNum(row.early_count)}</TableCell>
                      <TableCell align="right"><PctChip v={row.early_pct} /></TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', borderLeft: '2px solid #FEF3C7' }}>{fmtNum(row.infant_eligible)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem' }}>{fmtNum(row.infant_count)}</TableCell>
                      <TableCell align="right"><PctChip v={row.infant_pct} /></TableCell>
                    </TableRow>
                  )
                })}
                {rows.length === 0 && (
                  <TableRow><TableCell colSpan={hasAp2 ? 8 : 7} align="center" sx={{ py: 6, color: '#94A3B8', fontSize: '0.85rem' }}>No data for this selection.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Box>
  )
}
