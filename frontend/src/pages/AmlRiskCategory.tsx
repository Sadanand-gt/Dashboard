import { useState, useMemo } from 'react'
import Button from '@mui/material/Button'
import { ExportCsvButton } from '../components/ExportCsvButton'
import { RiskQuestions, type Question, type Unassessed } from '../components/RiskQuestions'
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
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, Cell,
  CartesianGrid, LabelList, PieChart, Pie,
} from 'recharts'
import { api } from '../api/client'
import { heatBand, heatStyle, spineColor, makeBenchFor } from '../components/heat'
import { useSlicerParams } from '../store/filterStore'

// ── Analysis-parameter dimensions (AP#1 / AP#2) ────────────────────────────────
const DIM_OPTIONS = [
  { value: 'risk_category',       label: 'Risk Category'    },
  { value: 'pep_flag',            label: 'PEP Status'       },
  { value: 'work_abroad_flag',    label: 'Work Abroad'      },
  { value: 'luc_flag',            label: 'LUC Status'       },
  { value: 'business_segment',    label: 'Business Segment' },
  { value: 'zone_label',          label: 'Zone ID & Name'   },
  { value: 'cluster_label',       label: 'Cluster ID & Name'},
  { value: 'region_label',        label: 'Region ID & Name' },
  { value: 'area_label',          label: 'Unit ID & Name'   },
  { value: 'branch_label',        label: 'Branch ID & Name' },
  { value: 'lo_name',             label: 'LO Name (with ID)'},
  { value: 'state_id',            label: 'Branch State'     },
  { value: 'district_id',         label: 'District'         },
  { value: 'prod_classification', label: 'Prod. Classification' },
]
const AP2_OPTIONS = [{ value: 'none', label: '— None —' }, ...DIM_OPTIONS]

const RISK_COLORS: Record<string, string> = {
  High: '#DC2626', Low: '#16A34A', Unclassified: '#94A3B8',
}

