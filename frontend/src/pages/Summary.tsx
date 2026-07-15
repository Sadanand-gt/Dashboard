import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import { KpiCard } from '../components/KpiCard'
import { api } from '../api/client'
import type { AumKpis } from '../api/types'

interface DailyKpis {
  daily_ce: number
  cumul_ce: number
  daily_demand: number
  daily_collection: number
}

interface DisbKpis {
  amount: number
  count: number
  mtd_amount: number
  mtd_count: number
}

function fmtInr(v: number): string {
  if (!v && v !== 0) return '—'
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

function fmtPct(v: number): string {
  return `${(v ?? 0).toFixed(2)}%`
}

function fmtNum(v: number | undefined): string {
  return (v ?? 0).toLocaleString('en-IN')
}

// Treat an empty object ({}) from the API as "no data"
function hasData(obj: object | undefined): boolean {
  return !!obj && Object.keys(obj).length > 0
}

export function Summary() {
  const { data: aum, isLoading: aumLoading } = useQuery<AumKpis>({
    queryKey: ['aum-kpis', {}],
    queryFn: () => api.get('/api/aum/kpis').then((r) => r.data),
  })

  const { data: daily, isLoading: dailyLoading } = useQuery<DailyKpis>({
    queryKey: ['daily-kpis'],
    queryFn: () => api.get('/api/collection/daily/kpis').then((r) => r.data),
  })

  const { data: disb, isLoading: disbLoading } = useQuery<DisbKpis>({
    queryKey: ['disb-kpis'],
    queryFn: () => api.get('/api/disbursement/kpis').then((r) => r.data),
  })

  return (
    <Box className="space-y-6">
      <Box>
        <Box className="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">
          Portfolio Health
        </Box>
        <Box className="flex flex-wrap gap-3">
          <KpiCard label="Total AUM" value={hasData(aum) ? fmtInr(aum!.total_pos) : '—'} sub={hasData(aum) ? `${fmtNum(aum!.total_loans)} loans` : ''} variant="default" loading={aumLoading} />
          <KpiCard label="PAR 0+" value={hasData(aum) ? fmtPct(aum!.par0_pct) : '—'} sub={hasData(aum) ? fmtInr(aum!.par0_pos) : ''} variant="amber" loading={aumLoading} />
          <KpiCard label="PAR 30+" value={hasData(aum) ? fmtPct(aum!.par30_pct) : '—'} sub={hasData(aum) ? fmtInr(aum!.par30_pos) : ''} variant="red" loading={aumLoading} />
          <KpiCard label="PAR 90+" value={hasData(aum) ? fmtPct(aum!.par90_pct) : '—'} sub={hasData(aum) ? fmtInr(aum!.par90_pos) : ''} variant="red" loading={aumLoading} />
        </Box>
      </Box>

      <Box>
        <Box className="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">
          Collection (Today)
        </Box>
        <Box className="flex flex-wrap gap-3">
          <KpiCard label="Daily CE%" value={hasData(daily) ? fmtPct(daily!.daily_ce) : '—'} variant="green" loading={dailyLoading} />
          <KpiCard label="MTD CE%" value={hasData(daily) ? fmtPct(daily!.cumul_ce) : '—'} variant="green" loading={dailyLoading} />
          <KpiCard label="Daily Demand" value={hasData(daily) ? fmtInr(daily!.daily_demand) : '—'} variant="default" loading={dailyLoading} />
          <KpiCard label="Daily Collection" value={hasData(daily) ? fmtInr(daily!.daily_collection) : '—'} variant="green" loading={dailyLoading} />
        </Box>
      </Box>

      <Box>
        <Box className="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">
          Disbursement
        </Box>
        <Box className="flex flex-wrap gap-3">
          <KpiCard label="Last Month" value={hasData(disb) ? fmtInr(disb!.amount) : '—'} sub={hasData(disb) ? `${fmtNum(disb!.count)} loans` : ''} variant="default" loading={disbLoading} />
          <KpiCard label="MTD Disbursement" value={hasData(disb) ? fmtInr(disb!.mtd_amount) : '—'} sub={hasData(disb) ? `${fmtNum(disb!.mtd_count)} loans` : ''} variant="green" loading={disbLoading} />
        </Box>
      </Box>
    </Box>
  )
}
