import { StandardReport } from '../components/StandardReport'

/**
 * Write-Off — same standard layout as Current Outstanding (AP#1 / AP#2, KPI row,
 * chart, sortable group table, monthly trend).
 *
 * No With / Excl W/O portfolio toggle here on purpose: every loan on this report
 * IS written off, so the toggle would either change nothing or empty the page.
 * The Write-off Year picker takes its place — it selects the write-off VINTAGE,
 * which is what makes post-write-off recovery readable (how much of the 2025
 * write-off book has since been recovered).
 */
export function WriteOff() {
  return (
    <StandardReport
      title="Write-Off"
      endpoint="writeoff"
      note="Write-off book and post-write-off recovery · pick a Write-off Year to track recovery by vintage"
      kpis={[
        { field: 'writeoff_amount', label: 'Write-Off Amount', fmt: 'inr', variant: 'red' },
        { field: 'writeoff_count',  label: '# Loans',          fmt: 'num' },
        { field: 'recovery_amount', label: 'Recovery',         fmt: 'inr', variant: 'green' },
        { field: 'net_credit_loss', label: 'Net Credit Loss',  fmt: 'inr', variant: 'red' },
        { field: 'recovery_pct',    label: 'Recovery %',       fmt: 'pct', variant: 'amber' },
      ]}
      chartField="writeoff_amount"
      chartLabel="Write-Off Amount"
      chartFmt="inr"
      columns={[
        { field: 'writeoff_count',    label: '# Loans',          fmt: 'num' },
        { field: 'writeoff_amount',   label: 'Write-Off Amt',    fmt: 'inr' },
        { field: 'sanctioned_amount', label: 'Sanctioned',       fmt: 'inr' },
        { field: 'recovery_amount',   label: 'Recovery',         fmt: 'inr' },
        { field: 'net_credit_loss',   label: 'Net Credit Loss',  fmt: 'inr' },
        { field: 'recovery_pct',      label: 'Recovery %',       fmt: 'pct' },
      ]}
      trend={{
        title: 'Trend — Write-off Recovery',
        measures: [{ key: 'wo_recovery', label: '₹ Recovery', format: 'inr' }],
      }}
    />
  )
}