// ── Formatters ─────────────────────────────────────────────────────────────────
function fmtInr(v: number): string {
  if (!v && v !== 0) return '—'
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
function fmtPct(v: number): string { return `${(v ?? 0).toFixed(2)}%` }
function fmtNum(v: number): string { return (v ?? 0).toLocaleString('en-IN') }

// High-risk concentration colour ramp (green → red as % rises)
// riskColor() used to apply fixed cutoffs (0 / <3 / <10 / <30) to the
// high-risk share. Kept ONLY for the concentration chart, whose bars need a
// standalone colour with no table benchmark to lean on; the TABLE now shades
// against the report's own benchmark via components/heat.ts.
function riskColor(pct: number): string {
  if (pct <= 0)   return '#16A34A'
  if (pct < 3)    return '#65A30D'
  if (pct < 10)   return '#D97706'
  if (pct < 30)   return '#DC2626'
  return '#7F1D1D'
}

function DimSelect({ label, value, options, onChange, minWidth = 150 }: {
  label: string; value: string; options: { value: string; label: string }[]
  onChange: (v: string) => void; minWidth?: number
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
      <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>{label}</Box>
      <FormControl size="small" sx={{ minWidth }}>
        <Select value={value} onChange={(e) => onChange(e.target.value)} displayEmpty
          sx={{ fontSize: '0.74rem', height: 26 }}>
          {options.map((o) => <MenuItem key={o.value} value={o.value} sx={{ fontSize: '0.74rem' }}>{o.label}</MenuItem>)}
        </Select>
      </FormControl>
    </Box>
  )
}

function QuickFilter({ label, value, options, onChange }: {
  label: string; value: string; options: { v: string; l: string }[]; onChange: (v: string) => void
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}>
      <Box sx={{ fontSize: '0.6rem', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</Box>
      <ToggleButtonGroup value={value} exclusive size="small"
        onChange={(_, v) => { if (v !== null) onChange(v) }} sx={{ height: 26 }}>
        {options.map((o) => (
          <ToggleButton key={o.v} value={o.v} sx={{ px: 1.1, fontSize: '0.66rem', height: 26, textTransform: 'none' }}>{o.l}</ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  )
}

interface AmlRow {
  name: string; name2?: string
  loans: number; pos: number
  high: number; high_pct: number; high_pos: number
  pep: number; pep_pct: number; abroad: number; luc_pending: number
}

interface NewCases {
  prior_day: string | null
  counts: { high_risk: number; pep: number; works_abroad: number
            luc_pending: number; unclassified: number }
}

const NEW_CARDS: [keyof NewCases['counts'], string][] = [
  ['high_risk', 'High Risk'], ['pep', 'PEP'], ['works_abroad', 'Works Abroad'],
  ['luc_pending', 'LUC Pending'], ['unclassified', 'Unclassified'],
]

const AML_EXPORT_COLS: [string, string][] = [
  ['loan_id', 'Loan ID'], ['loan_source', 'Loan Source'],
  ['business_segment', 'Business Segment'], ['loan_status', 'Loan Status'],
  ['risk_category', 'AML Risk'], ['pep_flag', 'PEP'],
  ['work_abroad_flag', 'Works Abroad'], ['luc_flag', 'LUC'],
  ['nationality', 'Nationality'],
  ['zone_name', 'Zone'], ['cluster_name', 'Cluster'], ['region_name', 'Region'],
  ['area_name', 'Unit'], ['branch_name', 'Branch'], ['branch_id', 'Branch ID'],
  ['lo_id', 'Loan Officer ID'], ['prod_classification', 'Prod. Classification'],
  ['state_id', 'State'], ['district_id', 'District'], ['pos', 'POS'],
]


export function AmlRiskCategory() {
  // NOT 'risk_category'. Grouped by risk the table restates the cards above it
  // row for row — 1,594 / 86,849 / 4,909 — and HIGH % reads 100 / 0 / 0, which is
  // true by construction and says nothing. Region is the first cut that tells
  // you something the strip cannot: WHERE the risk sits.
  const [ap1, setAp1] = useState('region_label')
  const [ap2, setAp2] = useState('none')
  const [risk, setRisk] = useState('ALL')
  const [pep, setPep] = useState('ALL')
  const [abroad, setAbroad] = useState('ALL')
  // Excl W/O is the ACTIVE PORTFOLIO and reconciles to Current Outstanding
  // Excl-W/O, so it is the default here as everywhere else.
  const [portfolio, setPortfolio] = useState<'without' | 'with'>('without')
  // Charts start hidden — the matrix below carries the same figures exactly.
  const [showCharts, setShowCharts] = useState(false)
  const [sortField, setSortField] = useState<keyof AmlRow>('high')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const slicerParams = useSlicerParams()
  const params = useMemo(() => ({
    ...slicerParams,
    ...(risk !== 'ALL' ? { risk_category: risk } : {}),
    ...(pep !== 'ALL' ? { pep } : {}),
    ...(abroad !== 'ALL' ? { work_abroad: abroad } : {}),
    portfolio,
  }), [slicerParams, risk, pep, abroad, portfolio])

  const tableParams = useMemo(() => ({
    ...params, group_by: ap1, ...(ap2 !== 'none' ? { group_by_2: ap2 } : {}),
  }), [params, ap1, ap2])

  // The four questions the origination form actually asks. Answered off one
  // pass so the section below can put them side by side, PENDING INCLUDED —
  // a borrower with no answer recorded is unassessed, not low risk.
  const { data: rq, isLoading: rqLoading } = useQuery<{
    questions: Question[]; unassessed: Unassessed
    total_loans: number; total_pos: number
  }>({
    queryKey: ['aml-questions', params],
    queryFn: () => api.get('/api/aml/questions', { params }).then((r) => r.data),
  })

  // Newly-flagged loans: ids present today, absent on the previous report_day.
  // Gross, not net — ten arrivals against ten departures must not read as zero.
  const { data: newCases } = useQuery<NewCases>({
    queryKey: ['aml-new-cases', params],
    queryFn: () => api.get('/api/aml/new-cases', { params }).then((r) => r.data),
  })

  const fetchAmlLoans = async () =>
    (await api.get('/api/aml/loans', { params })).data.rows as Record<string, any>[]
  const { data: tableRows = [], isLoading: tableLoading } = useQuery<AmlRow[]>({
    queryKey: ['aml-group', tableParams],
    queryFn: () => api.get('/api/aml/group-summary', { params: tableParams }).then((r) => r.data),
  })
  // Concentration: top branches by High-risk count (own grouping, slicer-filtered)
  const { data: branchRows = [] } = useQuery<AmlRow[]>({
    queryKey: ['aml-branch', params],
    queryFn: () => api.get('/api/aml/group-summary', { params: { ...params, group_by: 'branch_label' } }).then((r) => r.data),
  })
  // Risk composition (High / Low / Unclassified)
  const { data: riskRows = [] } = useQuery<AmlRow[]>({
    queryKey: ['aml-risk-split', params],
    queryFn: () => api.get('/api/aml/group-summary', { params: { ...params, group_by: 'risk_category' } }).then((r) => r.data),
  })
  const { data: refreshData } = useQuery<{ refresh: string }>({
    queryKey: ['aml-refresh'],
    queryFn: () => api.get('/api/aml/refresh').then((r) => r.data),
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

  const handleSort = (f: keyof AmlRow) => {
    if (f === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortField(f); setSortDir('desc') }
  }

  const concData = useMemo(() =>
    branchRows.filter((r) => r.name !== 'Grand Total' && r.high > 0)
      .map((r) => ({
        name: r.name.length > 22 ? r.name.slice(0, 20) + '…' : r.name,
        high: r.high, high_pct: r.high_pct, loans: r.loans,
      }))
      .sort((a, b) => b.high - a.high).slice(0, 12),
  [branchRows])

  const riskPie = useMemo(() =>
    riskRows.filter((r) => r.name !== 'Grand Total')
      .map((r) => ({ name: r.name, value: r.loans }))
      .sort((a, b) => (RISK_COLORS[a.name] === '#16A34A' ? 1 : -1)),
  [riskRows])

  const hasAp2 = ap2 !== 'none'
  // High-risk share shaded against the Grand Total, or the AP#2 median when
  // grouped two deep. `loans` is the denominator: a group with no customers
  // has no high-risk rate and must not shade as the worst on the page.
  const benchFor = useMemo(
    () => makeBenchFor(sortedRows.filter((r) => r.name !== 'Grand Total'),
                       sortedRows.find((r) => r.name === 'Grand Total'),
                       ['high_pct'], hasAp2),
    [sortedRows, hasAp2])
  const ap1Label = DIM_OPTIONS.find((o) => o.value === ap1)?.label ?? 'Region ID & Name'
  const ap2Label = DIM_OPTIONS.find((o) => o.value === ap2)?.label ?? ''

  return (
    <Box className="space-y-3">
      {/* Top bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: '#0F172A', flexShrink: 0 }}>AML Risk Category</Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="AP #1" value={ap1} options={DIM_OPTIONS} onChange={setAp1} />
        <DimSelect label="AP #2" value={ap2} options={AP2_OPTIONS} onChange={setAp2} />
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <QuickFilter label="Risk" value={risk} onChange={setRisk} options={[{ v: 'ALL', l: 'All' }, { v: 'High', l: 'High' }, { v: 'Low', l: 'Low' }]} />
        <QuickFilter label="PEP" value={pep} onChange={setPep} options={[{ v: 'ALL', l: 'All' }, { v: 'PEP', l: 'PEP only' }]} />
        <QuickFilter label="Abroad" value={abroad} onChange={setAbroad} options={[{ v: 'ALL', l: 'All' }, { v: 'Works Abroad', l: 'Abroad only' }]} />
        <Box sx={{ flex: 1, minWidth: 8 }} />
        {/* Was a second toolbar row of its own. One control strip, not two —
            the row it lived on carried three controls and a lot of white. */}
        <ToggleButtonGroup size="small" exclusive value={portfolio} sx={{ flexShrink: 0, height: 26 }}
          onChange={(_, v) => v && setPortfolio(v)}>
          <ToggleButton value="without" sx={{ fontSize: '0.65rem', px: 1, textTransform: 'none' }}>Excl. W/O</ToggleButton>
          <ToggleButton value="with" sx={{ fontSize: '0.65rem', px: 1, textTransform: 'none' }}>With W/O</ToggleButton>
        </ToggleButtonGroup>
        <Button size="small" variant="text" onClick={() => setShowCharts((v) => !v)}
          sx={{ fontSize: '0.66rem', textTransform: 'none', py: 0.2, px: 1,
                minWidth: 0, flexShrink: 0, whiteSpace: 'nowrap', color: '#64748B' }}>
          {showCharts ? 'Hide charts' : 'Show charts'}
        </Button>
        <ExportCsvButton rows={[]} columns={AML_EXPORT_COLS} fetchRows={fetchAmlLoans}
          filename="aml_risk_loans" />
        <Tooltip title="Data as-of (T-1)" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>As of</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#64748B', fontWeight: 600, whiteSpace: 'nowrap' }}>{refreshData?.refresh ?? '—'}</Box>
          </Box>
        </Tooltip>
      </Box>

      {/* ── Client Risk Categorization ─────────────────────────────────────
          THE page. Five cards: the AML risk grade plus the four questions the
          origination form asks, each with its own pending count.

          A separate KPI row used to sit underneath this and repeated PEP, Works
          Abroad and LUC Pending — the same three numbers twice on one screen,
          plus Loans / POS which now live in the banner and Unclassified which is
          the risk card's own pending. Removed 2026-08-26: the duplicate row was
          most of the page's height and none of its information. */}
      <RiskQuestions questions={rq?.questions ?? []} unassessed={rq?.unassessed}
        loading={rqLoading} priorDay={newCases?.prior_day}
        newBy={{
          risk: newCases?.counts?.high_risk,
          pep: newCases?.counts?.pep,
          abroad: newCases?.counts?.works_abroad,
          luc: newCases?.counts?.luc_pending,
        }} />

      {/* Concentration + risk composition — side by side */}
      {showCharts && (
      <Box className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Paper sx={{ overflow: 'hidden' }}>
          <Box sx={{ px: 2.5, py: 1.25, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FEF2F2' }}>
            <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#991B1B' }}>High-Risk Concentration — Top Branches</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#B91C1C', mt: 0.2 }}># High-risk borrowers per branch</Box>
          </Box>
          <Box sx={{ p: 2, height: Math.max(240, concData.length * 30) }}>
            {concData.length === 0 ? (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94A3B8', fontSize: '0.85rem' }}>No high-risk borrowers in the current selection.</Box>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={concData} layout="vertical" margin={{ top: 4, right: 70, left: 96, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#64748B', fontSize: 10 }} axisLine={{ stroke: 'rgba(0,0,0,0.1)' }} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#475569', fontSize: 10.5 }} axisLine={false} tickLine={false} width={130} />
                  <RTooltip
                    contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number, _n, p: { payload?: { high_pct?: number; loans?: number } }) =>
                      [`${v} high · ${(p.payload?.high_pct ?? 0).toFixed(1)}% of ${p.payload?.loans ?? 0}`, 'High-risk']}
                  />
                  <Bar dataKey="high" radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false}>
                    {concData.map((d, i) => <Cell key={i} fill={riskColor(d.high_pct)} />)}
                    <LabelList dataKey="high" position="right" formatter={(v: number) => v.toLocaleString('en-IN')}
                      style={{ fill: '#334155', fontSize: 10, fontWeight: 700 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Paper>

        <Paper sx={{ overflow: 'hidden' }}>
          <Box sx={{ px: 2.5, py: 1.25, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF' }}>
            <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>Risk Composition</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#94A3B8', mt: 0.2 }}>Borrowers by AML risk grade</Box>
          </Box>
          <Box sx={{ p: 2, height: 240, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <ResponsiveContainer width="100%" height="80%">
              <PieChart>
                <Pie data={riskPie} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={78} paddingAngle={2} isAnimationActive={false}>
                  {riskPie.map((d, i) => <Cell key={i} fill={RISK_COLORS[d.name] ?? '#94A3B8'} />)}
                </Pie>
                <RTooltip formatter={(v: number, n: string) => [`${fmtNum(v)} borrowers`, n]}
                  contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
            <Box sx={{ display: 'flex', gap: 2, mt: 1 }}>
              {riskPie.map((d) => (
                <Box key={d.name} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box sx={{ width: 9, height: 9, borderRadius: '50%', background: RISK_COLORS[d.name] ?? '#94A3B8' }} />
                  <Box sx={{ fontSize: '0.7rem', color: '#475569', fontWeight: 600 }}>{d.name} {fmtNum(d.value)}</Box>
                </Box>
              ))}
            </Box>
          </Box>
        </Paper>
      </Box>
      )}

      {/* Matrix table */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid rgba(0,0,0,0.06)', background: '#FAFBFF' }}>
          <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: '#1E293B' }}>
            {hasAp2 ? `AML — ${ap1Label} × ${ap2Label}` : `AML — by ${ap1Label}`}
          </Box>
          <Box sx={{ fontSize: '0.7rem', color: '#94A3B8' }}>Active book · borrower-level AML screening</Box>
        </Box>
        {tableLoading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={34} />)}</Box>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: hasAp2 ? 900 : 800 }}>
              <TableHead>
                <TableRow>
                  <SortCell label={ap1Label} field="name" active={sortField === 'name'} dir={sortDir} onSort={handleSort} />
                  {hasAp2 && <SortCell label={ap2Label} field="name2" active={sortField === 'name2'} dir={sortDir} onSort={handleSort} />}
                  <SortCell label="Borrowers" field="loans" active={sortField === 'loans'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="POS" field="pos" active={sortField === 'pos'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="High #" field="high" active={sortField === 'high'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="High %" field="high_pct" active={sortField === 'high_pct'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="PEP #" field="pep" active={sortField === 'pep'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="Abroad #" field="abroad" active={sortField === 'abroad'} dir={sortDir} onSort={handleSort} align="right" />
                  <SortCell label="LUC Pending" field="luc_pending" active={sortField === 'luc_pending'} dir={sortDir} onSort={handleSort} align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedRows.map((row, idx) => {
                  const isGrand = row.name === 'Grand Total'
                  return (
                    <TableRow key={idx} sx={isGrand ? { borderTop: '2px solid #BFDBFE', background: '#EFF6FF', '& td': { fontWeight: 700, color: '#1E40AF' } } : { '&:hover': { background: '#F8FAFF' } }}>
                      <TableCell sx={{ borderLeft: `4px solid ${isGrand ? 'transparent'
                        : spineColor(heatBand(row.high_pct, benchFor(row, 'high_pct'), 'bad-high', row.loans))}` }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          {ap1 === 'risk_category' && !isGrand && (
                            <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: RISK_COLORS[row.name] ?? '#94A3B8' }} />
                          )}
                          <span>{row.name}</span>
                        </Box>
                      </TableCell>
                      {hasAp2 && <TableCell sx={{ color: '#475569' }}>{row.name2 ?? '—'}</TableCell>}
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem' }}>{fmtNum(row.loans)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{fmtInr(row.pos)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', fontWeight: 700, color: row.high > 0 ? '#B91C1C' : '#94A3B8' }}>{fmtNum(row.high)}</TableCell>
                      <HighPctCell value={row.high_pct}
                        band={isGrand ? null : heatBand(row.high_pct, benchFor(row, 'high_pct'), 'bad-high', row.loans)} />
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', color: row.pep > 0 ? '#6D28D9' : '#94A3B8' }}>{fmtNum(row.pep)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', color: '#475569' }}>{fmtNum(row.abroad)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem', color: row.luc_pending > 0 ? '#B45309' : '#94A3B8' }}>{fmtNum(row.luc_pending)}</TableCell>
                    </TableRow>
                  )
                })}
                {sortedRows.length === 0 && (
                  <TableRow><TableCell colSpan={hasAp2 ? 9 : 8} align="center" sx={{ py: 6, color: '#94A3B8', fontSize: '0.85rem' }}>No data — run the AML pipeline to populate this report.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Box>
  )
}

function HighPctCell({ value, band }: { value: number; band: number | null }) {
  return (
    <TableCell align="right" sx={{ borderLeft: '1px solid rgba(0,0,0,0.03)', ...heatStyle(band, true) }}>
      <Box component="span" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem' }}>
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
