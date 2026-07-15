import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { ReportTable, type Column } from '../components/ReportTable'
import { useSlicerParams } from '../store/filterStore'
import { fmtInr, fmtPct, sumField } from '../lib/format'

type Row = Record<string, unknown>

export function Cashless() {
  const params = useSlicerParams()
  const { data: rows = [] } = useQuery<Row[]>({
    queryKey: ['cashless', params],
    queryFn: () => api.get('/api/cashless', { params }).then((r) => r.data),
  })

  const mtdCashless = sumField(rows, 'mtd_cashless')
  const mtdCollection = sumField(rows, 'mtd_collection')
  const dailyCashless = sumField(rows, 'daily_cashless')
  const dailyCollection = sumField(rows, 'daily_collection')

  const columns: Column[] = [
    { key: 'branch_name', label: 'Branch' },
    { key: 'loan_source', label: 'Type' },
    { key: 'daily_cashless', label: 'Daily Cashless', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'mtd_cashless', label: 'MTD Cashless', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'mtd_collection', label: 'MTD Collection', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'mtd_cashless_pct', label: 'MTD Cashless %', align: 'right', format: (v) => fmtPct(Number(v), 1) },
  ]

  return (
    <Box className="space-y-5">
      <Box>
        <Box className="text-lg font-semibold" sx={{ color: '#E8F0FB' }}>Cashless Collection</Box>
        <Box className="text-xs" sx={{ color: '#7FA8D4' }}>
          Digital (cashless) collection share — daily &amp; month-to-date
        </Box>
      </Box>

      <Box className="flex flex-wrap gap-3">
        <KpiCard label="MTD Cashless %" value={fmtPct(mtdCollection ? mtdCashless / mtdCollection * 100 : 0, 1)} sub={fmtInr(mtdCashless)} variant="green" />
        <KpiCard label="MTD Collection" value={fmtInr(mtdCollection)} variant="default" />
        <KpiCard label="Daily Cashless %" value={fmtPct(dailyCollection ? dailyCashless / dailyCollection * 100 : 0, 1)} sub={fmtInr(dailyCashless)} variant="green" />
        <KpiCard label="Daily Collection" value={fmtInr(dailyCollection)} variant="default" />
      </Box>

      <ReportTable title="Branch-wise Cashless Collection" columns={columns} rows={rows} />
    </Box>
  )
}
