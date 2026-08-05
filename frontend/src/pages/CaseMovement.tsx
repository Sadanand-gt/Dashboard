import { StandardReport } from '../components/StandardReport'

export function CaseMovement() {
  return (
    <StandardReport
      title="Case Movement"
      endpoint="case-movement"
      note="Origination funnel — applications, sanctions and disbursements (T-1 & MTD)"
      kpis={[
        { field: 'booked_mtd',            label: 'Booked MTD',      fmt: 'num' },
        { field: 'sanctioned_mtd',        label: 'Sanctioned MTD',  fmt: 'num', variant: 'green' },
        { field: 'rejected_mtd',          label: 'Rejected MTD',    fmt: 'num', variant: 'red' },
        { field: 'disbursed_mtd_amount',  label: 'Disbursed MTD',   fmt: 'inr', variant: 'green' },
        { field: 'approval_ratio_total',  label: 'Approval Ratio',  fmt: 'pct' },
      ]}
      chartField="disbursed_mtd_amount"
      chartLabel="MTD Disbursed"
      chartFmt="inr"
      columns={[
        { field: 'new_clients_mtd',       label: 'New Clients',   fmt: 'num' },
        { field: 'booked_mtd',            label: 'Booked',        fmt: 'num' },
        { field: 'sanctioned_mtd',        label: 'Sanctioned',    fmt: 'num' },
        { field: 'rejected_mtd',          label: 'Rejected',      fmt: 'num' },
        { field: 'disbursed_mtd_count',   label: 'Disbursed #',   fmt: 'num' },
        { field: 'disbursed_mtd_amount',  label: 'Disbursed ₹',   fmt: 'inr' },
        { field: 'approval_ratio_total',  label: 'Approval %',    fmt: 'pct' },
      ]}
    />
  )
}
