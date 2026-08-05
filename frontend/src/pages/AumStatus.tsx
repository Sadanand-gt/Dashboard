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
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import Divider from '@mui/material/Divider'
import Tooltip from '@mui/material/Tooltip'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, Legend,
  ResponsiveContainer, Cell, CartesianGrid, LineChart, Line, LabelList,
} from 'recharts'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { SingleLineBarLabel } from '../components/SingleLineBarLabel'
import { useSlicerParams } from '../store/filterStore'
import type { AumKpis } from '../api/types'
import { TrendSection } from '../components/TrendSection'

const SEGMENT_COLORS: Record<string, string> = {
  IEL: '#1565C0', JLG: '#16A34A', LAP: '#7C3AED',
}
const PRODUCT_PALETTE = ['#1565C0', '#16A34A', '#7C3AED', '#D97706', '#DC2626', '#0891B2', '#DB2777']

// ── 23 analysis parameters (AP#1 + AP#2 — mirrors Excel "Analysis Parameters") ──
const DIM_OPTIONS = [
  { value: 'business_segment',    label: 'Business Segment'       },
  // Hierarchy dims use the "<id> - <NAME>" label columns, matching the reference
  // workbook (its slicer is "BRANCH ID & NAME"). They fall back to the plain
  // name server-side until dba_add_aum_labels.sql has been applied.
  { value: 'zone_label',          label: 'Zone ID & Name'         },
  { value: 'cluster_label',       label: 'Cluster ID & Name'      },
  { value: 'region_label',        label: 'Region ID & Name'       },
  { value: 'area_label',          label: 'Unit ID & Name'         },
  { value: 'branch_label',        label: 'Branch ID & Name'       },
  { value: 'lo_name',             label: 'LO Name (with ID)'      },
  { value: 'state_id',            label: 'Branch State'           },
  { value: 'district_id',         label: 'District'               },
  { value: 'prod_classification', label: 'Prod. Classification'   },
  // OD Status (Regular/Overdue/NPA/Write-off) deactivated — use OD Movement instead.
  // { value: 'curr_od_status',      label: 'Curr OD Status'         },
  { value: 'dpd_bucket',          label: 'OD Bucket'              },
  { value: 'bucket_movement',     label: 'Curr Bucket Movement'   },
  { value: 'loan_status',         label: 'Loan Status'            },
  { value: 'disb_year',           label: 'Disbursement Year'      },
  { value: 'cycle_no',            label: 'Cycle'                  },
  { value: 'caste',               label: 'Caste'                  },
  { value: 'religion',            label: 'Religion'               },
  { value: 'purpose_id',          label: 'Purpose ID'             },
  { value: 'facility_id',         label: 'Facility ID'            },
  { value: 'lender_id',           label: 'Lender ID'              },
]
const AP2_OPTIONS = [{ value: 'none', label: '— None —' }, ...DIM_OPTIONS]

// Chart dimension choices — only parameters that make sense as chart axes
const CHART_DIM_OPTIONS = [
  { value: 'business_segment',    label: 'Business Segment' },
  { value: 'zone_label',          label: 'Zone'             },
  { value: 'cluster_label',       label: 'Cluster'          },
  { value: 'region_label',        label: 'Region'           },
  { value: 'area_label',          label: 'Unit'             },
  { value: 'branch_label',        label: 'Branch'           },
  { value: 'lo_name',             label: 'Loan Officer'     },
  { value: 'state_id',            label: 'Branch State'     },
  { value: 'prod_classification', label: 'Prod. Class'      },
  { value: 'dpd_bucket',          label: 'OD Bucket'        },
]

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtInr(v: number): string {
  if (!v && v !== 0) return '—'
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
function fmtPct(v: number): string { return `${(v ?? 0).toFixed(2)}%` }
function fmtNum(v: number): string { return (v ?? 0).toLocaleString('en-IN') }

function parColor(pct: number): string {
  if (pct === 0)  return '#16A34A'
  if (pct < 2)    return '#65A30D'
  if (pct < 5)    return '#D97706'
  if (pct < 10)   return '#DC2626'
  return '#7F1D1D'
}

interface GroupRow {
  name: string; name2?: string
  pos: number; loans: number
  par0_pct: number; par30_pct: number; par60_pct: number; par90_pct: number
}
interface TrendPoint {
  period: string
  pos?: number; loans?: number; growth?: number          // normal series
  cur?: number | null; prev?: number | null; yoy_pct?: number | null  // YoY series
}
interface TrendResp {
  fys: string[]
  points: TrendPoint[]
  cur_fy?: string
  prev_fy?: string
}

// ── Compact inline select ─────────────────────────────────────────────────────
function DimSelect({ label, value, options, onChange, minWidth = 148 }: {
  label: string; value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void; minWidth?: number
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
      <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{label}</Box>
      <FormControl size="small" sx={{ minWidth }}>
        <Select value={value} onChange={(e) => onChange(e.target.value)} displayEmpty
          sx={{ fontSize: '0.74rem', height: 26, '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(0,0,0,0.15)' } }}>
          {options.map((o) => <MenuItem key={o.value} value={o.value} sx={{ fontSize: '0.74rem' }}>{o.label}</MenuItem>)}
        </Select>
      </FormControl>
    </Box>
  )
}

