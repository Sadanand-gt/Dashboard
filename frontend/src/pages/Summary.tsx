import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  Legend, ReferenceLine,
} from 'recharts'
import { api } from '../api/client'
import { useAuthStore } from '../store/authStore'

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  blue: '#1565C0', green: '#16A34A', amber: '#D97706', red: '#DC2626',
  teal: '#0F766E', purple: '#7C3AED', ink: '#1E293B', muted: '#64748B',
  border: 'rgba(15,23,42,0.09)', soft: '#F1F5F9',
}
const SEG_COLOR: Record<string, string> = { JLG: '#1565C0', IEL: '#0F766E', LAP: '#7C3AED' }
const segColor = (s: string, i: number) => SEG_COLOR[s] ?? ['#1565C0', '#0F766E', '#7C3AED', '#D97706', '#DC2626'][i % 5]

// ── Types (only fields we read) ───────────────────────────────────────────────
interface AumKpis { total_pos: number; total_loans: number; par0_pos: number; par0_pct: number; par30_pos: number; par30_pct: number; par90_pos: number; par90_pct: number; wo_pos?: number }
interface SegRow { name: string; pos: number; loans: number; par0_pct: number; par30_pct: number; par90_pct: number }
interface CollKpis { mtd_ce: number; mtd_demand: number; mtd_collection: number }
interface DisbKpis { mtd_amount: number; mtd_count: number; ytd_amount: number; ytd_count: number; pm_amount: number; pm_count: number }
interface AgeingKpis { total_pos: number; od_amt: number; od_pct: number; loans_in_od: number }
interface OdKpis { slippage: number; continuing: number; regularized: number; not_od: number }
interface WoKpis { total_amount: number; recovery_amount: number; net_loss: number; recovery_pct: number }
interface Series { labels: string[]; rows: { name: string; values: (number | null)[] }[]; grand: (number | null)[] }

