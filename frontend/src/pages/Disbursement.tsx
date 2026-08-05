import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import TableSortLabel from '@mui/material/TableSortLabel'
import Skeleton from '@mui/material/Skeleton'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import Divider from '@mui/material/Divider'
import Tooltip from '@mui/material/Tooltip'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { useSlicerParams } from '../store/filterStore'
import { TrendSection } from '../components/TrendSection'

// ── Analysis Parameters meaningful for a disbursement event ───────────────────
// (Risk / current-state dimensions like OD Bucket, Loan Status, Bucket Movement
//  don't apply to a point-in-time disbursement, so they're intentionally omitted.)
const DIM_OPTIONS = [
  { value: 'business_segment',    label: 'Business Segment'     },
  { value: 'zone_name',           label: 'Zone'                 },
  { value: 'cluster_name',        label: 'Cluster'              },
  { value: 'region_name',         label: 'Region'               },
  { value: 'area_name',           label: 'Unit'                 },
  { value: 'branch_name',         label: 'Branch ID & Name'     },
  { value: 'state_id',            label: 'Branch State'         },
  { value: 'district_id',         label: 'District'             },
  { value: 'prod_classification', label: 'Prod. Classification' },
  { value: 'product_id',          label: 'Product ID'           },
  { value: 'disb_year',           label: 'Disbursement Year'    },
  { value: 'cycle_no',            label: 'Cycle'                },
  { value: 'purpose_id',          label: 'Purpose ID'           },
  { value: 'facility_id',         label: 'Facility ID'          },
  { value: 'lender_id',           label: 'Lender ID'            },
  { value: 'caste',               label: 'Caste'                },
  { value: 'religion',            label: 'Religion'             },
  { value: 'lo_id',               label: 'LO'                   },
]
const AP2_OPTIONS = [{ value: 'none', label: '— None —' }, ...DIM_OPTIONS]