export function AumStatus() {
  const [sortField, setSortField] = useState<keyof GroupRow>('pos')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [ap1, setAp1] = useState('business_segment')
  const [ap2, setAp2] = useState('none')
  const [includeWO, setIncludeWO] = useState(true)
  const [chartDim, setChartDim] = useState('business_segment')

  const slicerParams = useSlicerParams()

  const params = useMemo(() => {
    if (includeWO) return slicerParams
    const base = slicerParams.loan_status
      ? slicerParams.loan_status.split(',').filter((s) => s !== 'Write-off')
      : ['Active', 'Death']
    return { ...slicerParams, loan_status: base.join(',') || 'Active,Death' }
  }, [slicerParams, includeWO])

  const tableQueryParams = useMemo(() => ({
    ...params, group_by: ap1, ...(ap2 !== 'none' ? { group_by_2: ap2 } : {}),
  }), [params, ap1, ap2])

  const { data: kpis, isLoading: kpiLoading } = useQuery<AumKpis>({
    queryKey: ['aum-kpis', params],
    queryFn: () => api.get('/api/aum/kpis', { params }).then((r) => r.data),
  })
  const { data: tableRows = [], isLoading: tableLoading } = useQuery<GroupRow[]>({
    queryKey: ['aum-group', tableQueryParams],
    queryFn: () => api.get('/api/aum/group-summary', { params: tableQueryParams }).then((r) => r.data),
  })
  // Chart 1 data — AUM by <chartDim> (slicer-filtered, own dimension toggle)
  const { data: productRows = [] } = useQuery<GroupRow[]>({
    queryKey: ['aum-by-dim', chartDim, params],
    queryFn: () => api.get('/api/aum/group-summary', { params: { ...params, group_by: chartDim } }).then((r) => r.data),
  })
  const { data: refreshData } = useQuery<{ refresh: string }>({
    queryKey: ['aum-refresh'],
    queryFn: () => api.get('/api/aum/refresh').then((r) => r.data),
  })

  const sortedRows = useMemo(() => {
    const body = tableRows.filter((r) => r.name !== 'Grand Total')
    const grand = tableRows.find((r) => r.name === 'Grand Total')
    body.sort((a, b) => {
      const av = a[sortField], bv = b[sortField]
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
    return grand ? [...body, grand] : body
  }, [tableRows, sortField, sortDir])

  const handleSort = (field: keyof GroupRow) => {
    if (field === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortField(field); setSortDir('desc') }
  }

  const productData = useMemo(() =>
    productRows.filter((r) => r.name !== 'Grand Total')
      .map((r) => ({
        name: r.name.length > 18 ? r.name.slice(0, 16) + '…' : r.name,
        pos: +(r.pos / 1e7).toFixed(2),
        loans: r.loans,
      }))
      .sort((a, b) => b.pos - a.pos)
      .slice(0, 15),
  [productRows])

  const ap1Label = DIM_OPTIONS.find((o) => o.value === ap1)?.label ?? 'Segment'
  const ap2Label = DIM_OPTIONS.find((o) => o.value === ap2)?.label ?? ''
  const hasAp2 = ap2 !== 'none'
  const tableTitle = hasAp2 ? `Current Outstanding — ${ap1Label} × ${ap2Label}` : `Current Outstanding — ${ap1Label}`

  return (
    <Box className="space-y-3">
      {/* Top bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: '#0F172A', flexShrink: 0 }}>Current Outstanding</Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="AP #1" value={ap1} options={DIM_OPTIONS} onChange={setAp1} />
        <DimSelect label="AP #2" value={ap2} options={AP2_OPTIONS} onChange={setAp2} />
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
        <Tooltip title="Last pipeline run" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>As of</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' }}>{refreshData?.refresh ?? '—'}</Box>
          </Box>
        </Tooltip>
      </Box>

      {/* KPI Cards — responsive grid */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        <KpiCard label="Total AUM" value={kpis ? fmtInr(kpis.total_pos) : '—'} sub={kpis ? `${fmtNum(kpis.total_loans)} loans` : ''} variant="default" loading={kpiLoading} />
        <KpiCard label="PAR 0+" value={kpis ? fmtPct(kpis.par0_pct) : '—'} sub={kpis ? fmtInr(kpis.par0_pos) : ''} variant="amber" loading={kpiLoading} />
        <KpiCard label="PAR 30+" value={kpis ? fmtPct(kpis.par30_pct) : '—'} sub={kpis ? fmtInr(kpis.par30_pos) : ''} variant="red" loading={kpiLoading} />
        <KpiCard label="PAR 60+" value={kpis ? fmtPct(kpis.par60_pct) : '—'} sub={kpis ? fmtInr(kpis.par60_pos) : ''} variant="red" loading={kpiLoading} />
        <KpiCard label="PAR 90+" value={kpis ? fmtPct(kpis.par90_pct) : '—'} sub={kpis ? fmtInr(kpis.par90_pos) : ''} variant="red" loading={kpiLoading} />
      </Box>

      {/* Table */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF' }}>
          <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>{tableTitle}</Box>
          <Box sx={{ fontSize: '0.7rem', color: '#94A3B8' }}>{includeWO ? 'Active + Death + Write-off' : 'Active + Death (excl. Write-off)'}</Box>
        </Box>
        {tableLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={36} />)}</Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: hasAp2 ? 820 : 720 }}>
              <TableHead>
                <TableRow>
                  <SortCell label={ap1Label} field="name" active={sortField === 'name'} dir={sortDir} onSort={handleSort} />
                  {hasAp2 && <SortCell label={ap2Label} field="name2" active={sortField === 'name2'} dir={sortDir} onSort={handleSort} />}
                  <SortCell label="POS" field="pos" active={sortField === 'pos'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="# Loans" field="loans" active={sortField === 'loans'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="PAR 0+" field="par0_pct" active={sortField === 'par0_pct'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="PAR 30+" field="par30_pct" active={sortField === 'par30_pct'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="PAR 60+" field="par60_pct" active={sortField === 'par60_pct'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="PAR 90+" field="par90_pct" active={sortField === 'par90_pct'} dir={sortDir} onSort={handleSort} align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedRows.map((row, idx) => {
                  const isGrand = row.name === 'Grand Total'
                  return (
                    <TableRow key={idx} sx={isGrand ? { borderTop: '2px solid #BFDBFE', background: '#EFF6FF', '& td': { fontWeight: 700, color: '#1E40AF' } } : { '&:hover': { background: '#F8FAFF' } }}>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          {ap1 === 'business_segment' && !isGrand && (
                            <Box sx={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: SEGMENT_COLORS[row.name] ?? '#D97706' }} />
                          )}
                          <span>{row.name}</span>
                        </Box>
                      </TableCell>
                      {hasAp2 && <TableCell sx={{ color: '#475569' }}>{row.name2 ?? '—'}</TableCell>}
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtInr(row.pos)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem' }}>{fmtNum(row.loans)}</TableCell>
                      <PctCell value={row.par0_pct} />
                      <PctCell value={row.par30_pct} />
                      <PctCell value={row.par60_pct} />
                      <PctCell value={row.par90_pct} />
                    </TableRow>
                  )
                })}
                {sortedRows.length === 0 && (
                  <TableRow><TableCell colSpan={hasAp2 ? 9 : 8} align="center" sx={{ py: 6, color: '#94A3B8', fontSize: '0.85rem' }}>No data — run the pipeline to populate this report.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>

      {/* Charts — exactly two: AUM by <dim> (bar) + AUM Trend (line) */}
      <Box className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Paper sx={{ overflow: 'hidden' }}>
          <Box sx={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1,
            px: 2.5, py: 1, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF',
          }}>
            <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>
              AUM by {CHART_DIM_OPTIONS.find((o) => o.value === chartDim)?.label} (₹ Cr)
            </Box>
            <DimSelect label="By" value={chartDim} options={CHART_DIM_OPTIONS} onChange={setChartDim} minWidth={130} />
          </Box>
          <Box sx={{ p: 2, height: Math.max(260, productData.length * 44) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={productData} layout="vertical" margin={{ top: 4, right: 64, left: chartDim === 'business_segment' ? 30 : 76, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#64748B', fontSize: 10 }} axisLine={{ stroke: 'rgba(0,0,0,0.1)' }} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: '#475569', fontSize: 11 }} axisLine={false} tickLine={false} width={chartDim === 'business_segment' ? 44 : 110} />
                <RTooltip
                  contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }}
                  formatter={(v: number) => [`₹${v.toFixed(2)} Cr`, 'AUM']}
                />
                <Bar dataKey="pos" name="AUM (₹ Cr)" radius={[0, 4, 4, 0]} barSize={22} isAnimationActive={false}>
                  {productData.map((d, i) => <Cell key={i} fill={SEGMENT_COLORS[d.name] ?? PRODUCT_PALETTE[i % PRODUCT_PALETTE.length]} />)}
                  <LabelList dataKey="pos" content={<SingleLineBarLabel fill="#334155" formatter={(v: number) => `₹${v.toFixed(1)} Cr`} />} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Box>
        </Paper>

      </Box>

      {/* One portfolio control for the whole page: the KPI cards, the Analysis
          Parameter table and the trend all follow `includeWO`. AP#1/AP#2 drive
          the trend's grouping too, so the trend mirrors the table above it. */}
      <TrendSection
        title="Trend — Portfolio (POS / Loans / PAR %)"
        portfolio={includeWO ? 'with' : 'excl'}
        ap1={ap1}
        ap2={ap2}
        measures={[{ key: 'pos', label: 'POS', format: 'inr' }, { key: 'loans', label: '# Loans', format: 'num' }, { key: 'par0_pct', label: 'PAR>0 %', format: 'pct' }, { key: 'par30_pct', label: 'PAR>30 %', format: 'pct' }, { key: 'par90_pct', label: 'PAR>90 %', format: 'pct' }]} />
    </Box>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────
// Conditional formatting: green (healthy) → amber (watch) → red (risk).
// Cell background intensity follows the PAR level; highest levels darkest red.
function PctCell({ value }: { value: number }) {
  const c = parColor(value)
  return (
    <TableCell align="right" sx={{ background: `${c}14`, borderLeft: '1px solid rgba(0,0,0,0.03)' }}>
      <Box component="span" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.74rem', fontWeight: 700, color: c }}>
        {fmtPct(value)}
      </Box>
    </TableCell>
  )
}

function SortCell<T extends string>({ label, field, active, dir, onSort, align = 'left' }: {
  label: string; field: T; active: boolean; dir: 'asc' | 'desc'; onSort: (f: T) => void; align?: 'left' | 'right'
}) {
  return (
    <TableCell align={align} sx={{ whiteSpace: 'nowrap' }}>
      <TableSortLabel active={active} direction={active ? dir : 'desc'} onClick={() => onSort(field)}
        sx={{ color: '#1E40AF !important', '& .MuiTableSortLabel-icon': { color: '#1565C0 !important' } }}>
        {label}
      </TableSortLabel>
    </TableCell>
  )
}
