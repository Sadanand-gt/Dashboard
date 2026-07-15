import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { useSlicerParams } from '../store/filterStore'

interface WoKpis {
  total_amount: number
  total_count: number
  recovery_amount: number
  net_loss: number
  recovery_pct: number
}

function fmtInr(v: number) {
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

export function WriteOff() {
  const p = useSlicerParams()

  const { data: kpis, isLoading } = useQuery<WoKpis>({
    queryKey: ['wo-kpis', p],
    queryFn: () => api.get('/api/writeoff/kpis', { params: p }).then((r) => r.data),
  })

  const { data: rows = [] } = useQuery<Record<string, unknown>[]>({
    queryKey: ['wo-rows', p],
    queryFn: () => api.get('/api/writeoff', { params: p }).then((r) => r.data),
  })

  const cols = [
    { key: 'cluster_name', label: 'Cluster' },
    { key: 'region_name', label: 'Region' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'loan_source', label: 'Type' },
    { key: 'writeoff_count', label: '# Loans' },
    { key: 'writeoff_amount', label: 'Write-Off Amt' },
    { key: 'recovery_amount', label: 'Recovery' },
    { key: 'net_credit_loss', label: 'Net Credit Loss' },
  ]

  return (
    <Box className="space-y-5">

      <Box className="flex flex-wrap gap-3">
        <KpiCard label="Total Write-Off" value={kpis ? fmtInr(kpis.total_amount) : '—'} sub={kpis ? `${(kpis.total_count ?? 0).toLocaleString('en-IN')} loans` : ''} variant="purple" loading={isLoading} />
        <KpiCard label="Recovery" value={kpis ? fmtInr(kpis.recovery_amount) : '—'} sub={kpis ? `${kpis.recovery_pct.toFixed(2)}%` : ''} variant="green" loading={isLoading} />
        <KpiCard label="Net Credit Loss" value={kpis ? fmtInr(kpis.net_loss) : '—'} variant="red" loading={isLoading} />
        <KpiCard label="Recovery Rate" value={kpis ? `${kpis.recovery_pct.toFixed(2)}%` : '—'} variant={kpis && kpis.recovery_pct >= 20 ? 'green' : 'amber'} loading={isLoading} />
      </Box>

      <Paper sx={{ overflow: 'auto' }}>
        <Box className="px-4 py-3 font-semibold text-sm border-b" sx={{ borderColor: 'rgba(46,125,204,0.15)' }}>
          Write-Off Portfolio — Branch Detail
        </Box>
        <Table size="small">
          <TableHead>
            <TableRow>
              {cols.map((c) => (
                <TableCell key={c.key} align={['writeoff_count', 'writeoff_amount', 'recovery_amount', 'net_credit_loss'].includes(c.key) ? 'right' : 'left'}>
                  {c.label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.slice(0, 100).map((row, i) => (
              <TableRow key={i} sx={{ '&:hover': { backgroundColor: 'rgba(46,125,204,0.06)' } }}>
                {cols.map((c) => (
                  <TableCell key={c.key} align={['writeoff_count', 'writeoff_amount', 'recovery_amount', 'net_credit_loss'].includes(c.key) ? 'right' : 'left'} sx={{ fontFamily: ['writeoff_amount', 'recovery_amount', 'net_credit_loss'].includes(c.key) ? 'JetBrains Mono, monospace' : 'inherit', fontSize: '0.8rem' }}>
                    {['writeoff_amount', 'recovery_amount', 'net_credit_loss'].includes(c.key)
                      ? fmtInr(Number(row[c.key]))
                      : String(row[c.key] ?? '—')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  )
}
