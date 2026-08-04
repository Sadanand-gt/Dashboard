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
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, Cell,
  CartesianGrid, LabelList, Legend, PieChart, Pie, ComposedChart, Line,
} from 'recharts'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { useSlicerParams } from '../store/filterStore'
import { bucketRank } from './collectionShared'

// ── Palette ───────────────────────────────────────────────────────────────────
const CASH = '#16A34A'   // cash collected
const IWAIV = '#D97706'  // interest waiver
const PWAIV = '#DC2626'  // principal waiver
const INK = '#0F172A'
const MUTED = '#64748B'

const DIM_OPTIONS = [
  { value: 'settle_bucket',    label: 'Settlement Bucket' },
  { value: 'business_segment', label: 'Business Segment' },
  { value: 'settle_year',      label: 'Settlement Year' },
  { value: 'settle_month',     label: 'Settlement Month' },
  { value: 'cluster_name',     label: 'Cluster' },
  { value: 'region_name',      label: 'Region' },
  { value: 'area_name',        label: 'Unit' },
  { value: 'branch_name',      label: 'Branch' },
  { value: 'lo_id',            label: 'Loan Officer' },
  { value: 'product_id',       label: 'Product' },
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
const cr = (v: number) => (v ?? 0) / 1e7

// Recovery-rate colour ramp.
const recoveryColor = (pct: number): string =>
  pct >= 70 ? '#16A34A' : pct >= 50 ? '#65A30D' : pct >= 30 ? '#D97706' : '#DC2626'

interface Row {
  name: string; name2?: string
  ots_count: number; ots_amount: number
  principal_collected: number; interest_collected: number
  principal_waiver: number; interest_waiver: number; total_waiver: number
  net_amount_collected: number; net_principal: number; net_interest: number
  waiver_pct: number; recovery_pct: number
}
interface Resp {
  rows: Row[]; grand: Row; as_of: string | null
  dims: { value: string; label: string }[]
  filter?: { param: string; label: string; options: string[] } | null
}

export function Ots() {
  const [ap1, setAp1] = useState('settle_bucket')
  const [ap2, setAp2] = useState('none')
  const [year, setYear] = useState('ALL')
  const [sortField, setSortField] = useState<keyof Row>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const slicers = useSlicerParams()

  const base = useMemo(() => {
    const p: Record<string, string> = { ...slicers }
    if (year !== 'ALL') p.pick = year
    return p
  }, [slicers, year])

  const q = (key: string, group_by: string, group_by_2?: string) =>
    useQuery<Resp>({
      queryKey: ['ots', key, base, group_by, group_by_2],
      queryFn: () => api.get('/api/ots/summary', {
        params: { ...base, group_by, ...(group_by_2 ? { group_by_2 } : {}) },
      }).then((r) => r.data),
    })

  const table = q('table', ap1, ap2 !== 'none' ? ap2 : undefined)
  const byBucket = q('bucket', 'settle_bucket')
  const byMonth = q('month', 'settle_month')
  const byBranch = q('branch', 'branch_name')

  const g = table.data?.grand
  const loading = table.isLoading
  const years = table.data?.filter?.options ?? []

  // ── Cash / interest waiver / principal waiver, per settlement bucket
  const bucketData = useMemo(() => {
    const rows = (byBucket.data?.rows ?? []).filter((r) => r.name !== 'Grand Total')
    return rows
      .sort((a, b) => bucketRank(a.name) - bucketRank(b.name))
      .map((r) => ({
        name: r.name,
        cash: cr(r.net_amount_collected),
        iwaiv: cr(r.interest_waiver),
        pwaiv: cr(r.principal_waiver),
        recovery_pct: r.recovery_pct,
        cases: r.ots_count,
        settled: cr(r.ots_amount),
      }))
  }, [byBucket.data])

  // ── Total waiver split into its principal and interest legs
  const waiverPie = useMemo(() => {
    if (!g) return []
    return [
      { name: 'Principal Waiver', value: g.principal_waiver, fill: PWAIV },
      { name: 'Interest Waiver', value: g.interest_waiver, fill: IWAIV },
    ].filter((d) => d.value > 0)
  }, [g])

  // ── Amount settled and cash collected, by settlement month
  const monthData = useMemo(() => {
    const rows = (byMonth.data?.rows ?? []).filter((r) => r.name !== 'Grand Total')
    return rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(-18)
      .map((r) => ({
        name: r.name,
        settled: cr(r.ots_amount),
        cash: cr(r.net_amount_collected),
        recovery_pct: r.recovery_pct,
        cases: r.ots_count,
      }))
  }, [byMonth.data])

  // ── Total waiver by branch, top 10
  const branchData = useMemo(() => {
    const rows = (byBranch.data?.rows ?? []).filter((r) => r.name !== 'Grand Total')
    return rows
      .map((r) => ({
        name: r.name.length > 20 ? r.name.slice(0, 18) + '…' : r.name,
        waiver: cr(r.total_waiver),
        recovery_pct: r.recovery_pct,
        cases: r.ots_count,
      }))
      .sort((a, b) => b.waiver - a.waiver)
      .slice(0, 10)
  }, [byBranch.data])

  // ── Branches whose settlements returned under 5% of the settled amount in cash
  const zeroRecovery = useMemo(() => {
    const rows = (byBranch.data?.rows ?? []).filter((r) => r.name !== 'Grand Total')
    return rows.filter((r) => r.recovery_pct < 5 && r.total_waiver > 0)
      .sort((a, b) => b.total_waiver - a.total_waiver)
  }, [byBranch.data])

  const BUCKET_DIMS = ['settle_bucket']

  const sortedRows = useMemo(() => {
    const body = [...(table.data?.rows ?? [])].filter((r) => r.name !== 'Grand Total')
    // Canonical OD Bucket order always wins over value sorting when the grouping
    // dimension is a bucket — 61-90, 91-180, 181-360, 360+ (never alphabetical).
    if (BUCKET_DIMS.includes(ap1) && sortField === 'name') {
      body.sort((a, b) => (bucketRank(a.name) - bucketRank(b.name)) * (sortDir === 'asc' ? 1 : -1))
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

  const exportCsv = () => {
    const cols: (keyof Row)[] = ['ots_count', 'ots_amount', 'principal_collected', 'interest_collected',
      'principal_waiver', 'interest_waiver', 'total_waiver', 'net_amount_collected',
      'net_principal', 'net_interest', 'waiver_pct', 'recovery_pct']
    const head = [ap1Label, ...(hasAp2 ? [ap2Label] : []), ...cols.map(String)].join(',')
    const lines = sortedRows.map((r) =>
      [`"${r.name}"`, ...(hasAp2 ? [`"${r.name2 ?? ''}"`] : []), ...cols.map((c) => r[c] ?? 0)].join(','))
    const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `ots_recovery_${ap1}${year !== 'ALL' ? '_' + year : ''}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const hasAp2 = ap2 !== 'none'
  const ap1Label = DIM_OPTIONS.find((o) => o.value === ap1)?.label ?? 'Group'
  const ap2Label = DIM_OPTIONS.find((o) => o.value === ap2)?.label ?? ''

  const NUM_COLS: { field: keyof Row; label: string; fmt: (v: number) => string; risk?: boolean }[] = [
    { field: 'ots_count',            label: 'Cases',            fmt: fmtNum },
    { field: 'ots_amount',           label: 'Settled',          fmt: fmtInr },
    { field: 'principal_collected',  label: 'Principal Coll.',  fmt: fmtInr },
    { field: 'interest_collected',   label: 'Interest Coll.',   fmt: fmtInr },
    { field: 'principal_waiver',     label: 'Principal Waiver', fmt: fmtInr },
    { field: 'interest_waiver',      label: 'Interest Waiver',  fmt: fmtInr },
    { field: 'total_waiver',         label: 'Total Waiver',     fmt: fmtInr },
    { field: 'net_amount_collected', label: 'Net Cash',         fmt: fmtInr },
    { field: 'net_principal',        label: 'Net Principal',    fmt: fmtInr },
    { field: 'net_interest',         label: 'Net Interest',     fmt: fmtInr },
    { field: 'waiver_pct',           label: 'Waiver %',         fmt: fmtPct, risk: true },
    { field: 'recovery_pct',         label: 'Recovery %',       fmt: fmtPct },
  ]

  return (
    <Box className="space-y-3">
      {/* ── 2. FILTER BAR ─────────────────────────────────────────────────── */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'nowrap', background: '#FFFFFF',
        borderRadius: 2, px: 2, py: 0.75, border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflowX: 'auto',
      }}>
        <Box sx={{ fontSize: '0.95rem', fontWeight: 800, color: INK, flexShrink: 0 }}>OTS &amp; Recovery</Box>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="AP #1" value={ap1} options={DIM_OPTIONS} onChange={setAp1} />
        <DimSelect label="AP #2" value={ap2} options={AP2_OPTIONS} onChange={setAp2} />
        <Divider orientation="vertical" flexItem sx={{ mx: 0.25, height: 20, alignSelf: 'center' }} />
        <DimSelect label="Settlement Year" value={year}
          options={[{ value: 'ALL', label: 'All years' }, ...years.map((y) => ({ value: y, label: y }))]}
          onChange={setYear} />
        <Box sx={{ flex: 1, minWidth: 8 }} />
        <Tooltip title="Data as-of (T-1)" placement="left">
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Box sx={{ fontSize: '0.58rem', color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>As of</Box>
            <Box sx={{ fontSize: '0.68rem', color: MUTED, fontWeight: 600, whiteSpace: 'nowrap' }}>{table.data?.as_of ?? '—'}</Box>
          </Box>
        </Tooltip>
      </Box>

      {/* ── 1. KPI CARDS ──────────────────────────────────────────────────── */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 1.5, alignItems: 'stretch' }}>
        <KpiCard label="OTS Cases" value={g ? fmtNum(g.ots_count) : '—'}
          sub="60+ at settlement" variant="default" loading={loading} />
        <KpiCard label="Amount Settled" value={g ? fmtInr(g.ots_amount) : '—'}
          sub="amount settled" variant="purple" loading={loading} />
        <KpiCard label="Net Cash Collected" value={g ? fmtInr(g.net_amount_collected) : '—'}
          sub={g ? `${fmtPct(g.recovery_pct)} of settled` : ''} variant="green" loading={loading} />
        <KpiCard label="Principal Waiver" value={g ? fmtInr(g.principal_waiver) : '—'}
          sub={g ? `${fmtPct(g.ots_amount ? (g.principal_waiver / g.ots_amount) * 100 : 0)} of settled` : ''} variant="red" loading={loading} />
        <KpiCard label="Interest Waiver" value={g ? fmtInr(g.interest_waiver) : '—'}
          sub={g ? `${fmtPct(g.ots_amount ? (g.interest_waiver / g.ots_amount) * 100 : 0)} of settled` : ''} variant="amber" loading={loading} />
        <KpiCard label="Total Waiver" value={g ? fmtInr(g.total_waiver) : '—'}
          sub={g ? `${fmtPct(g.waiver_pct)} of settled` : ''} variant="red" loading={loading} />
      </Box>

      {/* ── Exception band — settlements returning ~no cash ────────────────── */}
      {zeroRecovery.length > 0 && (
        <Paper sx={{ overflow: 'hidden', border: '1px solid #FECACA' }}>
          <Box sx={{ px: 2.5, py: 1, background: '#FEF2F2', display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
            <Box sx={{ fontWeight: 800, fontSize: '0.82rem', color: '#991B1B' }}>Recovery under 5%</Box>
            <Box sx={{ fontSize: '0.72rem', color: '#B91C1C' }}>
              {zeroRecovery.length} branch{zeroRecovery.length > 1 ? 'es' : ''} ·{' '}
              {fmtNum(zeroRecovery.reduce((s, r) => s + r.ots_count, 0))} cases ·{' '}
              {fmtInr(zeroRecovery.reduce((s, r) => s + r.ots_amount, 0))} settled ·{' '}
              {fmtInr(zeroRecovery.reduce((s, r) => s + r.total_waiver, 0))} waived
            </Box>
          </Box>
          <Box sx={{ px: 2.5, py: 1, display: 'flex', gap: 2.5, flexWrap: 'wrap' }}>
            {zeroRecovery.slice(0, 6).map((r) => (
              <Box key={r.name} sx={{ fontSize: '0.72rem', color: '#475569' }}>
                <b style={{ color: INK }}>{r.name}</b> · {fmtNum(r.ots_count)} cases ·{' '}
                <span style={{ color: PWAIV, fontWeight: 700 }}>{fmtInr(r.total_waiver)}</span> waived ·{' '}
                {fmtPct(r.recovery_pct)} back
              </Box>
            ))}
          </Box>
        </Paper>
      )}

      {/* ── 3. CHARTS ─────────────────────────────────────────────────────── */}
      {/* Row 1 — where the settled money went, and the recovery gradient */}
      <Box className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Paper sx={{ overflow: 'hidden', gridColumn: 'span 1', ...{ '@media (min-width:1024px)': { gridColumn: 'span 2' } } }}>
          <PanelHead title="Settlement composition" sub="Cash collected, interest waiver and principal waiver, by settlement bucket (₹ Cr)" />
          <Box sx={{ p: 2, height: 300 }}>
            {byBucket.isLoading ? <Skeleton variant="rectangular" height={260} /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bucketData} margin={{ top: 16, right: 16, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: MUTED }} />
                  <YAxis tick={{ fontSize: 10, fill: MUTED }} width={46}
                    tickFormatter={(v: number) => v.toFixed(2)} />
                  <RTooltip
                    contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number, n: string) => [`₹${v.toFixed(3)} Cr`, n]}
                    labelFormatter={(l: string) => {
                      const d = bucketData.find((x) => x.name === l)
                      return `${l} — ${d ? fmtNum(d.cases) : 0} cases · ₹${d?.settled.toFixed(3)} Cr settled`
                    }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="cash"  stackId="a" name="Cash collected"   fill={CASH}  barSize={54} />
                  <Bar dataKey="iwaiv" stackId="a" name="Interest waived"  fill={IWAIV} barSize={54} />
                  <Bar dataKey="pwaiv" stackId="a" name="Principal waived" fill={PWAIV} barSize={54} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Paper>

        <Paper sx={{ overflow: 'hidden' }}>
          <PanelHead title="Waiver split" sub="Total waiver by leg" />
          <Box sx={{ p: 2, height: 300 }}>
            {loading ? <Skeleton variant="rectangular" height={260} /> : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={waiverPie} dataKey="value" nameKey="name" cx="50%" cy="45%"
                    innerRadius={54} outerRadius={88} paddingAngle={2}
                    label={(e: { name: string; percent?: number }) => `${((e.percent ?? 0) * 100).toFixed(0)}%`}
                    labelLine={false} isAnimationActive={false}>
                    {waiverPie.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <RTooltip formatter={(v: number) => fmtInr(v)}
                    contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} verticalAlign="bottom" />
                </PieChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Paper>
      </Box>

      {/* Row 2 — the gradient that matters, and vintage */}
      <Box className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Paper sx={{ overflow: 'hidden' }}>
          <PanelHead title="Recovery % by settlement bucket"
            sub="Cash collected as a share of the amount settled" />
          <Box sx={{ p: 2, height: 260 }}>
            {byBucket.isLoading ? <Skeleton variant="rectangular" height={220} /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bucketData} margin={{ top: 20, right: 16, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: MUTED }} />
                  <YAxis tick={{ fontSize: 10, fill: MUTED }} width={40} domain={[0, 100]}
                    tickFormatter={(v: number) => `${v}%`} />
                  <RTooltip formatter={(v: number) => [`${v.toFixed(1)}%`, 'Recovery']}
                    contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }} />
                  <Bar dataKey="recovery_pct" radius={[4, 4, 0, 0]} barSize={54} isAnimationActive={false}>
                    {bucketData.map((d, i) => <Cell key={i} fill={recoveryColor(d.recovery_pct)} />)}
                    <LabelList dataKey="recovery_pct" position="top"
                      formatter={(v: number) => `${v.toFixed(1)}%`}
                      style={{ fontSize: 11, fill: '#334155', fontWeight: 700 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Paper>

        <Paper sx={{ overflow: 'hidden' }}>
          <PanelHead title="Settlement vintage" sub="Amount settled and cash collected by month (₹ Cr), with recovery %" />
          <Box sx={{ p: 2, height: 260 }}>
            {byMonth.isLoading ? <Skeleton variant="rectangular" height={220} /> : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={monthData} margin={{ top: 16, right: 8, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: MUTED }} interval="preserveStartEnd" />
                  <YAxis yAxisId="l" tick={{ fontSize: 10, fill: MUTED }} width={44} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: MUTED }} width={40}
                    domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
                  <RTooltip contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number, n: string) => [n === 'Recovery %' ? `${v.toFixed(1)}%` : `₹${v.toFixed(3)} Cr`, n]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="l" dataKey="settled" name="Settled" fill="#CBD5E1" barSize={16} radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="l" dataKey="cash" name="Cash collected" fill={CASH} barSize={16} radius={[3, 3, 0, 0]} />
                  <Line yAxisId="r" type="monotone" dataKey="recovery_pct" name="Recovery %"
                    stroke={IWAIV} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Paper>
      </Box>

      {/* Row 3 — branch concentration */}
      <Paper sx={{ overflow: 'hidden' }}>
        <PanelHead title="Waiver concentration — top branches"
          sub="Total waiver per branch; bar colour shows that branch's recovery %" />
        <Box sx={{ p: 2, height: Math.max(230, branchData.length * 26) }}>
          {byBranch.isLoading ? <Skeleton variant="rectangular" height={220} /> : branchData.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={branchData} layout="vertical" margin={{ top: 4, right: 96, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: MUTED }} tickFormatter={(v: number) => v.toFixed(2)} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10.5, fill: '#475569' }}
                  axisLine={false} tickLine={false} width={140} />
                <RTooltip contentStyle={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, fontSize: 11 }}
                  formatter={(v: number, _n, p: { payload?: { recovery_pct?: number; cases?: number } }) =>
                    [`₹${v.toFixed(3)} Cr · ${(p.payload?.recovery_pct ?? 0).toFixed(1)}% recovered · ${p.payload?.cases ?? 0} cases`, 'Waiver']} />
                <Bar dataKey="waiver" radius={[0, 4, 4, 0]} barSize={15} isAnimationActive={false}>
                  {branchData.map((d, i) => <Cell key={i} fill={recoveryColor(d.recovery_pct)} />)}
                  <LabelList dataKey="waiver" position="right"
                    formatter={(v: number) => `₹${v.toFixed(3)} Cr`}
                    style={{ fontSize: 10, fill: '#334155', fontWeight: 700 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Box>
      </Paper>

      {/* ── 4. DETAIL TABLE ───────────────────────────────────────────────── */}
      <Paper sx={{ overflow: 'hidden' }}>
        <Box sx={{ px: 2.5, py: 1.25, borderBottom: '1px solid rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box>
            <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: INK }}>
              OTS Detail — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
            </Box>
            <Box sx={{ fontSize: '0.68rem', color: '#94A3B8', mt: 0.2 }}>
              {sortedRows.length} row{sortedRows.length === 1 ? '' : 's'} · waiver applied interest-first, then principal
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
        ) : sortedRows.length === 0 ? <Empty /> : (
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
                    <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>{r.name}</TableCell>
                    {hasAp2 && <TableCell sx={{ color: '#475569', whiteSpace: 'nowrap' }}>{r.name2 ?? '—'}</TableCell>}
                    {NUM_COLS.map((c) => (
                      <TableCell key={String(c.field)} align="right" sx={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem',
                        color: c.field === 'recovery_pct' ? recoveryColor(Number(r.recovery_pct))
                             : c.risk ? PWAIV : INK,
                        fontWeight: c.risk || c.field === 'recovery_pct' ? 700 : 400,
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

// ── Small building blocks ─────────────────────────────────────────────────────
function PanelHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <Box sx={{ px: 2.5, py: 1.25, borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
      <Box sx={{ fontWeight: 700, fontSize: '0.85rem', color: INK }}>{title}</Box>
      {sub && <Box sx={{ fontSize: '0.68rem', color: '#94A3B8', mt: 0.2 }}>{sub}</Box>}
    </Box>
  )
}

function Empty() {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#94A3B8', fontSize: '0.85rem' }}>
      No settlements in the current selection.
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
      <FormControl size="small" sx={{ minWidth: 132 }}>
        <Select value={value} onChange={(e) => onChange(e.target.value)}
          sx={{ fontSize: '0.72rem', height: 24, '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(0,0,0,0.15)' } }}>
          {options.map((o) => <MenuItem key={o.value} value={o.value} sx={{ fontSize: '0.72rem' }}>{o.label}</MenuItem>)}
        </Select>
      </FormControl>
    </Box>
  )
}
