import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { ReportTable, type Column } from '../components/ReportTable'
import { useSlicerParams } from '../store/filterStore'
import { fmtInr, fmtNum, fmtPct, sumField } from '../lib/format'

type Row = Record<string, unknown>

export function Delinquencies() {
  const params = useSlicerParams()
  const { data: rows = [] } = useQuery<Row[]>({
    queryKey: ['delinquencies', params],
    queryFn: () => api.get('/api/delinquencies', { params }).then((r) => r.data),
  })

  const totalPos = sumField(rows, 'total_pos')
  const par0Pos = sumField(rows, 'par0_pos')
  const par30Pos = sumField(rows, 'par30_pos')
  const freshSlip = sumField(rows, 'fresh_slippage')
  const odRegularized = sumField(rows, 'od030_regularized')
  const membersNoPay = sumField(rows, 'members_no_pay')

  const columns: Column[] = [
    { key: 'branch_name', label: 'Branch' },
    { key: 'loan_source', label: 'Type' },
    { key: 'total_pos', label: 'POS', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'par0_pos', label: 'PAR 0+', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'par30_pos', label: 'PAR 30+', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'fresh_slippage', label: 'Fresh Slippage', align: 'right', format: (v) => fmtNum(Number(v)) },
    { key: 'od030_regularized', label: 'OD Regularized', align: 'right', format: (v) => fmtNum(Number(v)) },
    { key: 'par30_regularized', label: 'PAR30 Reg.', align: 'right', format: (v) => fmtNum(Number(v)) },
    { key: 'members_no_pay', label: 'No Pay (T-1)', align: 'right', format: (v) => fmtNum(Number(v)) },
  ]

  return (
    <Box className="space-y-5">
      <Box>
        <Box className="text-lg font-semibold" sx={{ color: '#E8F0FB' }}>Delinquencies</Box>
        <Box className="text-xs" sx={{ color: '#7FA8D4' }}>
          PAR tracking, 0–30 OD borrower movement, fresh slippage & PAR&gt;30 recovery
        </Box>
      </Box>

      <Box className="flex flex-wrap gap-3">
        <KpiCard label="PAR 0+" value={fmtPct(totalPos ? par0Pos / totalPos * 100 : 0)} sub={fmtInr(par0Pos)} variant="amber" />
        <KpiCard label="PAR 30+" value={fmtPct(totalPos ? par30Pos / totalPos * 100 : 0)} sub={fmtInr(par30Pos)} variant="red" />
        <KpiCard label="Fresh Slippage" value={fmtNum(freshSlip)} sub="loans newly overdue" variant="red" />
        <KpiCard label="OD Regularized" value={fmtNum(odRegularized)} sub="0–30 OD → standard" variant="green" />
        <KpiCard label="Members No Pay (T-1)" value={fmtNum(membersNoPay)} sub="demand, no collection" variant="default" />
      </Box>

      <ReportTable title="Branch-wise Delinquency Detail" columns={columns} rows={rows} />
    </Box>
  )
}
