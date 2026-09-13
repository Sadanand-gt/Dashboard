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
import { ExportCsvButton } from '../components/ExportCsvButton'
import { useSlicerParams } from '../store/filterStore'
import { DimSelect, fmtInr, fmtNum, inrUnit, fmtUnit, bucketRank } from './collectionShared'
import { TrendSection } from '../components/TrendSection'

// Full analysis-parameter set (rpt_od_slippage + dims enriched from rpt_od_list).
const AP_DIMS = [
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
const AP2_OPTIONS = [{ value: 'none', label: '— None —' }, ...AP_DIMS]

interface SlipCell { count: number; pos: number }
interface SlipRow { name: string; name2?: string | null; cells: SlipCell[]; total_count: number; total_pos: number; is_total?: boolean }
interface SlipResp { freqs: string[]; rows: SlipRow[] }
// Loan-wise export. Ships BOTH matrix-basis rows and the loans since written
// off, with the flag as a readable column, so one file reconciles to the card.
const OD_SLIP_EXPORT_COLS: [string, string][] = [
  ['loan_id', 'Loan ID'], ['business_segment', 'Business Segment'],
  ['loan_status', 'Loan Status'], ['in_od_matrix', 'OD Matrix Basis'],
  ['prev_slippage_count', 'Previous Slippages (12M)'], ['pos', 'POS'],
  ['zone_name', 'Zone'], ['cluster_name', 'Cluster'], ['region_name', 'Region'],
  ['area_name', 'Unit'], ['branch_name', 'Branch'], ['branch_id', 'Branch ID'],
  ['lo_id', 'Loan Officer ID'], ['state_id', 'State'], ['district_id', 'District'],
]

interface SlipKpis { total_count: number; total_pos: number; first_time: number; repeat: number
  all_count: number; excluded_writeoff: number }

export function OdSlippage() {
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

  const { data: kpis, isLoading: kpiLoading } = useQuery<SlipKpis>({
    queryKey: ['slip-kpis', params],
    queryFn: () => api.get('/api/od-slippage/kpis', { params }).then((r) => r.data),
  })
  const { data: resp, isLoading: tableLoading } = useQuery<SlipResp>({
    queryKey: ['slip-group', tableParams],
    queryFn: () => api.get('/api/od-slippage/group-summary', { params: tableParams }).then((r) => r.data),
  })
  const { data: refreshData } = useQuery<{ refresh: string }>({
    queryKey: ['aum-refresh'],
    queryFn: () => api.get('/api/aum/refresh').then((r) => r.data),
  })

  // Loan rows fetched on click, not held in the page — see ExportCsvButton.
  // Uses `params` (the slicer + portfolio set the cards use), so the file always
  // matches the figures on screen.
  const fetchSlipLoans = async () =>
    (await api.get('/api/od-slippage/loans', { params })).data.rows as Record<string, any>[]

  const freqs = resp?.freqs ?? []
  const rows = resp?.rows ?? []
  const ap1Label = AP_DIMS.find((o) => o.value === ap1)?.label ?? ''
  const ap2Label = AP_DIMS.find((o) => o.value === ap2)?.label ?? ''
  const hasAp2 = ap2 !== 'none'

  const sortedRows = useMemo(() => {
    if (ap1 !== 'dpd_bucket') return rows
    const body = rows.filter((r) => !r.is_total).slice().sort((a, b) => bucketRank(a.name) - bucketRank(b.name))
    const grand = rows.find((r) => r.is_total)
    return grand ? [...body, grand] : body
  }, [rows, ap1])

  // One consistent POS unit for the whole table (never mix Cr & L); unit in subtitle.
  const posUnit = useMemo(
    () => inrUnit(rows.flatMap((r) => [...r.cells.map((c) => c.pos), r.total_pos])),
    [rows])

  return (
    <Box className="space-y-3">
      {/* Top bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: '#0F172A', flexShrink: 0 }}>OD Slippage</Box>
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
        <Box sx={{ flex: 1, minWidth: 8 }} />
        <ExportCsvButton rows={[]} columns={OD_SLIP_EXPORT_COLS} fetchRows={fetchSlipLoans}
          filename="od_slippage_loans" />
        <Tooltip title="Freshly slipped into OD (Regular last month-end → OD now), as of T-1" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>As of</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' }}>{refreshData?.refresh ?? '—'}</Box>
          </Box>
        </Tooltip>
      </Box>

      {/* KPI cards */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        {/* Total reconciles to MTD FTOD on the collection report. The listed
            rows below exclude loans since written off — the OD Status matrix
            and the Excel sheet both drop them — so the split is shown here
            rather than leaving the page total looking short. */}
        {/* Total reconciles to MTD FTOD on the collection report. The rows
            listed below exclude loans since written off — the OD Status matrix
            and the Excel sheet both drop them — so the split rides on this
            card's sub-line rather than taking a card of its own. */}
        {/* The write-off split belongs to the With W/O view only. In Excl. W/O
            those loans are filtered out upstream, so the count is 0 by
            construction and "0 written off" reads as a finding rather than a
            tautology. Shown only when there is something to show. */}
        <KpiCard label="OD Slippage" value={kpis ? fmtNum(kpis.all_count) : '—'}
          sub={kpis && kpis.excluded_writeoff > 0
                 ? `${fmtNum(kpis.total_count)} listed · ${fmtNum(kpis.excluded_writeoff)} written off`
                 : ''}
          variant="red" loading={kpiLoading} />
        <KpiCard label="Slippage POS" value={kpis ? fmtInr(kpis.total_pos) : '—'} variant="default" loading={kpiLoading} />
        <KpiCard label="First-time" value={kpis ? fmtNum(kpis.first_time) : '—'} sub="0 previous slippages" variant="amber" loading={kpiLoading} />
        <KpiCard label="Repeat" value={kpis ? fmtNum(kpis.repeat) : '—'} sub="slipped before (12M)" variant="red" loading={kpiLoading} />
      </Box>

      {/* Table */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF' }}>
          <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>
            OD Slippage — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
          </Box>
          <Box sx={{ fontSize: '0.7rem', color: '#94A3B8' }}>by # of previous slippages (12M) · POS in {posUnit.label}</Box>
        </Box>
        {tableLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>{[1, 2, 3, 4].map((i) => <Skeleton key={i} height={32} />)}</Box>
        ) : (
          <Box sx={{ overflowX: 'auto', maxHeight: 520 }}>
            <Table size="small" stickyHeader sx={{ minWidth: hasAp2 ? 820 : 680 }}>
              <TableHead>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 700, color: '#1E40AF', fontSize: '0.7rem', whiteSpace: 'nowrap' } }}>
                  <TableCell rowSpan={2}>{ap1Label}</TableCell>
                  {hasAp2 && <TableCell rowSpan={2}>{ap2Label}</TableCell>}
                  {freqs.map((f) => <TableCell key={f} align="center" colSpan={2} sx={{ borderLeft: '2px solid #DBEAFE' }}>{f} prev</TableCell>)}
                  <TableCell align="right" rowSpan={2} sx={{ borderLeft: '2px solid #BFDBFE' }}>Total #</TableCell>
                  <TableCell align="right" rowSpan={2}>Total POS</TableCell>
                </TableRow>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 600, color: '#64748B', fontSize: '0.66rem' } }}>
                  {freqs.map((f) => [
                    <TableCell key={f + '#'} align="right" sx={{ borderLeft: '2px solid #EFF4FF' }}>#</TableCell>,
                    <TableCell key={f + 'p'} align="right">POS</TableCell>,
                  ])}
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedRows.map((row, ri) => (
                  <TableRow key={ri} sx={row.is_total
                    ? { borderTop: '2px solid #BFDBFE', background: '#EFF6FF', '& td': { fontWeight: 700, color: '#1E40AF' } }
                    : { '&:hover': { background: '#FAFBFF' } }}>
                    <TableCell sx={{ fontWeight: row.is_total ? 700 : 600, whiteSpace: 'nowrap' }}>{row.name}</TableCell>
                    {hasAp2 && <TableCell sx={{ color: '#475569', whiteSpace: 'nowrap' }}>{row.is_total ? '' : (row.name2 ?? '—')}</TableCell>}
                    {row.cells.map((c, ci) => [
                      <TableCell key={ci + '#'} align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.74rem', borderLeft: '2px solid #EFF4FF', color: c.count ? '#0F172A' : '#CBD5E1' }}>{c.count || '—'}</TableCell>,
                      <TableCell key={ci + 'p'} align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: c.pos ? '#334155' : '#CBD5E1' }}>{c.pos ? fmtUnit(c.pos, posUnit.div) : '—'}</TableCell>,
                    ])}
                    <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', fontWeight: 700, background: '#F8FAFF', borderLeft: '2px solid #EFF4FF' }}>{fmtNum(row.total_count)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.74rem', fontWeight: 700 }}>{fmtUnit(row.total_pos, posUnit.div)}</TableCell>
                  </TableRow>
                ))}
                {sortedRows.length === 0 && (
                  <TableRow><TableCell colSpan={hasAp2 ? 10 : 9} align="center" sx={{ py: 6, color: '#94A3B8', fontSize: '0.85rem' }}>No OD-slippage loans for this selection.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>

      <TrendSection title="Trend — OD Slippage"
        portfolio={includeWO ? 'with' : 'excl'} ap1={ap1} ap2={ap2}
        measures={[{ key: 'slip_count', label: '# OD Slippage', format: 'num' }, { key: 'slip_pos', label: '₹ OD Slippage', format: 'inr' }]} />

    </Box>
  )
}