// ── Formatters ─────────────────────────────────────────────────────────────────
function fmtInr(v: number): string {
  if (!v && v !== 0) return '—'
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
function fmtNum(v: number): string { return (v ?? 0).toLocaleString('en-IN') }
// One INR unit for a column so amounts read consistently (never mix Cr & L); unit shown in header.
function inrUnit(values: number[]): { div: number; label: string } {
  const max = Math.max(0, ...values.map((v) => Math.abs(v || 0)))
  if (max >= 1e7) return { div: 1e7, label: '₹ Cr' }
  if (max >= 1e5) return { div: 1e5, label: '₹ L' }
  return { div: 1, label: '₹' }
}
function fmtUnit(v: number, div: number): string {
  if (v == null || (!v && v !== 0)) return '—'
  if (div === 1) return (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
  return (v / div).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ── Types ──────────────────────────────────────────────────────────────────────
interface DisbKpis {
  t1_count: number; t1_amount: number; t1_avg: number
  pmsd_count: number; pmsd_amount: number; pmsd_avg: number
  mtd_count: number; mtd_amount: number; mtd_avg: number
  pmtd_count: number; pmtd_amount: number; pmtd_avg: number
  ytd_count: number; ytd_amount: number; ytd_avg: number
}

interface GroupRow {
  name: string; name2?: string | null
  t1_count: number; t1_amount: number; t1_avg: number
  mtd_count: number; mtd_amount: number; mtd_avg: number
  ytd_count?: number; ytd_amount?: number
}

type SortField = keyof Omit<GroupRow, 'name2'>

interface DisbTrendPoint {
  period: string
  amount?: number; count?: number; growth?: number
  cur?: number | null; prev?: number | null; yoy_pct?: number | null
}
interface DisbTrendResp {
  fys: string[]
  points: DisbTrendPoint[]
  cur_fy?: string
  prev_fy?: string
}

// ── Inline dimension select ────────────────────────────────────────────────────
function DimSelect({ label, value, options, onChange, minWidth = 148 }: {
  label: string; value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void; minWidth?: number
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
      <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>
        {label}
      </Box>
      <FormControl size="small" sx={{ minWidth }}>
        <Select
          value={value} onChange={(e) => onChange(e.target.value)} displayEmpty
          sx={{ fontSize: '0.74rem', height: 26, '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(0,0,0,0.15)' } }}
        >
          {options.map((o) => (
            <MenuItem key={o.value} value={o.value} sx={{ fontSize: '0.74rem' }}>{o.label}</MenuItem>
          ))}
        </Select>
      </FormControl>
    </Box>
  )
}

// ── Sort cell ──────────────────────────────────────────────────────────────────
function SortCell<T extends string>({ label, field, active, dir, onSort, align = 'left' }: {
  label: string; field: T; active: boolean; dir: 'asc' | 'desc'
  onSort: (f: T) => void; align?: 'left' | 'right'
}) {
  return (
    <TableCell align={align} sx={{ whiteSpace: 'nowrap', py: 0.5 }}>
      <TableSortLabel
        active={active} direction={active ? dir : 'desc'} onClick={() => onSort(field)}
        sx={{ color: '#1E40AF !important', '& .MuiTableSortLabel-icon': { color: '#1565C0 !important' } }}
      >
        {label}
      </TableSortLabel>
    </TableCell>
  )
}

const SEGMENT_COLORS: Record<string, string> = { IEL: '#1565C0', JLG: '#16A34A', LAP: '#7C3AED' }

// ── Component ──────────────────────────────────────────────────────────────────
export function Disbursement() {
  const [ap1, setAp1] = useState('business_segment')
  const [ap2, setAp2] = useState('none')
  const [sortField, setSortField] = useState<SortField>('mtd_amount')
  const [sortDir,   setSortDir]   = useState<'asc' | 'desc'>('desc')

  const slicerParams = useSlicerParams()

  const tableParams = useMemo(() => ({
    ...slicerParams,
    group_by: ap1,
    ...(ap2 !== 'none' ? { group_by_2: ap2 } : {}),
  }), [slicerParams, ap1, ap2])

  const { data: kpis, isLoading: kpiLoading } = useQuery<DisbKpis>({
    queryKey: ['disb-kpis', slicerParams],
    queryFn:  () => api.get('/api/disbursement/kpis', { params: slicerParams }).then((r) => r.data),
  })

  const { data: tableRows = [], isLoading: tableLoading } = useQuery<GroupRow[]>({
    queryKey: ['disb-group', tableParams],
    queryFn:  () => api.get('/api/disbursement/group-summary', { params: tableParams }).then((r) => r.data),
  })

  const { data: refreshData } = useQuery<{ refresh: string }>({
    queryKey: ['disb-refresh'],
    queryFn:  () => api.get('/api/disbursement/refresh').then((r) => r.data),
  })

  const handleSort = (field: SortField) => {
    if (field === sortField) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
  }

  const sortedRows = useMemo(() => {
    const body  = tableRows.filter((r) => r.name !== 'Grand Total')
    const grand = tableRows.find((r)  => r.name === 'Grand Total')
    body.sort((a, b) => {
      const av = a[sortField], bv = b[sortField]
      if (typeof av === 'number' && typeof bv === 'number')
        return sortDir === 'asc' ? av - bv : bv - av
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av))
    })
    return grand ? [...body, grand] : body
  }, [tableRows, sortField, sortDir])

  // Consistent units: one for disbursed Amount, one for Avg ticket (shown in headers).
  const amtUnit = useMemo(() => inrUnit(tableRows.flatMap((r) => [r.t1_amount, r.mtd_amount])), [tableRows])
  const avgUnit = useMemo(() => inrUnit(tableRows.flatMap((r) => [r.t1_avg, r.mtd_avg])), [tableRows])

  const ap1Label  = DIM_OPTIONS.find((o) => o.value === ap1)?.label ?? ''
  const ap2Label  = DIM_OPTIONS.find((o) => o.value === ap2)?.label ?? ''
  const hasAp2    = ap2 !== 'none'
  const tableTitle = hasAp2
    ? `Disbursements — ${ap1Label} × ${ap2Label}`
    : `Disbursements — ${ap1Label}`

  // Sub-label helpers — MTD cards show PMTD comparison; YTD cards show the FY window.
  const pmtdCountSub  = kpis ? `PMTD: ${fmtNum(kpis.pmtd_count)} loans` : ''
  const pmtdAmountSub = kpis ? `PMTD: ${fmtInr(kpis.pmtd_amount)}`      : ''
  const pmtdAvgSub    = kpis ? `PMTD avg: ${fmtInr(kpis.pmtd_avg)}`     : ''
  const ytdWindowSub  = 'FY: 1 Apr → T-1'

  return (
    <Box className="space-y-3">

      {/* ── Top bar ── */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap',
        background: '#FFFFFF', borderRadius: 2, px: 2, py: 0.75,
        border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: '#0F172A', flexShrink: 0 }}>
          Disbursements
        </Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="AP #1" value={ap1} options={DIM_OPTIONS}  onChange={setAp1} minWidth={170} />
        <DimSelect label="AP #2" value={ap2} options={AP2_OPTIONS} onChange={setAp2} minWidth={170} />
        <Box sx={{ flex: 1, minWidth: 8 }} />
        <Tooltip title="Last pipeline run" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>As of</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {refreshData?.refresh ?? '—'}
            </Box>
          </Box>
        </Tooltip>
      </Box>

      {/* ── KPI Cards — YTD (FY) group + MTD group ── */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        {/* YTD (FY 1 Apr → T-1) — replaces the T-1 cards; the T-1 table below is unchanged */}
        <KpiCard
          label="YTD Count"
          value={kpis ? fmtNum(kpis.ytd_count) : '—'}
          sub={ytdWindowSub}
          variant="default"
          loading={kpiLoading}
        />
        <KpiCard
          label="YTD Amount"
          value={kpis ? fmtInr(kpis.ytd_amount) : '—'}
          sub={ytdWindowSub}
          variant="default"
          loading={kpiLoading}
        />
        <KpiCard
          label="Avg YTD"
          value={kpis ? fmtInr(kpis.ytd_avg) : '—'}
          sub="avg ticket size"
          variant="amber"
          loading={kpiLoading}
        />
        {/* MTD */}
        <KpiCard
          label="MTD Count"
          value={kpis ? fmtNum(kpis.mtd_count) : '—'}
          sub={pmtdCountSub}
          variant="green"
          loading={kpiLoading}
        />
        <KpiCard
          label="MTD Amount"
          value={kpis ? fmtInr(kpis.mtd_amount) : '—'}
          sub={pmtdAmountSub}
          variant="green"
          loading={kpiLoading}
        />
        <KpiCard
          label="Avg MTD"
          value={kpis ? fmtInr(kpis.mtd_avg) : '—'}
          sub={pmtdAvgSub}
          variant="amber"
          loading={kpiLoading}
        />
      </Box>

      {/* ── Table — T-1 + MTD side by side ── */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          px: 2.5, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF',
        }}>
          <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>{tableTitle}</Box>
          <Box sx={{ fontSize: '0.7rem', color: '#94A3B8' }}>T-1 = Yesterday &nbsp;|&nbsp; MTD = Current Month</Box>
        </Box>

        {tableLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={36} />)}
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: hasAp2 ? 900 : 780 }}>
              <TableHead>
                {/* Column group labels */}
                <TableRow sx={{ '& th': { background: '#F8FAFF', py: 0.5 } }}>
                  <TableCell />
                  {hasAp2 && <TableCell />}
                  <TableCell align="center" colSpan={3}
                    sx={{ color: '#1E40AF', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em', borderLeft: '2px solid #BFDBFE' }}>
                    T-1 (Yesterday)
                  </TableCell>
                  <TableCell align="center" colSpan={3}
                    sx={{ color: '#15803D', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em', borderLeft: '2px solid #BBF7D0' }}>
                    MTD (Current Month)
                  </TableCell>
                </TableRow>
                {/* Sortable column headers */}
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)' } }}>
                  <SortCell label={ap1Label}   field="name"       active={sortField === 'name'}       dir={sortDir} onSort={handleSort} />
                  {hasAp2 && <SortCell label={ap2Label} field="name" active={false} dir={sortDir} onSort={handleSort} />}
                  <SortCell label="# Loans"  field="t1_count"   active={sortField === 't1_count'}   dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label={`Amount (${amtUnit.label})`}   field="t1_amount"  active={sortField === 't1_amount'}  dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label={`Avg (${avgUnit.label})`} field="t1_avg"     active={sortField === 't1_avg'}     dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="# Loans"  field="mtd_count"  active={sortField === 'mtd_count'}  dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label={`Amount (${amtUnit.label})`}   field="mtd_amount" active={sortField === 'mtd_amount'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label={`Avg (${avgUnit.label})`} field="mtd_avg"    active={sortField === 'mtd_avg'}    dir={sortDir} onSort={handleSort} align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedRows.map((row, idx) => {
                  const isGrand = row.name === 'Grand Total'
                  return (
                    <TableRow key={idx} sx={isGrand ? {
                      borderTop: '2px solid #BFDBFE', background: '#EFF6FF',
                      '& td': { fontWeight: 700, color: '#1E40AF' },
                    } : { '&:hover': { background: '#F8FAFF' } }}>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          {ap1 === 'business_segment' && !isGrand && (
                            <Box sx={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: SEGMENT_COLORS[row.name] ?? '#D97706' }} />
                          )}
                          <span>{row.name}</span>
                        </Box>
                      </TableCell>
                      {hasAp2 && <TableCell sx={{ color: '#475569' }}>{row.name2 ?? '—'}</TableCell>}

                      {/* T-1 */}
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', borderLeft: '2px solid #DBEAFE' }}>
                        {fmtNum(row.t1_count)}
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                        {fmtUnit(row.t1_amount, amtUnit.div)}
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap', color: '#64748B' }}>
                        {fmtUnit(row.t1_avg, avgUnit.div)}
                      </TableCell>

                      {/* MTD */}
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', borderLeft: '2px solid #BBF7D0' }}>
                        {fmtNum(row.mtd_count)}
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                        {fmtUnit(row.mtd_amount, amtUnit.div)}
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap', color: '#64748B' }}>
                        {fmtUnit(row.mtd_avg, avgUnit.div)}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {sortedRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={hasAp2 ? 9 : 8} align="center"
                      sx={{ py: 6, color: '#94A3B8', fontSize: '0.85rem' }}>
                      No data — run the pipeline to populate this report.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>

      {/* Disbursement is a point-in-time event, unaffected by write-off status,
          so the trend is fixed to one view (no W/O toggle); AP#1/AP#2 drive it. */}
      <TrendSection title="Trend — Disbursement" portfolio="with" ap1={ap1} ap2={ap2}
        measures={[{ key: 'disb_amount', label: '₹ Disbursement', format: 'inr' }, { key: 'disb_count', label: '# Disbursement', format: 'num' }]} />
    </Box>
  )
}
