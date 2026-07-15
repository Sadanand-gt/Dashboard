import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { ReportTable, type Column } from '../components/ReportTable'
import { useSlicerParams } from '../store/filterStore'
import { fmtInr, fmtNum, fmtPct, sumField } from '../lib/format'

type Row = Record<string, unknown>

export function CaseMovement() {
  const params = useSlicerParams()
  const { data: rows = [] } = useQuery<Row[]>({
    queryKey: ['case-movement', params],
    queryFn: () => api.get('/api/case-movement', { params }).then((r) => r.data),
  })

  const disbAmt = sumField(rows, 'disbursed_mtd_amount')
  const disbCount = sumField(rows, 'disbursed_mtd_count')
  const sanctioned = sumField(rows, 'sanctioned_mtd')
  const rejected = sumField(rows, 'rejected_mtd')
  const newClients = sumField(rows, 'new_clients_mtd')
  // Overall CB approval ratio from sums (per-row ratios are decimals 0–1)
  const cbChecked = sumField(rows, 'cb_checked_total')
  const approved = sumField(rows, 'approved_total')
  const approvalPct = cbChecked ? approved / cbChecked * 100 : 0

  const columns: Column[] = [
    { key: 'branch_name', label: 'Branch' },
    { key: 'loan_source', label: 'Type' },
    { key: 'new_clients_mtd', label: 'New Clients', align: 'right', format: (v) => fmtNum(Number(v)) },
    { key: 'booked_mtd', label: 'Booked', align: 'right', format: (v) => fmtNum(Number(v)) },
    { key: 'sanctioned_mtd', label: 'Sanctioned', align: 'right', format: (v) => fmtNum(Number(v)) },
    { key: 'rejected_mtd', label: 'Rejected', align: 'right', format: (v) => fmtNum(Number(v)) },
    { key: 'disbursed_mtd_count', label: 'Disbursed #', align: 'right', format: (v) => fmtNum(Number(v)) },
    { key: 'disbursed_mtd_amount', label: 'Disbursed ₹', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'approval_ratio_total', label: 'Approval %', align: 'right', format: (v) => fmtPct(Number(v) * 100, 1) },
  ]

  return (
    <Box className="space-y-5">
      <Box>
        <Box className="text-lg font-semibold" sx={{ color: '#E8F0FB' }}>Case Movement</Box>
        <Box className="text-xs" sx={{ color: '#7FA8D4' }}>
          Origination funnel (MTD) — applications, sanction/rejection, disbursement & CB approval
        </Box>
      </Box>

      <Box className="flex flex-wrap gap-3">
        <KpiCard label="MTD Disbursed" value={fmtInr(disbAmt)} sub={`${fmtNum(disbCount)} loans`} variant="green" />
        <KpiCard label="New Clients (MTD)" value={fmtNum(newClients)} variant="default" />
        <KpiCard label="Sanctioned (MTD)" value={fmtNum(sanctioned)} variant="default" />
        <KpiCard label="Rejected (MTD)" value={fmtNum(rejected)} variant="amber" />
        <KpiCard label="CB Approval Ratio" value={fmtPct(approvalPct, 1)} sub={`${fmtNum(approved)} / ${fmtNum(cbChecked)}`} variant="default" />
      </Box>

      <ReportTable title="Branch-wise Case Movement (MTD)" columns={columns} rows={rows} />
    </Box>
  )
}
