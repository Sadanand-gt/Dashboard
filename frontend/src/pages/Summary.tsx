import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
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
interface AumKpis { total_pos: number; total_loans: number; par0_pos: number; par0_pct: number; par30_pos: number; par30_pct: number; par60_pos: number; par60_pct: number; par90_pos: number; par90_pct: number; wo_pos?: number }
interface SegRow { name: string; pos: number; loans: number; par0_pct: number; par30_pct: number; par60_pct: number; par90_pct: number }
interface CollKpis { mtd_ce: number; mtd_demand: number; mtd_collection: number
  // PMSD on an MTD card = the cumulative span to the same date last month
  // (held in pmtd_*), the only like-for-like base for an MTD figure. The
  // single-day pmsd_* fields are the T-1 counterpart — different measure.
  pmtd_ce: number; pmtd_demand: number; pmtd_collection: number }
interface DisbKpis { mtd_amount: number; mtd_count: number; ytd_amount: number; ytd_count: number; pm_amount: number; pm_count: number
  pmtd_amount: number; pmtd_count: number
  t1_amount: number; t1_count: number; t1_avg: number }
interface AgeingKpis { total_pos: number; od_amt: number; od_pct: number; loans_in_od: number }
interface OdKpis { slippage: number; continuing: number; regularized: number; not_od: number }
interface FunnelStage {
  applications: number; cb_screened: number
  // CGT (compulsory group training) and GRT (group recognition test) are
  // separate stages and each carries its own count in each period.
  cgt: number; grt: number; pd_done: number
  sanctioned: number; rejected: number
  // MTD only — the share of `rejected` already past PD when turned down.
  rejected_post_pd?: number
  disbursed: number; disbursed_amt: number
}
interface FunnelResp {
  t1: FunnelStage; mtd: FunnelStage
  approval: { approved: number; screened: number; rate: number
              nc_rate: number; ec_rate: number
              nc_approved: number; nc_screened: number
              ec_approved: number; ec_screened: number }
  tat: { jlg?: number | null; il?: number | null }
}
interface DisbSegRow { name: string; ytd_amount: number; ytd_count: number }
interface BreSplit { pulls: number; approved: number; rejected: number; referred: number; approval_pct: number }
interface BreKpis { t1: BreSplit; mtd: BreSplit; t1_date: string | null }
interface DisbBranchRow { name: string; mtd_amount: number; mtd_count: number }
interface CollBranchRow { name: string; mtd_ce: number; mtd_demand: number; mtd_collection: number }
interface WoKpis { total_amount: number; total_count: number; recovery_amount: number; net_loss: number; recovery_pct: number }
interface Series { labels: string[]; rows: { name: string; values: (number | null)[] }[]; grand: (number | null)[] }
interface CbGrand { pulls: number; approval_rate: number; with_overdue_lender: number; overdue_lender_pct: number; avg_outstanding: number; obligation_pct: number }
interface OtsGrand { ots_count: number; ots_amount: number; total_waiver: number; net_amount_collected: number; recovery_pct: number }
interface SummaryResp<T> { rows: unknown[]; grand: T }

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
  // Charts are opt-in and start hidden, matching every other page.
  const [showCharts, setShowCharts] = useState(false)

  const [portfolio, setPortfolio] = useState<Portfolio>('without')  // default Excl. W/O — the active portfolio, consistent across every page
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
  // Origination funnel at T-1 and MTD (rpt_case_movement, branch grain — summed
  // here). This is the only source carrying YESTERDAY's credit decisions; the
  // bureau report itself is monthly (pull_month), so it cannot answer "today".
  // /api/case-movement was RETIRED with the operations router and 404'd, which
  // is why every funnel stage rendered 0. This is the mounted replacement.
  const funnel = useQuery<FunnelResp>({ queryKey: ['exec-funnel'], queryFn: () => api.get('/api/origination/funnel').then((r) => r.data) })
  // BRE decisions — JLG ONLY (IL borrowers are absent from cb_engine). Anchored
  // server-side on T-1, because cb_engine is live and already holds today's
  // partial pulls.
  const bre = useQuery<BreKpis>({ queryKey: ['exec-bre'], queryFn: () => api.get('/api/origination/bre-daily').then((r) => r.data) })
  // Branch league tables. Disbursement answers "who is writing business", CE
  // "who is collecting it", PAR 30+ "who is losing it" — three panels side by
  // side, one story.
  const disbBranch = useQuery<DisbBranchRow[]>({
    queryKey: ['exec-disb-branch'],
    queryFn: () => api.get('/api/disbursement/group-summary', { params: { group_by: 'branch_name' } }).then((r) => r.data),
  })
  const collBranch = useQuery<CollBranchRow[]>({
    queryKey: ['exec-coll-branch', apiP],
    queryFn: () => api.get('/api/collection/group-summary', { params: { ...apiP, group_by: 'branch_name' } }).then((r) => r.data),
  })
  // Avg ticket by product = disbursed / count, which is a real ticket size.
  // POS / live loans is outstanding per loan and is NOT a ticket.
  const disbSeg = useQuery<DisbSegRow[]>({
    queryKey: ['exec-disb-seg'],
    queryFn: () => api.get('/api/disbursement/group-summary', { params: { group_by: 'business_segment' } }).then((r) => r.data),
  })

  const aumTrend = useSeries('pos', 12, portfolio)
  const ceTrend = useSeries('ce_pct', 12, portfolio)
  const disbTrend = useSeries('disb_amount', 12, portfolio)
  const slipTrend = useSeries('slip_count', 12, portfolio)

  // Front of the funnel (bureau sourcing) and back of it (OTS recovery). Neither
  // is portfolio-toggled: a bureau pull predates any loan, and an OTS is its own
  // resolution path.
  const cb = useQuery<SummaryResp<CbGrand>>({
    queryKey: ['exec-cb'],
    queryFn: () => api.get('/api/credit-bureau/summary', { params: { group_by: 'decision' } }).then((r) => r.data),
  })
  const ots = useQuery<SummaryResp<OtsGrand>>({
    queryKey: ['exec-ots'],
    queryFn: () => api.get('/api/ots/summary', { params: { group_by: 'settle_bucket' } }).then((r) => r.data),
  })

  const branches = useQuery<SegRow[]>({
    queryKey: ['aum-branch', aumP],
    queryFn: () => api.get('/api/aum/group-summary', { params: { ...aumP, group_by: 'branch_name' } }).then((r) => r.data),
  })

  const a = aum.data
  const segRows = (seg.data ?? []).filter((r) => r.name !== 'Grand Total')

  // ── Origination funnel, summed from the branch-grain case-movement rows ────
  const fT1 = funnel.data?.t1
  const fMtd = funnel.data?.mtd
  const fAppr = funnel.data?.approval
  const tatJlg = funnel.data?.tat?.jlg
  const tatIl = funnel.data?.tat?.il

  // ── Avg ticket by product (FY disbursed / loans) ──────────────────────────
  const ticket = (name: string) => {
    const r = (disbSeg.data ?? []).find((x) => x.name === name)
    return r && r.ytd_count ? r.ytd_amount / r.ytd_count : undefined
  }

  // ── Like-for-like period comparisons ──────────────────────────────────────
  // MTD is a PART month. Comparing it with a FULL previous month understates
  // every flow: on 2026-08-20 disbursement read MTD 19.55 Cr against July's
  // 32.98 Cr (-40.7%) when the honest comparison, MTD vs PMSD, is -3.5%.
  const disbMtdVsPmtd = disb.data && disb.data.pmtd_amount
    ? ((disb.data.mtd_amount - disb.data.pmtd_amount) / disb.data.pmtd_amount) * 100
    : undefined
  const cePpVsPmtd = collExcl.data && collExcl.data.pmtd_ce != null
    ? collExcl.data.mtd_ce - collExcl.data.pmtd_ce
    : undefined
  const branchRows = (branches.data ?? []).filter((r) => r.name !== 'Grand Total')

  // Every delta on this page compares the latest month with the one before it —
  // name that month rather than showing a bare arrow.
  const labels = aumTrend.data?.labels ?? []
  const basis = labels.length >= 2 ? `vs ${labels[labels.length - 2]}` : undefined

  // The "Branches above 5% PAR 30+" table used to live here. It was removed: the
  // Top 10 Branches — PAR 30+ panel below already names the same branches, and a
  // fixed 5% cutoff is an arbitrary line that reads as a policy threshold when it
  // is not one. Ranking beats thresholding for an executive view.

  const topDisb = (disbBranch.data ?? [])
    .filter((r) => r.name !== 'Grand Total' && r.mtd_amount > 0)
    .sort((x, y) => y.mtd_amount - x.mtd_amount).slice(0, 10)
  // CE ranked only among branches with real demand this month — a branch with a
  // handful of dues can show 100% and would otherwise top the table on noise.
  const CE_MIN_DEMAND = 500000
  const PAR_MIN_POS = 10000000
  const topPar = branchRows
    .filter((r) => r.pos >= PAR_MIN_POS)
    .sort((x, y) => y.par30_pct - x.par30_pct).slice(0, 10)
  const topCe = (collBranch.data ?? [])
    .filter((r) => r.name !== 'Grand Total' && r.mtd_demand >= CE_MIN_DEMAND)
    .sort((x, y) => y.mtd_ce - x.mtd_ce).slice(0, 10)

  const activeBranches = branchRows.length

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
        <Kpi accent={C.blue}   label="Total AUM"        value={inr(a?.total_pos)}   sub={`${num(a?.total_loans)} loans · as of ${asOf.data?.refresh ?? '—'}`} deltaPct={delta(aumTrend.data?.grand)} basis={basis ? `${basis} month-end` : undefined} />
        <Kpi accent={C.green}  label="MTD Coll. Eff."   value={pct(collExcl.data?.mtd_ce)} sub={`${portfolio === 'with' ? 'With' : 'Excl.'} W/O · collection ÷ demand`} deltaPp={cePpVsPmtd} good="up" basis="vs PMSD (same days last month)" />
        <Kpi accent={C.amber}  label="PAR 30+"          value={pct(a?.par30_pct)}   sub={inr(a?.par30_pos)} good="down" />
        <Kpi accent={C.red}    label="PAR 90+"          value={pct(a?.par90_pct)}   sub={inr(a?.par90_pos)} good="down" />
        <Kpi accent={C.teal}   label="MTD Disbursement" value={inr(disb.data?.mtd_amount)} sub={`${num(disb.data?.mtd_count)} loans · PMSD ${inr(disb.data?.pmtd_amount)}`} deltaPct={disbMtdVsPmtd} good="up" basis="vs PMSD (same days last month)" />
        <Kpi accent={C.purple} label="Write-off"        value={inr(wo.data?.total_amount)}
          sub={wo.data ? `${inr(wo.data.recovery_amount)} recovered · ${pct(wo.data.recovery_pct)}` : ''} good="down" />
      </Box>

      {/* ── Quick ratios ───────────────────────────────────────────────────── */}
      <Box sx={{
        display: 'grid', gridTemplateColumns: { xs: 'repeat(2,1fr)', sm: 'repeat(3,1fr)', lg: 'repeat(7,1fr)' },
        gap: 1, mb: 3, background: '#FFFFFF', border: `1px solid ${C.border}`, borderRadius: 2.5, p: 1.25,
      }}>
        <TripleStat label="Avg Ticket Size" sub="FY disbursed / loans"
          items={[['JLG', inr(ticket('JLG'))], ['IEL', inr(ticket('IEL'))], ['LAP', inr(ticket('LAP'))]]} />
        <MiniStat label="PAR 0+" value={pct(a?.par0_pct)} sub={inr(a?.par0_pos)} />
        <MiniStat label="Active Branches" value={num(activeBranches)} sub="with live outstanding" />
        <MiniStat label="OD Slippage" value={num(od.data?.slippage)} sub="regular → OD this month" />
        <MiniStat label="Regularised" value={num(od.data?.regularized)} sub="OD → regular this month" />
        <MiniStat label="MTD Demand" value={inr(collExcl.data?.mtd_demand)} sub={`collected ${inr(collExcl.data?.mtd_collection)}`} />
      </Box>

      {/* ── Origination funnel ─────────────────────────────────────────────
          Reads left to right the way an application actually moves. T-1 is the
          daily pulse; MTD carries the ratio, because the .pbit approval measure
          is defined MTD (approved / CBs checked) and has no T-1 counterpart. */}
      <Panel title="Origination Funnel" subtitle={`Yesterday (${asOf.data?.refresh ?? 'T-1'}) over month to date — each stage counted on its own terms, never divided into one another`}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2,1fr)', md: 'repeat(4,1fr)', lg: 'repeat(8,1fr)' }, gap: 1.25, p: 1.5 }}>
          <FunnelStep label="Applications" t1={num(fT1?.applications)} mtd={num(fMtd?.applications)} color={C.blue} />
          <FunnelStep label="CB Screened" t1={num(fT1?.cb_screened)} mtd={num(fMtd?.cb_screened)} color={C.amber} />
          {/* CGT and GRT are different activities — compulsory group training,
              then the recognition test that follows it. They shared one tile,
              which showed CGT yesterday against GRT month-to-date. */}
          <FunnelStep label="CGT" t1={num(fT1?.cgt)} mtd={num(fMtd?.cgt)} color={C.purple} note="JLG only" />
          <FunnelStep label="GRT" t1={num(fT1?.grt)} mtd={num(fMtd?.grt)} color={C.purple} note="JLG only" />
          <FunnelStep label="PD Done" t1={num(fT1?.pd_done)} mtd={num(fMtd?.pd_done)} color={C.teal} note="JLG only" />
          <FunnelStep label="Sanctioned" t1={num(fT1?.sanctioned)} mtd={num(fMtd?.sanctioned)} color={C.green} />
          {/* The rejection is FINAL and application-level — it is not the BRE
              decision (that tile is below, with its own denominator). The MTD
              sub-line says how far the file had travelled: past PD, or earlier. */}
          <FunnelStep label="Rejected" t1={num(fT1?.rejected)} mtd={num(fMtd?.rejected)} color={C.red}
            note="application closed"
            mtdsub={fMtd && fMtd.rejected_post_pd != null
              ? `${num(fMtd.rejected_post_pd)} past PD · ${num(fMtd.rejected - fMtd.rejected_post_pd)} before`
              : undefined} />
          <FunnelStep label="Disbursed" t1={num(fT1?.disbursed)} mtd={num(fMtd?.disbursed)} color={C.green}
            t1sub={inr(fT1?.disbursed_amt)} mtdsub={inr(fMtd?.disbursed_amt)} />
        </Box>
      </Panel>

      {/* ── Underwriting quality ───────────────────────────────────────────── */}
      <Box sx={{ display: 'grid',
                 gridTemplateColumns: { xs: 'repeat(2,1fr)', md: 'repeat(4,1fr)', lg: 'repeat(7,1fr)' },
                 gap: 1.5, mb: 3, mt: 1.5 }}>
        {/* Two DIFFERENT stages sit in this row and every label says which.
            · BRE = the credit engine's own verdict on a bureau pull. Its
              denominator is decisions made; it is the only same-day credit
              signal, because a file opened yesterday is not sanctioned yet.
            · Approval = sanctioned / CB screened, the .pbit measure. Its
              denominator is applications screened, MTD.
            The two rates are not comparable and must never be netted. */}
        <Kpi accent={C.blue} label="BRE Engine · T-1"
          value={bre.data ? num(bre.data.t1.pulls) : '—'}
          note="JLG only"
          sub={bre.data
            ? `${num(bre.data.t1.approved)} appr · ${num(bre.data.t1.rejected)} rej · ${num(bre.data.t1.referred)} ref`
            : ''} />
        <Kpi accent={C.blue} label="BRE Engine · MTD"
          value={bre.data ? num(bre.data.mtd.pulls) : '—'}
          note="JLG only"
          sub={bre.data
            ? `${pct(bre.data.mtd.approval_pct)} approved of ${num(bre.data.mtd.pulls)} decided`
            : ''} good="up" />
        <Kpi accent={C.teal} label="Sanction Rate · MTD"
          value={fAppr ? pct(fAppr.rate) : '—'}
          sub={fAppr ? `${num(fAppr.approved)} sanctioned / ${num(fAppr.screened)} CB screened` : ''} good="up" />
        <Kpi accent={C.blue} label="Sanction Rate · New Clients"
          value={fAppr ? pct(fAppr.nc_rate) : '—'}
          sub={fAppr ? `${num(fAppr.nc_approved)} of ${num(fAppr.nc_screened)} screened · MTD` : ''} good="up" />
        <Kpi accent={C.green} label="Sanction Rate · Repeat Clients"
          value={fAppr ? pct(fAppr.ec_rate) : '—'}
          sub={fAppr ? `${num(fAppr.ec_approved)} of ${num(fAppr.ec_screened)} screened · MTD` : ''} good="up" />
        <Kpi accent={C.green} label="OTS Cash Recovery"
          value={ots.data ? pct(ots.data.grand.recovery_pct) : '—'}
          sub={ots.data ? `${inr(ots.data.grand.net_amount_collected)} of ${inr(ots.data.grand.ots_amount)} settled` : ''} good="up" />
        <Kpi accent={C.amber} label="TAT · JLG"
          value={tatJlg == null ? '—' : `${tatJlg.toFixed(0)} d`}
          sub={`IL ${tatIl == null ? '—' : `${tatIl.toFixed(0)} d`} · application to disbursement`} good="down" />
      </Box>

      {/* ── Branch performance — written, collected, at risk ─────────────────
          Three parallel league tables: business written, business collected,
          business at risk. Three columns from lg up so they sit side by side on
          an ordinary laptop rather than only on an ultrawide. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2,1fr)', lg: 'repeat(3,1fr)' }, gap: 1.5, mb: 3 }}>
        <Paper elevation={0} sx={{ borderRadius: 2.5, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <Box sx={{ px: 2, py: 1.1, background: 'linear-gradient(90deg,#ECFDF5,#F8FAFC)',
                     borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
            <Box sx={{ fontSize: '0.86rem', fontWeight: 800, color: '#065F46' }}>Top 10 Branches — Disbursement</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#059669' }}>month to date</Box>
          </Box>
          {topDisb.length === 0
            ? <Box sx={{ p: 2, fontSize: '.75rem', color: C.muted }}>No disbursement this month.</Box>
            : <RankList accent={C.green} valueFmt={inr}
                rows={topDisb.map((r) => ({ name: r.name, value: r.mtd_amount, sub: `${num(r.mtd_count)} loans` }))} />}
        </Paper>

        <Paper elevation={0} sx={{ borderRadius: 2.5, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <Box sx={{ px: 2, py: 1.1, background: 'linear-gradient(90deg,#EFF6FF,#F8FAFC)',
                     borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
            <Box sx={{ fontSize: '0.86rem', fontWeight: 800, color: '#1E40AF' }}>Top 10 Branches — Collection Efficiency</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#2563EB' }}>MTD · demand above {inr(CE_MIN_DEMAND)}</Box>
          </Box>
          {topCe.length === 0
            ? <Box sx={{ p: 2, fontSize: '.75rem', color: C.muted }}>No branch meets the demand floor yet.</Box>
            : <RankList accent={C.blue} valueFmt={(v) => v.toFixed(2)} suffix="%"
                rows={topCe.map((r) => ({ name: r.name, value: r.mtd_ce, sub: `${inr(r.mtd_collection)} of ${inr(r.mtd_demand)}` }))} />}
        </Paper>
        <Paper elevation={0} sx={{ borderRadius: 2.5, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <Box sx={{ px: 2, py: 1.1, background: 'linear-gradient(90deg,#FEF2F2,#F8FAFC)',
                     borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
            <Box sx={{ fontSize: '0.86rem', fontWeight: 800, color: '#991B1B' }}>Top 10 Branches — PAR 30+</Box>
            <Box sx={{ fontSize: '0.68rem', color: '#B91C1C' }}>POS above {inr(PAR_MIN_POS)}</Box>
          </Box>
          {topPar.length === 0
            ? <Box sx={{ p: 2, fontSize: '.75rem', color: C.muted }}>No branch above the size floor.</Box>
            : <RankList accent={C.red} valueFmt={(v) => v.toFixed(2)} suffix="%"
                rows={topPar.map((r) => ({ name: r.name, value: r.par30_pct, sub: `${inr(r.pos)} outstanding` }))} />}
        </Paper>
      </Box>

      {/* Charts are opt-in and start hidden, matching every other page. */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
        <Button size="small" variant="outlined" onClick={() => setShowCharts((v) => !v)}
          sx={{ fontSize: '0.68rem', textTransform: 'none', py: 0.2, px: 1.2, whiteSpace: 'nowrap' }}>
          {showCharts ? 'Hide charts' : 'Show charts'}
        </Button>
      </Box>
      {showCharts && (<>
      {/* ── Row: AUM trend + segment mix ───────────────────────────────────── */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '3fr 2fr' }, gap: 2, mb: 2 }}>
        <Panel title="AUM Trend" subtitle="Outstanding by segment — last 12 months (₹ Cr) · current month is MTD, to T-1">
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
                      {num(r.loans)} loans · {((r.pos / total) * 100).toFixed(1)}%
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
        <Panel title="Collection Efficiency Trend" subtitle="Monthly CE % — last 12 months">
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
      </>)}

      {/* ── Segment summary table ──────────────────────────────────────────── */}
      <Panel title="Portfolio by Business Segment" subtitle="Outstanding, book size and risk by segment">
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ '& th, & td': { fontSize: '0.76rem', py: 0.7, whiteSpace: 'nowrap' } }}>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, color: C.muted, borderBottom: `2px solid ${C.border}` } }}>
                <TableCell>Segment</TableCell>
                <TableCell align="right">POS</TableCell>
                <TableCell align="right"># Loans</TableCell>
                <TableCell align="right">PAR 0+</TableCell>
                <TableCell align="right">PAR 30+</TableCell>
                <TableCell align="right">PAR 60+</TableCell>
                <TableCell align="right">PAR 90+</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {segRows.map((r, i) => {
                return (
                  <TableRow key={r.name} hover>
                    <TableCell sx={{ fontWeight: 700, color: C.ink }}>
                      <Box className="flex items-center gap-1.5">
                        <Box sx={{ width: 9, height: 9, borderRadius: '2px', background: segColor(r.name, i) }} />{r.name}
                      </Box>
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{inr(r.pos)}</TableCell>
                    <TableCell align="right">{num(r.loans)}</TableCell>
                    <TableCell align="right"><RiskTag v={r.par0_pct} /></TableCell>
                    <TableCell align="right"><RiskTag v={r.par30_pct} /></TableCell>
                    <TableCell align="right"><RiskTag v={r.par60_pct} /></TableCell>
                    <TableCell align="right"><RiskTag v={r.par90_pct} /></TableCell>
                  </TableRow>
                )
              })}
              {a && (
                <TableRow sx={{ '& td': { fontWeight: 800, borderTop: `2px solid ${C.border}`, color: C.ink } }}>
                  <TableCell>Grand Total</TableCell>
                  <TableCell align="right">{inr(a.total_pos)}</TableCell>
                  <TableCell align="right">{num(a.total_loans)}</TableCell>
                  <TableCell align="right">{pct(a.par0_pct)}</TableCell>
                  <TableCell align="right">{pct(a.par30_pct)}</TableCell>
                  <TableCell align="right">{pct(a.par60_pct)}</TableCell>
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
function Kpi({ label, value, sub, accent, deltaPct, deltaPp, good, basis, note }: {
  label: string; value: string; sub: string; accent: string
  deltaPct?: number | null; deltaPp?: number | null; good?: 'up' | 'down'
  /** What the delta is measured against, e.g. "vs Jul-26". A delta with no
   *  stated basis is not readable — see pmtd-comparison-basis. */
  basis?: string
  /** Scope caveat pinned to the label, e.g. the BRE engine is JLG-only. Shown
   *  on the card itself so the number is never read as firm-wide. */
  note?: string
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
        {basis && <Box component="span" sx={{ color: C.muted, fontWeight: 600 }}>&nbsp;{basis}</Box>}
      </Box>
    )
  }
  return (
    <Paper elevation={0} sx={{ p: 1.6, borderRadius: 2.5, border: `1px solid ${C.border}`, borderLeft: `3px solid ${accent}`, position: 'relative', overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.6, flexWrap: 'wrap' }}>
        <Box sx={{ fontSize: '0.6rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</Box>
        {note && (
          <Box sx={{ fontSize: '0.54rem', fontWeight: 700, color: C.amber, background: '#FFFBEB',
                     border: '1px solid #FDE68A', borderRadius: 1, px: 0.5, lineHeight: 1.5 }}>{note}</Box>
        )}
      </Box>
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

/** One step of the origination funnel: a T-1 pulse over an MTD running total.
 *  Both periods live in the same tile so nobody compares a day with a month by
 *  accident — the mistake that made MTD disbursement look 40% down on a full
 *  previous month. */
function FunnelStep({ label, t1, mtd, color, t1sub, mtdsub, note }: {
  label: string; t1: string; mtd: string; color: string
  t1sub?: string; mtdsub?: string
  /** Scope caveat shown beside the label, e.g. PD and the BRE are JLG-only. */
  note?: string
}) {
  return (
    <Box sx={{
      borderRadius: 2, border: `1px solid ${C.border}`, borderTop: `3px solid ${color}`,
      background: '#FFFFFF', p: 1.25, display: 'flex', flexDirection: 'column', gap: 0.75,
      transition: 'box-shadow .15s, transform .15s',
      '&:hover': { boxShadow: '0 4px 14px -6px rgba(15,23,42,.28)', transform: 'translateY(-1px)' },
    }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, minHeight: 14 }}>
        <Box sx={{ fontSize: '.62rem', fontWeight: 800, letterSpacing: '.07em',
                   textTransform: 'uppercase', color: '#64748B' }}>{label}</Box>
        {note && (
          <Box sx={{ fontSize: '.53rem', fontWeight: 700, color: '#94A3B8',
                     border: '1px solid #E2E8F0', borderRadius: 1, px: 0.4, lineHeight: 1.5 }}>
            {note}
          </Box>
        )}
      </Box>
      <Box>
        <Box sx={{ fontSize: '1.05rem', fontWeight: 800, color: '#0F172A', lineHeight: 1.1 }}>{t1}</Box>
        <Box sx={{ fontSize: '.6rem', color: '#94A3B8', fontWeight: 600 }}>
          yesterday{t1sub ? ` · ${t1sub}` : ''}
        </Box>
      </Box>
      <Box sx={{ borderTop: `1px dashed ${C.border}`, pt: 0.6 }}>
        <Box sx={{ fontSize: '.8rem', fontWeight: 700, color: '#334155', lineHeight: 1.1 }}>{mtd}</Box>
        <Box sx={{ fontSize: '.6rem', color: '#94A3B8', fontWeight: 600 }}>
          month to date{mtdsub ? ` · ${mtdsub}` : ''}
        </Box>
      </Box>
    </Box>
  )
}


/** One tile carrying a measure split across products, instead of one card each.
 *  Three near-identical cards ate a third of the ratio strip and said the same
 *  thing three times. */
function TripleStat({ label, sub, items }: {
  label: string; sub?: string; items: [string, string][]
}) {
  return (
    <Box sx={{ px: 1, py: 0.75, gridColumn: { xs: 'span 2', sm: 'span 2' } }}>
      <Box sx={{ fontSize: '.6rem', fontWeight: 800, letterSpacing: '.07em',
                 textTransform: 'uppercase', color: '#64748B', mb: 0.5 }}>{label}</Box>
      <Box sx={{ display: 'flex', gap: 1.5 }}>
        {items.map(([k, v]) => (
          <Box key={k} sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ fontSize: '.86rem', fontWeight: 800, color: '#0F172A',
                       whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</Box>
            <Box sx={{ fontSize: '.58rem', fontWeight: 700, color: '#94A3B8' }}>{k}</Box>
          </Box>
        ))}
      </Box>
      {sub && <Box sx={{ fontSize: '.55rem', color: '#94A3B8', mt: 0.3 }}>{sub}</Box>}
    </Box>
  )
}


/** Ranked branch list with an inline proportional bar. Reads faster than a table
 *  and costs less vertical space than a chart. */
function RankList({ rows, valueFmt, accent, suffix }: {
  rows: { name: string; value: number; sub?: string }[]
  valueFmt: (v: number) => string
  accent: string
  suffix?: string
}) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <Box sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {rows.map((r, i) => (
        <Box key={r.name} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ width: 16, fontSize: '.62rem', fontWeight: 800, color: '#CBD5E1', textAlign: 'right' }}>
            {i + 1}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
              <Box sx={{ fontSize: '.7rem', fontWeight: 700, color: '#1E293B',
                         whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.name}
              </Box>
              <Box sx={{ fontSize: '.7rem', fontWeight: 800, color: accent, whiteSpace: 'nowrap' }}>
                {valueFmt(r.value)}{suffix ?? ''}
              </Box>
            </Box>
            <Box sx={{ height: 4, borderRadius: 2, background: '#F1F5F9', mt: 0.3, overflow: 'hidden' }}>
              <Box sx={{ height: '100%', width: `${Math.max(2, (r.value / max) * 100)}%`,
                         background: accent, borderRadius: 2, opacity: 0.85 }} />
            </Box>
            {r.sub && <Box sx={{ fontSize: '.55rem', color: '#94A3B8', mt: 0.1 }}>{r.sub}</Box>}
          </Box>
        </Box>
      ))}
    </Box>
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
