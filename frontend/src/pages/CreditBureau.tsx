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
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, Cell,
  CartesianGrid, LabelList, Legend, ComposedChart, Line, ScatterChart, Scatter, ZAxis,
} from 'recharts'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { useSlicerParams } from '../store/filterStore'

// ── Palette ───────────────────────────────────────────────────────────────────
const APPROVED = '#16A34A'
const REFERRED = '#D97706'
const REJECTED = '#DC2626'
const INK = '#0F172A'
const MUTED = '#64748B'
const DECISION_COLOR: Record<string, string> = {
  Approved: APPROVED, Referred: REFERRED, Rejected: REJECTED, Unknown: '#94A3B8',
}
const DECISION_ORDER = ['Approved', 'Referred', 'Rejected', 'Unknown']

const DIM_OPTIONS = [
  { value: 'decision',         label: 'Decision' },
  { value: 'client_category',  label: 'Client Category' },
  { value: 'branch_name',      label: 'Branch' },
  { value: 'region_name',      label: 'Region' },
  { value: 'cluster_name',     label: 'Cluster' },
  { value: 'area_name',        label: 'Unit' },
  { value: 'pull_month',       label: 'Pull Month' },
  { value: 'pull_year',        label: 'Pull Year' },
  { value: 'cb_branch',        label: 'Bureau Branch' },
]
const AP2_OPTIONS = [{ value: 'none', label: '— None —' }, ...DIM_OPTIONS]

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtInr = (v: number): string => {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
const fmtPct = (v: number) => `${(v ?? 0).toFixed(1)}%`
const fmtNum = (v: number) => (v ?? 0).toLocaleString('en-IN')
const fmtDec = (v: number) => (v ?? 0).toFixed(2)
const cr = (v: number) => (v ?? 0) / 1e7

// Higher approval = greener. Used for branch bars only.
const approvalColor = (p: number) =>
  p >= 80 ? '#16A34A' : p >= 65 ? '#65A30D' : p >= 50 ? '#D97706' : '#DC2626'

interface Row {
  name: string; name2?: string
  pulls: number; approved_pulls: number; rejected_pulls: number; referred_pulls: number
  mfi_outstanding: number; ru_outstanding: number; rs_lts_outstanding: number
  total_outstanding: number; total_overdue: number
  with_overdue_lender: number; emi_other: number; monthly_income: number; max_eligibility: number
  approval_rate: number; rejection_rate: number; overdue_lender_pct: number
  obligation_pct: number; overdue_pct: number
  avg_mfi_lenders: number; avg_other_lenders: number; avg_outstanding: number; avg_emi_other: number
}
interface Resp {
  rows: Row[]; grand: Row; as_of: string | null
  dims: { value: string; label: string }[]
  filter?: { param: string; label: string; options: string[] } | null
}

export function CreditBureau() {
  const [ap1, setAp1] = useState('decision')
  const [ap2, setAp2] = useState('none')
  const [year, setYear] = useState('ALL')
  const [decision, setDecision] = useState('ALL')
  const [sortField, setSortField] = useState<keyof Row>('pulls')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const slicers = useSlicerParams()

  const base = useMemo(() => {
    const p: Record<string, string> = { ...slicers }
    if (year !== 'ALL') p.pick = year
    if (decision !== 'ALL') p.decision = decision
    return p
  }, [slicers, year, decision])

  const q = (key: string, group_by: string, group_by_2?: string) =>
    useQuery<Resp>({
      queryKey: ['cb', key, base, group_by, group_by_2],
      queryFn: () => api.get('/api/credit-bureau/summary', {
        params: { ...base, group_by, ...(group_by_2 ? { group_by_2 } : {}) },
      }).then((r) => r.data),
    })

  const table = q('table', ap1, ap2 !== 'none' ? ap2 : undefined)
  const byDecision = q('decision', 'decision')
  const byMonth = q('month', 'pull_month')
  const byCategory = q('category', 'client_category')
  const byBranch = q('branch', 'branch_name')

  const g = table.data?.grand
  const loading = table.isLoading
  const years = table.data?.filter?.options ?? []

  // ── Decision mix per month
  const monthData = useMemo(() => {
    const rows = (byMonth.data?.rows ?? []).filter((r) => r.name !== 'Grand Total')
    return rows.sort((a, b) => a.name.localeCompare(b.name)).slice(-18).map((r) => ({
      name: r.name,
      Approved: r.approved_pulls, Referred: r.referred_pulls, Rejected: r.rejected_pulls,
      approval_rate: r.approval_rate, pulls: r.pulls,
    }))
  }, [byMonth.data])

  // ── Risk profile per decision — the applicant's standing with OTHER lenders
  const riskData = useMemo(() => {
    const rows = (byDecision.data?.rows ?? []).filter((r) => r.name !== 'Grand Total')
    return rows
      .sort((a, b) => DECISION_ORDER.indexOf(a.name) - DECISION_ORDER.indexOf(b.name))
      .map((r) => ({
        name: r.name,
        lenders: r.avg_mfi_lenders,
        overdue_lender_pct: r.overdue_lender_pct,
        overdue_pct: r.overdue_pct,
        avg_emi: r.avg_emi_other,
        avg_exposure: r.avg_outstanding,
        pulls: r.pulls,
      }))
  }, [byDecision.data])

  // ── Approval by client category
  const catData = useMemo(() => {
    const rows = (byCategory.data?.rows ?? []).filter((r) => r.name !== 'Grand Total')
    return rows.sort((a, b) => b.pulls - a.pulls).map((r) => ({
      name: r.name, approval_rate: r.approval_rate, pulls: r.pulls,
      lenders: r.avg_mfi_lenders,
    }))
  }, [byCategory.data])

  // ── Branch scatter: volume vs approval rate
  const branchData = useMemo(() => {
    const rows = (byBranch.data?.rows ?? []).filter((r) => r.name !== 'Grand Total' && r.pulls > 0)
    return rows.map((r) => ({
      name: r.name, pulls: r.pulls, approval_rate: r.approval_rate,
      overdue_lender_pct: r.overdue_lender_pct,
    }))
  }, [byBranch.data])

  const sortedRows = useMemo(() => {
    const body = [...(table.data?.rows ?? [])].filter((r) => r.name !== 'Grand Total')
    if (ap1 === 'decision' && sortField === 'name') {
      body.sort((a, b) => (DECISION_ORDER.indexOf(a.name) - DECISION_ORDER.indexOf(b.name))
        * (sortDir === 'asc' ? 1 : -1))
      return body
    }
    body.sort((a, b) => {
      const av = a[sortField], bv = b[sortField]
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av
      return sortDir === 'asc'
        ? String(av ?? '').localeCompare(String(bv ?? ''))
        : String(bv ?? '').localeCompare(String(av ?? ''))
    })
    return body
  }, [table.data, sortField, sortDir, ap1])

  const handleSort = (f: keyof Row) => {
    if (f === sortField) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortField(f); setSortDir('desc') }
  }

  const hasAp2 = ap2 !== 'none'
  const ap1Label = DIM_OPTIONS.find((o) => o.value === ap1)?.label ?? 'Group'
  const ap2Label = DIM_OPTIONS.find((o) => o.value === ap2)?.label ?? ''

  const NUM_COLS: { field: keyof Row; label: string; fmt: (v: number) => string; risk?: boolean }[] = [
    { field: 'pulls',               label: 'Pulls',            fmt: fmtNum },
    { field: 'approval_rate',       label: 'Approval %',       fmt: fmtPct },
    { field: 'rejection_rate',      label: 'Rejection %',      fmt: fmtPct, risk: true },
    { field: 'total_outstanding',   label: 'Exposure',         fmt: fmtInr },
    { field: 'mfi_outstanding',     label: 'MFI',              fmt: fmtInr },
    { field: 'ru_outstanding',      label: 'Retail Unsec.',    fmt: fmtInr },
    { field: 'rs_lts_outstanding',  label: 'Retail Sec.',      fmt: fmtInr },
    { field: 'total_overdue',       label: 'Overdue',          fmt: fmtInr },
    { field: 'overdue_pct',         label: 'Overdue %',        fmt: fmtPct, risk: true },
    { field: 'avg_mfi_lenders',     label: 'Avg MFI Lenders',  fmt: fmtDec },
    { field: 'overdue_lender_pct',  label: 'w/ Overdue Lender %', fmt: fmtPct, risk: true },
    { field: 'avg_emi_other',       label: 'Avg EMI Elsewhere', fmt: fmtInr },
    { field: 'obligation_pct',      label: 'EMI ÷ Income',     fmt: fmtPct },
  ]

  const exportCsv = () => {
    const head = [ap1Label, ...(hasAp2 ? [ap2Label] : []), ...NUM_COLS.map((c) => c.label)].join(',')
    const lines = sortedRows.map((r) =>
      [`"${r.name}"`, ...(hasAp2 ? [`"${r.name2 ?? ''}"`] : []),
        ...NUM_COLS.map((c) => r[c.field] ?? 0)].join(','))
    const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `credit_bureau_${ap1}${year !== 'ALL' ? '_' + year : ''}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }

  return (
    <Box className="space-y-3">
      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: INK, flexShrink: 0 }}>Credit Bureau &amp; Sourcing</Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="AP #1" value={ap1} options={DIM_OPTIONS} onChange={setAp1} />
        <DimSelect label="AP #2" value={ap2} options={AP2_OPTIONS} onChange={setAp2} />
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="Pull Year" value={year}
          options={[{ value: 'ALL', label: 'All years' }, ...years.map((y) => ({ value: y, label: y }))]}
          onChange={setYear} />
        <Box sx={{ flexShrink: 0 }}>
          <Box sx={{ fontSize: '0.55rem', color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Decision</Box>
          <ToggleButtonGroup size="small" exclusive value={decision}
            onChange={(_, v) => { if (v) setDecision(v) }} sx={{ height: 24 }}>
            {['ALL', 'Approved', 'Rejected'].map((d) => (
              <ToggleButton key={d} value={d} sx={{ px: 1, fontSize: '0.66rem', textTransform: 'none' }}>
                {d === 'ALL' ? 'All' : d}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
        <Box sx={{ flex: 1, minWidth: 8 }} />
        <Tooltip title="Data as-of" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>As of</Box>
            <Box sx={{ fontSize: '0.68rem', color: MUTED, fontWeight: 600, whiteSpace: 'nowrap' }}>{table.data?.as_of ?? '—'}</Box>
          </Box>
        </Tooltip>
      </Box>

      {/* ── KPI cards ──────────────────────────────────────────────────────── */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        <KpiCard label="Bureau Pulls" value={g ? fmtNum(g.pulls) : '—'}
          sub="applications screened" variant="default" loading={loading} />
        <KpiCard label="Approval Rate" value={g ? fmtPct(g.approval_rate) : '—'}
          sub={g ? `${fmtNum(g.approved_pulls)} approved` : ''} variant="green" loading={loading} />
        <KpiCard label="Rejection Rate" value={g ? fmtPct(g.rejection_rate) : '—'}
          sub={g ? `${fmtNum(g.rejected_pulls)} rejected` : ''} variant="red" loading={loading} />
        <KpiCard label="Exposure Elsewhere" value={g ? fmtInr(g.total_outstanding) : '—'}
          sub={g ? `${fmtInr(g.avg_outstanding)} per applicant` : ''} variant="purple" loading={loading} />
        <KpiCard label="With Overdue Lender" value={g ? fmtNum(g.with_overdue_lender) : '—'}
          sub={g ? `${fmtPct(g.overdue_lender_pct)} of pulls` : ''} variant="red" loading={loading} />
        <KpiCard label="EMI ÷ Income" value={g ? fmtPct(g.obligation_pct) : '—'}
          sub={g ? `${fmtInr(g.avg_emi_other)} avg EMI elsewhere` : ''} variant="amber" loading={loading} />
      </Box>

      {/* ── Row 1: decision mix over time + risk profile ───────────────────── */}
      <Box className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Paper sx={{ overflow: 'hidden', '@media (min-width:1024px)': { gridColumn: 'span 2' } }}>
          <PanelHead title="Decision mix by month" sub="Pulls by outcome, with approval rate on the right axis" />
          <Box sx={{ p: 2, height: 300 }}>
            {byMonth.isLoading ? <Skeleton variant="rectangular" height={260} /> : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={monthData} margin={{ top: 16, right: 8, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: MUTED }} interval="preserveStartEnd" />
                  <YAxis yAxisId="l" tick={{ fontSize: 10, fill: MUTED }} width={48}
                    tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                  <YAxis yAxisId="r" orientation="right" domain={[0, 100]} width={40}
                    tick={{ fontSize: 10, fill: MUTED }} tickFormatter={(v: number) => `${v}%`} />
                  <RTooltip contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number, n: string) => [n === 'Approval %' ? `${v.toFixed(1)}%` : v.toLocaleString('en-IN'), n]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="l" dataKey="Approved" stackId="a" fill={APPROVED} barSize={18} />
                  <Bar yAxisId="l" dataKey="Referred" stackId="a" fill={REFERRED} barSize={18} />
                  <Bar yAxisId="l" dataKey="Rejected" stackId="a" fill={REJECTED} barSize={18} radius={[3, 3, 0, 0]} />
                  <Line yAxisId="r" type="monotone" dataKey="approval_rate" name="Approval %"
                    stroke={INK} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Paper>

        <Paper sx={{ overflow: 'hidden' }}>
          <PanelHead title="Applicant profile by decision" sub="Average lenders and share already carrying an overdue lender" />
          <Box sx={{ p: 2, height: 300 }}>
            {byDecision.isLoading ? <Skeleton variant="rectangular" height={260} /> : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={riskData} margin={{ top: 20, right: 8, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: MUTED }} />
                  <YAxis yAxisId="l" tick={{ fontSize: 10, fill: MUTED }} width={34} />
                  <YAxis yAxisId="r" orientation="right" domain={[0, 40]} width={36}
                    tick={{ fontSize: 10, fill: MUTED }} tickFormatter={(v: number) => `${v}%`} />
                  <RTooltip contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number, n: string) => [n.includes('%') ? `${v.toFixed(1)}%` : v.toFixed(2), n]} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar yAxisId="l" dataKey="lenders" name="Avg MFI lenders" barSize={34} radius={[4, 4, 0, 0]}>
                    {riskData.map((d, i) => <Cell key={i} fill={DECISION_COLOR[d.name] ?? '#94A3B8'} />)}
                    <LabelList dataKey="lenders" position="top" formatter={(v: number) => v.toFixed(2)}
                      style={{ fontSize: 10, fill: '#334155', fontWeight: 700 }} />
                  </Bar>
                  <Line yAxisId="r" type="monotone" dataKey="overdue_lender_pct" name="w/ overdue lender %"
                    stroke={INK} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Paper>
      </Box>

      {/* ── Row 2: client category + branch scatter ────────────────────────── */}
      <Box className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Paper sx={{ overflow: 'hidden' }}>
          <PanelHead title="Approval rate by client category" sub="Bar width is not volume — see the pull count in the tooltip" />
          <Box sx={{ p: 2, height: 260 }}>
            {byCategory.isLoading ? <Skeleton variant="rectangular" height={220} /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={catData} margin={{ top: 20, right: 16, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10.5, fill: MUTED }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: MUTED }} width={40}
                    tickFormatter={(v: number) => `${v}%`} />
                  <RTooltip contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number, _n, p: { payload?: { pulls?: number; lenders?: number } }) =>
                      [`${v.toFixed(1)}% of ${(p.payload?.pulls ?? 0).toLocaleString('en-IN')} pulls · ${(p.payload?.lenders ?? 0).toFixed(2)} avg lenders`, 'Approval']} />
                  <Bar dataKey="approval_rate" radius={[4, 4, 0, 0]} barSize={54} isAnimationActive={false}>
                    {catData.map((d, i) => <Cell key={i} fill={approvalColor(d.approval_rate)} />)}
                    <LabelList dataKey="approval_rate" position="top" formatter={(v: number) => `${v.toFixed(1)}%`}
                      style={{ fontSize: 11, fill: '#334155', fontWeight: 700 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Paper>

        <Paper sx={{ overflow: 'hidden' }}>
          <PanelHead title="Branch: volume vs approval rate" sub="Each dot is a branch — bottom-right means high volume at low approval" />
          <Box sx={{ p: 2, height: 260 }}>
            {byBranch.isLoading ? <Skeleton variant="rectangular" height={220} /> : (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 12, right: 16, left: 4, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
                  <XAxis type="number" dataKey="pulls" name="Pulls" tick={{ fontSize: 10, fill: MUTED }}
                    tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
                  <YAxis type="number" dataKey="approval_rate" name="Approval %" domain={[0, 100]}
                    width={40} tick={{ fontSize: 10, fill: MUTED }} tickFormatter={(v: number) => `${v}%`} />
                  <ZAxis type="number" dataKey="overdue_lender_pct" range={[30, 260]} />
                  <RTooltip cursor={{ strokeDasharray: '3 3' }}
                    contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number, n: string) => [n === 'Approval %' ? `${v.toFixed(1)}%` : v.toLocaleString('en-IN'), n]}
                    labelFormatter={() => ''}
                    content={({ payload }) => {
                      const p = payload?.[0]?.payload as { name?: string; pulls?: number; approval_rate?: number; overdue_lender_pct?: number } | undefined
                      if (!p) return null
                      return (
                        <Box sx={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 1, p: 1, fontSize: 11 }}>
                          <b>{p.name}</b><br />
                          {(p.pulls ?? 0).toLocaleString('en-IN')} pulls · {(p.approval_rate ?? 0).toFixed(1)}% approved<br />
                          {(p.overdue_lender_pct ?? 0).toFixed(1)}% with an overdue lender
                        </Box>
                      )
                    }} />
                  <Scatter data={branchData} isAnimationActive={false}>
                    {branchData.map((d, i) => <Cell key={i} fill={approvalColor(d.approval_rate)} fillOpacity={0.7} />)}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Paper>
      </Box>

      {/* ── Detail table ───────────────────────────────────────────────────── */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ px: 2.5, py: 1.25, borderBottom: '1px solid rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box>
            <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: INK }}>
              Bureau Detail — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
            </Box>
            <Box sx={{ fontSize: '0.68rem', color: '#94A3B8', mt: 0.2 }}>
              {sortedRows.length} row{sortedRows.length === 1 ? '' : 's'} · exposure, overdue and EMI are with other lenders at pull date
            </Box>
          </Box>
          <Box sx={{ flex: 1 }} />
          <Box component="button" onClick={exportCsv} sx={{
            fontSize: '0.72rem', fontWeight: 700, color: '#1E40AF', background: '#EFF6FF',
            border: '1px solid #BFDBFE', borderRadius: 1.5, px: 1.5, py: 0.6, cursor: 'pointer',
            '&:hover': { background: '#DBEAFE' },
          }}>↓ Export CSV</Box>
        </Box>
        {loading ? (
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={26} />)}
          </Box>
        ) : sortedRows.length === 0 ? (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 180, color: '#94A3B8', fontSize: '0.85rem' }}>
            No bureau pulls in the current selection.
          </Box>
        ) : (
          <Box sx={{ overflowX: 'auto', maxHeight: 480 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow sx={{ '& th': { background: '#F8FAFF', borderBottom: '1px solid rgba(0,0,0,0.08)', fontWeight: 700, fontSize: '0.68rem', color: '#1E40AF', whiteSpace: 'nowrap' } }}>
                  <TableCell sx={{ position: 'sticky', left: 0, zIndex: 3 }}>{ap1Label}</TableCell>
                  {hasAp2 && <TableCell>{ap2Label}</TableCell>}
                  {NUM_COLS.map((c) => (
                    <TableCell key={String(c.field)} align="right" sortDirection={sortField === c.field ? sortDir : false}>
                      <TableSortLabel active={sortField === c.field}
                        direction={sortField === c.field ? sortDir : 'asc'}
                        onClick={() => handleSort(c.field)}>{c.label}</TableSortLabel>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedRows.map((r, i) => (
                  <TableRow key={i} hover>
                    <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>
                      {ap1 === 'decision' ? (
                        <Box component="span" sx={{
                          display: 'inline-block', width: 8, height: 8, borderRadius: '50%', mr: 0.8,
                          background: DECISION_COLOR[r.name] ?? '#94A3B8',
                        }} />
                      ) : null}
                      {r.name}
                    </TableCell>
                    {hasAp2 && <TableCell sx={{ color: '#475569', whiteSpace: 'nowrap' }}>{r.name2 ?? '—'}</TableCell>}
                    {NUM_COLS.map((c) => (
                      <TableCell key={String(c.field)} align="right" sx={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem',
                        color: c.field === 'approval_rate' ? approvalColor(Number(r.approval_rate))
                             : c.risk ? REJECTED : INK,
                        fontWeight: c.risk || c.field === 'approval_rate' ? 700 : 400,
                      }}>{c.fmt(Number(r[c.field] ?? 0))}</TableCell>
                    ))}
                  </TableRow>
                ))}
                {g && (
                  <TableRow sx={{ '& td': { fontWeight: 800, borderTop: '2px solid rgba(0,0,0,0.15)', background: '#F8FAFF' } }}>
                    <TableCell sx={{ position: 'sticky', left: 0, background: '#F8FAFF', zIndex: 1 }}>Grand Total</TableCell>
                    {hasAp2 && <TableCell />}
                    {NUM_COLS.map((c) => (
                      <TableCell key={String(c.field)} align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem' }}>
                        {c.fmt(Number(g[c.field] ?? 0))}
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Box>
  )
}

function PanelHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <Box sx={{ px: 2.5, py: 1.25, borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
      <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: INK }}>{title}</Box>
      {sub && <Box sx={{ fontSize: '0.68rem', color: '#94A3B8', mt: 0.2 }}>{sub}</Box>}
    </Box>
  )
}

function DimSelect({ label, value, options, onChange }: {
  label: string; value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <Box sx={{ flexShrink: 0 }}>
      <Box sx={{ fontSize: '0.55rem', color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</Box>
      <FormControl size="small" sx={{ minWidth: 130 }}>
        <Select value={value} onChange={(e) => onChange(e.target.value)}
          sx={{ fontSize: '0.72rem', height: 24, '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(0,0,0,0.15)' } }}>
          {options.map((o) => <MenuItem key={o.value} value={o.value} sx={{ fontSize: '0.72rem' }}>{o.label}</MenuItem>)}
        </Select>
      </FormControl>
    </Box>
  )
}
