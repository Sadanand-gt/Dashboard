import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { useSlicerParams } from '../store/filterStore'

function fmtInr(v: number) {
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

export function PosPar() {
  const [reportType, setReportType] = useState('EOM')
  const slicer = useSlicerParams()

  const p = { ...slicer, report_type: reportType }

  const { data: rows = [], isLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ['pos-par', p],
    queryFn: () => api.get('/api/pos-par', { params: p }).then((r) => r.data),
  })

  const totalPos = rows.reduce((s, r) => s + Number(r.total_pos ?? 0), 0)
  const totalPar0 = rows.reduce((s, r) => s + Number(r.par0_pos ?? 0), 0)
  const totalPar30 = rows.reduce((s, r) => s + Number(r.par30_pos ?? 0), 0)
  const totalPar90 = rows.reduce((s, r) => s + Number(r.par90_pos ?? 0), 0)

  const cols: { key: string; label: string }[] = [
    { key: 'cluster_name', label: 'Cluster' },
    { key: 'region_name', label: 'Region' },
    { key: 'area_name', label: 'Area' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'loan_source', label: 'Type' },
    { key: 'loan_count', label: '# Loans' },
    { key: 'total_pos', label: 'POS' },
    { key: 'par0_pos', label: 'PAR 0+' },
    { key: 'par30_pos', label: 'PAR 30+' },
    { key: 'par90_pos', label: 'PAR 90+' },
  ]

  return (
    <Box className="space-y-5">
      <Box className="flex items-center gap-4 flex-wrap">
        <ToggleButtonGroup
          value={reportType}
          exclusive
          onChange={(_, v) => v && setReportType(v)}
          size="small"
          sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.5, fontSize: '0.75rem', fontWeight: 600, color: '#7FA8D4', borderColor: 'rgba(46,125,204,0.3)', '&.Mui-selected': { color: '#E8F0FB', backgroundColor: 'rgba(46,125,204,0.3)', borderColor: '#2E7DCC' } } }}
        >
          <ToggleButton value="EOM">EOM</ToggleButton>
          <ToggleButton value="LIVE">Current</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box className="flex flex-wrap gap-3">
        <KpiCard label="Total POS" value={fmtInr(totalPos)} loading={isLoading} />
        <KpiCard label="PAR 0+" value={fmtInr(totalPar0)} sub={totalPos ? `${(totalPar0 / totalPos * 100).toFixed(2)}%` : ''} variant="amber" loading={isLoading} />
        <KpiCard label="PAR 30+" value={fmtInr(totalPar30)} sub={totalPos ? `${(totalPar30 / totalPos * 100).toFixed(2)}%` : ''} variant="red" loading={isLoading} />
        <KpiCard label="PAR 90+" value={fmtInr(totalPar90)} sub={totalPos ? `${(totalPar90 / totalPos * 100).toFixed(2)}%` : ''} variant="red" loading={isLoading} />
      </Box>

      <Paper sx={{ overflow: 'auto' }}>
        <Box className="px-4 py-3 font-semibold text-sm border-b" sx={{ borderColor: 'rgba(46,125,204,0.15)' }}>
          POS & PAR Detail — {reportType === 'EOM' ? 'End of Month' : 'Current'}
        </Box>
        <Box sx={{ maxHeight: 480, overflow: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {cols.map((c) => (
                  <TableCell key={c.key} align={['loan_count', 'total_pos', 'par0_pos', 'par30_pos', 'par90_pos'].includes(c.key) ? 'right' : 'left'}>
                    {c.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.slice(0, 100).map((row, i) => (
                <TableRow key={i} sx={{ '&:hover': { backgroundColor: 'rgba(46,125,204,0.06)' } }}>
                  {cols.map((c) => (
                    <TableCell key={c.key} align={['loan_count', 'total_pos', 'par0_pos', 'par30_pos', 'par90_pos'].includes(c.key) ? 'right' : 'left'} sx={{ fontFamily: ['total_pos', 'par0_pos', 'par30_pos', 'par90_pos'].includes(c.key) ? 'JetBrains Mono, monospace' : 'inherit', fontSize: '0.8rem' }}>
                      {['total_pos', 'par0_pos', 'par30_pos', 'par90_pos'].includes(c.key)
                        ? fmtInr(Number(row[c.key]))
                        : String(row[c.key] ?? '—')}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
        {rows.length > 100 && (
          <Box className="px-4 py-2 text-xs text-text-muted text-right">
            Showing 100 of {rows.length} rows
          </Box>
        )}
      </Paper>
    </Box>
  )
}