// ── Formatters ────────────────────────────────────────────────────────────────
function inr(v: number | undefined | null): string {
  if (v == null) return '—'
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
const cr = (v: number) => `${(v / 1e7).toFixed(1)}`
const pct = (v: number | undefined | null) => (v == null ? '—' : `${v.toFixed(2)}%`)
const num = (v: number | undefined | null) => (v == null ? '—' : v.toLocaleString('en-IN'))

type Portfolio = 'with' | 'without'

/** The three report families express "Excl. W/O" differently — map once, here.
 *  · /api/aum/*        : no portfolio param; drops Write-off via loan_status
 *  · collection/ageing/od-status : portfolio=with|without
 *  · /api/trend/series : portfolio=with|excl
 *  Disbursement is deliberately absent: a disbursal is a disbursal, writing the
 *  loan off later does not un-disburse it, so the toggle must not touch it. */
const aumParams = (p: Portfolio) => (p === 'with' ? {} : { loan_status: 'Active,Death' })
const apiParams = (p: Portfolio) => ({ portfolio: p })

function useSeries(measure: string, window: number, portfolio: Portfolio, groupBy = 'business_segment') {
  const pf = portfolio === 'without' ? 'excl' : 'with'
  return useQuery<Series>({
    queryKey: ['exec-trend', measure, window, groupBy, pf],
    queryFn: () => api.get(`/api/trend/series?measure=${measure}&window=${window}&group_by=${groupBy}&portfolio=${pf}`).then((r) => r.data),
  })
}
// last-vs-previous delta from a grand[] series
function delta(g?: (number | null)[]): number | null {
  if (!g || g.length < 2) return null
  const a = g[g.length - 1], b = g[g.length - 2]
  if (a == null || b == null || b === 0) return null
  return ((a - b) / Math.abs(b)) * 100
}
function ppDelta(g?: (number | null)[]): number | null {
  if (!g || g.length < 2) return null
  const a = g[g.length - 1], b = g[g.length - 2]
  if (a == null || b == null) return null
  return a - b
}

export function Summary() {
  const { user } = useAuthStore()

  const [portfolio, setPortfolio] = useState<Portfolio>('with')
  const aumP = aumParams(portfolio)
  const apiP = apiParams(portfolio)

  const aum = useQuery<AumKpis>({ queryKey: ['aum-kpis', aumP], queryFn: () => api.get('/api/aum/kpis', { params: aumP }).then((r) => r.data) })
  const seg = useQuery<SegRow[]>({ queryKey: ['aum-seg', aumP], queryFn: () => api.get('/api/aum/group-summary', { params: { ...aumP, group_by: 'business_segment' } }).then((r) => r.data) })
  // Canonical MTD Collection Efficiency (.pbit CE) — same source as the MTD
  // Collection page; the old daily cumul_ce read >100% (wrong base).
  const collExcl = useQuery<CollKpis>({ queryKey: ['coll-kpis', apiP], queryFn: () => api.get('/api/collection/kpis', { params: apiP }).then((r) => r.data) })
  const disb = useQuery<DisbKpis>({ queryKey: ['disb-kpis'], queryFn: () => api.get('/api/disbursement/kpis').then((r) => r.data) })
  const ageing = useQuery<AgeingKpis>({ queryKey: ['ageing-kpis', apiP], queryFn: () => api.get('/api/ageing/kpis', { params: apiP }).then((r) => r.data) })
  const od = useQuery<OdKpis>({ queryKey: ['od-kpis', apiP], queryFn: () => api.get('/api/od-status/kpis', { params: apiP }).then((r) => r.data) })
  // Write-off KPIs are the write-off book itself — never portfolio-filtered.
  const wo = useQuery<WoKpis>({ queryKey: ['wo-kpis'], queryFn: () => api.get('/api/writeoff/kpis').then((r) => r.data) })
  const asOf = useQuery<{ refresh: string }>({ queryKey: ['aum-refresh'], queryFn: () => api.get('/api/aum/refresh').then((r) => r.data) })

  const aumTrend = useSeries('pos', 24, portfolio)
  const ceTrend = useSeries('ce_pct', 24, portfolio)
  const disbTrend = useSeries('disb_amount', 12, portfolio)
  const slipTrend = useSeries('slip_count', 12, portfolio)

  const a = aum.data
  const segRows = (seg.data ?? []).filter((r) => r.name !== 'Grand Total')

  return (
    <Box sx={{ pb: 4 }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <Box className="flex items-end justify-between flex-wrap gap-2" sx={{ mb: 2.5 }}>
        <Box>
          <Box sx={{ fontSize: '1.35rem', fontWeight: 800, color: C.ink, letterSpacing: '-0.01em' }}>
            Executive Summary
          </Box>
          <Box sx={{ fontSize: '0.78rem', color: C.muted, mt: 0.3 }}>
            Portfolio overview · Ananya Finance{user && user.scope_level && user.scope_value ? ` · ${user.scope_value}` : ''}
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 2.5 }}>
          <Box>
            <Box sx={{ fontSize: '0.6rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em', mb: 0.4 }}>Portfolio</Box>
            <ToggleButtonGroup size="small" exclusive value={portfolio}
              onChange={(_, v) => { if (v) setPortfolio(v as Portfolio) }} sx={{ height: 28 }}>
              <ToggleButton value="with" sx={{ px: 1.4, fontSize: '0.7rem', textTransform: 'none' }}>With W/O</ToggleButton>
              <ToggleButton value="without" sx={{ px: 1.4, fontSize: '0.7rem', textTransform: 'none' }}>Excl. W/O</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Box sx={{ textAlign: 'right' }}>
            <Box sx={{ fontSize: '0.6rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Data as of</Box>
            <Box sx={{ fontSize: '0.9rem', fontWeight: 700, color: C.ink }}>{asOf.data?.refresh ?? '—'}</Box>
          </Box>
        </Box>
      </Box>

      {/* ── Hero KPI band ──────────────────────────────────────────────────── */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2,1fr)', md: 'repeat(3,1fr)', lg: 'repeat(6,1fr)' }, gap: 1.5, mb: 3 }}>
        <Kpi accent={C.blue}   label="Total AUM"        value={inr(a?.total_pos)}   sub={`${num(a?.total_loans)} loans`} deltaPct={delta(aumTrend.data?.grand)} />
        <Kpi accent={C.green}  label="MTD Coll. Eff."   value={pct(collExcl.data?.mtd_ce)} sub={`${portfolio === 'with' ? 'With' : 'Excl.'} W/O · collection ÷ demand`} deltaPp={ppDelta(ceTrend.data?.grand)} good="up" />
        <Kpi accent={C.amber}  label="PAR 30+"          value={pct(a?.par30_pct)}   sub={inr(a?.par30_pos)} good="down" />
        <Kpi accent={C.red}    label="PAR 90+"          value={pct(a?.par90_pct)}   sub={inr(a?.par90_pos)} good="down" />
        <Kpi accent={C.teal}   label="MTD Disbursement" value={inr(disb.data?.mtd_amount)} sub={`${num(disb.data?.mtd_count)} loans`} deltaPct={delta(disbTrend.data?.grand)} good="up" />
        <Kpi accent={C.purple} label="Net Write-off"    value={inr(wo.data?.net_loss)}  sub={`${pct(wo.data?.recovery_pct)} recovered`} good="down" />
      </Box>

      {/* ── Row: AUM trend + segment mix ───────────────────────────────────── */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '3fr 2fr' }, gap: 2, mb: 2 }}>
        <Panel title="AUM Trend" subtitle="Outstanding by segment — 24 months (₹ Cr) · latest point = live">
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={toChart(aumTrend.data)} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <defs>
                {['JLG', 'IEL', 'LAP'].map((s, i) => (
                  <linearGradient key={s} id={`g-${s}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={segColor(s, i)} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={segColor(s, i)} stopOpacity={0.03} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: C.muted }} interval={2} />
              <YAxis tick={{ fontSize: 10, fill: C.muted }} width={40} tickFormatter={(v: number) => cr(v)} />
              <RTooltip formatter={(v: number, n) => [`₹${cr(v)} Cr`, n]} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {(aumTrend.data?.rows ?? []).map((r, i) => (
                <Area key={r.name} type="monotone" dataKey={r.name} stackId="1" stroke={segColor(r.name, i)} fill={`url(#g-${r.name})`} strokeWidth={1.6} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Portfolio Composition" subtitle="Outstanding by business segment">
          <Box sx={{ display: 'flex', alignItems: 'center', height: 280 }}>
            <ResponsiveContainer width="55%" height={220}>
              <PieChart>
                <Pie data={segRows} dataKey="pos" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={82} paddingAngle={2}>
                  {segRows.map((r, i) => <Cell key={r.name} fill={segColor(r.name, i)} />)}
                </Pie>
                <RTooltip formatter={(v: number) => inr(v)} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
            <Box sx={{ flex: 1, pr: 1 }}>
              {segRows.map((r, i) => {
                const total = segRows.reduce((s, x) => s + x.pos, 0) || 1
                return (
                  <Box key={r.name} sx={{ mb: 1.2 }}>
                    <Box className="flex items-center justify-between" sx={{ fontSize: '0.78rem' }}>
                      <Box className="flex items-center gap-1.5">
                        <Box sx={{ width: 9, height: 9, borderRadius: '2px', background: segColor(r.name, i) }} />
                        <Box sx={{ fontWeight: 700, color: C.ink }}>{r.name}</Box>
                      </Box>
                      <Box sx={{ fontWeight: 700, color: C.ink }}>{inr(r.pos)}</Box>
                    </Box>
                    <Box sx={{ fontSize: '0.68rem', color: C.muted, ml: 2 }}>
                      {num(r.loans)} loans · {((r.pos / total) * 100).toFixed(1)}% · PAR30 {pct(r.par30_pct)}
                    </Box>
                  </Box>
                )
              })}
            </Box>
          </Box>
        </Panel>
      </Box>

      {/* ── Row: CE trend + PAR profile ────────────────────────────────────── */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '3fr 2fr' }, gap: 2, mb: 2 }}>
        <Panel title="Collection Efficiency Trend" subtitle="Monthly CE % — last 24 months (target 95%)">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={toChart(ceTrend.data, true)} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: C.muted }} interval={2} />
              <YAxis tick={{ fontSize: 10, fill: C.muted }} width={40} domain={[60, 100]} tickFormatter={(v: number) => `${v}%`} />
              <RTooltip formatter={(v: number, n) => [`${v?.toFixed(2)}%`, n]} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={95} stroke={C.green} strokeDasharray="4 4" strokeWidth={1} />
              <Line type="monotone" dataKey="Grand Total" stroke={C.ink} strokeWidth={2.4} dot={false} />
              {(ceTrend.data?.rows ?? []).map((r, i) => (
                <Line key={r.name} type="monotone" dataKey={r.name} stroke={segColor(r.name, i)} strokeWidth={1.4} dot={false} opacity={0.75} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Portfolio at Risk" subtitle="Share of AUM by risk band">
          <Box sx={{ pt: 1 }}>
            {[
              { label: 'PAR 0+', v: a?.par0_pct, amt: a?.par0_pos, color: C.amber },
              { label: 'PAR 30+', v: a?.par30_pct, amt: a?.par30_pos, color: '#EA580C' },
              { label: 'PAR 90+', v: a?.par90_pct, amt: a?.par90_pos, color: C.red },
            ].map((b) => (
              <Box key={b.label} sx={{ mb: 2 }}>
                <Box className="flex items-center justify-between" sx={{ mb: 0.5 }}>
                  <Box sx={{ fontSize: '0.76rem', fontWeight: 600, color: C.ink }}>{b.label}</Box>
                  <Box sx={{ fontSize: '0.82rem', fontWeight: 800, color: b.color }}>{pct(b.v)}</Box>
                </Box>
                <Box sx={{ height: 9, borderRadius: 5, background: C.soft, overflow: 'hidden' }}>
                  <Box sx={{ height: '100%', width: `${Math.min(b.v ?? 0, 100)}%`, background: b.color, borderRadius: 5, transition: 'width .4s' }} />
                </Box>
                <Box sx={{ fontSize: '0.66rem', color: C.muted, mt: 0.3 }}>{inr(b.amt)} at risk</Box>
              </Box>
            ))}
            <Box sx={{ mt: 2.5, pt: 1.5, borderTop: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
              <MiniStat label="Loans in OD" value={num(ageing.data?.loans_in_od)} />
              <MiniStat label="OD Amount" value={inr(ageing.data?.od_amt)} />
            </Box>
          </Box>
        </Panel>
      </Box>

      {/* ── Row: Disbursement trend + OD movement ──────────────────────────── */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '3fr 2fr' }, gap: 2, mb: 2 }}>
        <Panel title="Disbursement Trend" subtitle="Monthly disbursement — last 12 months (₹ Cr)">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={toChart(disbTrend.data, true)} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: C.muted }} />
              <YAxis tick={{ fontSize: 10, fill: C.muted }} width={40} tickFormatter={(v: number) => cr(v)} />
              <RTooltip formatter={(v: number) => [`₹${cr(v)} Cr`, 'Disbursed']} contentStyle={{ fontSize: 11, borderRadius: 8 }} cursor={{ fill: 'rgba(21,101,192,0.06)' }} />
              <Bar dataKey="Grand Total" fill={C.teal} radius={[4, 4, 0, 0]} maxBarSize={34} />
            </BarChart>
          </ResponsiveContainer>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 1, mt: 1 }}>
            <MiniStat label="MTD" value={inr(disb.data?.mtd_amount)} sub={`${num(disb.data?.mtd_count)} loans`} />
            <MiniStat label="Last Month" value={inr(disb.data?.pm_amount)} sub={`${num(disb.data?.pm_count)} loans`} />
            <MiniStat label="YTD (FY)" value={inr(disb.data?.ytd_amount)} sub={`${num(disb.data?.ytd_count)} loans`} />
          </Box>
        </Panel>

        <Panel title="OD Movement (MoM)" subtitle="Borrower flow vs previous month-end">
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.2, mb: 1.5 }}>
            <FlowStat label="Fresh Slippage" value={num(od.data?.slippage)} color={C.red} dir="↑ into OD" />
            <FlowStat label="Regularized" value={num(od.data?.regularized)} color={C.green} dir="↓ out of OD" />
            <FlowStat label="Continuing OD" value={num(od.data?.continuing)} color={C.amber} dir="still overdue" />
            <FlowStat label="Not OD" value={num(od.data?.not_od)} color={C.blue} dir="regular" />
          </Box>
          <Box sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 0.5 }}>Fresh slippage trend (12M)</Box>
          <ResponsiveContainer width="100%" height={90}>
            <BarChart data={toChart(slipTrend.data, true)} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: C.muted }} interval={1} />
              <RTooltip formatter={(v: number) => [num(v), 'Slipped']} contentStyle={{ fontSize: 11, borderRadius: 8 }} cursor={{ fill: 'rgba(220,38,38,0.06)' }} />
              <Bar dataKey="Grand Total" fill={C.red} radius={[3, 3, 0, 0]} maxBarSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </Box>

      {/* ── Segment summary table ──────────────────────────────────────────── */}
      <Panel title="Portfolio by Business Segment" subtitle="Outstanding, book size and risk by segment">
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ '& th, & td': { fontSize: '0.76rem', py: 0.7, whiteSpace: 'nowrap' } }}>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, color: C.muted, borderBottom: `2px solid ${C.border}` } }}>
                <TableCell>Segment</TableCell>
                <TableCell align="right">POS</TableCell>
                <TableCell align="right"># Loans</TableCell>
                <TableCell align="right">Mix %</TableCell>
                <TableCell align="right">PAR 0+</TableCell>
                <TableCell align="right">PAR 30+</TableCell>
                <TableCell align="right">PAR 90+</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {segRows.map((r, i) => {
                const total = segRows.reduce((s, x) => s + x.pos, 0) || 1
                return (
                  <TableRow key={r.name} hover>
                    <TableCell sx={{ fontWeight: 700, color: C.ink }}>
                      <Box className="flex items-center gap-1.5">
                        <Box sx={{ width: 9, height: 9, borderRadius: '2px', background: segColor(r.name, i) }} />{r.name}
                      </Box>
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{inr(r.pos)}</TableCell>
                    <TableCell align="right">{num(r.loans)}</TableCell>
                    <TableCell align="right">{((r.pos / total) * 100).toFixed(1)}%</TableCell>
                    <TableCell align="right"><RiskTag v={r.par0_pct} /></TableCell>
                    <TableCell align="right"><RiskTag v={r.par30_pct} /></TableCell>
                    <TableCell align="right"><RiskTag v={r.par90_pct} /></TableCell>
                  </TableRow>
                )
              })}
              {a && (
                <TableRow sx={{ '& td': { fontWeight: 800, borderTop: `2px solid ${C.border}`, color: C.ink } }}>
                  <TableCell>Grand Total</TableCell>
                  <TableCell align="right">{inr(a.total_pos)}</TableCell>
                  <TableCell align="right">{num(a.total_loans)}</TableCell>
                  <TableCell align="right">100%</TableCell>
                  <TableCell align="right">{pct(a.par0_pct)}</TableCell>
                  <TableCell align="right">{pct(a.par30_pct)}</TableCell>
                  <TableCell align="right">{pct(a.par90_pct)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Panel>
    </Box>
  )
}

// ── Chart data shaper: {label, <series>...} ──────────────────────────────────
function toChart(s: Series | undefined, withGrand = false): Record<string, string | number | null>[] {
  if (!s) return []
  return s.labels.map((label, i) => {
    const pt: Record<string, string | number | null> = { label }
    s.rows.forEach((r) => { pt[r.name] = r.values[i] })
    if (withGrand) pt['Grand Total'] = s.grand[i]
    return pt
  })
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Kpi({ label, value, sub, accent, deltaPct, deltaPp, good }: {
  label: string; value: string; sub: string; accent: string
  deltaPct?: number | null; deltaPp?: number | null; good?: 'up' | 'down'
}) {
  const d = deltaPct ?? deltaPp
  const isPp = deltaPp != null
  let chip = null
  if (d != null && Number.isFinite(d)) {
    const positive = d >= 0
    const beneficial = good ? (good === 'up' ? positive : !positive) : positive
    const color = beneficial ? C.green : C.red
    chip = (
      <Box sx={{ fontSize: '0.62rem', fontWeight: 700, color, display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
        {positive ? '▲' : '▼'} {Math.abs(d).toFixed(isPp ? 2 : 1)}{isPp ? ' pp' : '%'}
      </Box>
    )
  }
  return (
    <Paper elevation={0} sx={{ p: 1.6, borderRadius: 2.5, border: `1px solid ${C.border}`, borderLeft: `3px solid ${accent}`, position: 'relative', overflow: 'hidden' }}>
      <Box sx={{ fontSize: '0.6rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</Box>
      <Box sx={{ fontSize: '1.3rem', fontWeight: 800, color: C.ink, lineHeight: 1.15, mt: 0.4 }}>{value}</Box>
      <Box className="flex items-center justify-between" sx={{ mt: 0.3 }}>
        <Box sx={{ fontSize: '0.64rem', color: C.muted }}>{sub}</Box>
        {chip}
      </Box>
    </Paper>
  )
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Paper elevation={0} sx={{ p: 2, borderRadius: 2.5, border: `1px solid ${C.border}` }}>
      <Box sx={{ mb: 1 }}>
        <Box sx={{ fontSize: '0.86rem', fontWeight: 700, color: C.ink }}>{title}</Box>
        {subtitle && <Box sx={{ fontSize: '0.68rem', color: C.muted, mt: 0.2 }}>{subtitle}</Box>}
      </Box>
      {children}
    </Paper>
  )
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Box sx={{ background: C.soft, borderRadius: 1.5, px: 1.2, py: 0.9 }}>
      <Box sx={{ fontSize: '0.58rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</Box>
      <Box sx={{ fontSize: '0.92rem', fontWeight: 800, color: C.ink }}>{value}</Box>
      {sub && <Box sx={{ fontSize: '0.6rem', color: C.muted }}>{sub}</Box>}
    </Box>
  )
}

function FlowStat({ label, value, color, dir }: { label: string; value: string; color: string; dir: string }) {
  return (
    <Box sx={{ border: `1px solid ${C.border}`, borderRadius: 1.5, px: 1.3, py: 1, borderLeft: `3px solid ${color}` }}>
      <Box sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted }}>{label}</Box>
      <Box sx={{ fontSize: '1.1rem', fontWeight: 800, color: C.ink }}>{value}</Box>
      <Box sx={{ fontSize: '0.58rem', color }}>{dir}</Box>
    </Box>
  )
}

function RiskTag({ v }: { v: number }) {
  const color = v >= 5 ? C.red : v >= 2 ? C.amber : C.green
  return <Box component="span" sx={{ fontWeight: 700, color }}>{pct(v)}</Box>
}
