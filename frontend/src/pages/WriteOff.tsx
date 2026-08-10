import { StandardReport } from '../components/StandardReport'

/**
 * Write-Off — standard layout (AP#1 / AP#2, KPI row, chart, sortable group
 * table, monthly trend), AP#1 already defaults to Business Segment; the
 * spec now points that dim at the real segment (JLG / IEL / LAP) instead of
 * loan_source (IL / JLG).
 *
 * No With / Excl W/O portfolio toggle here on purpose: every loan on this report
 * IS written off, so the toggle would either change nothing or empty the page.
 * The Write-off Year picker takes its place — it selects the write-off VINTAGE,
 * which is what makes post-write-off recovery readable (how much of the 2025
 * write-off book has since been recovered).
 *
 * Labels state what the column holds. "Write-off less Recovery" is the
 * subtraction it performs; whether that figure is the company's credit loss
 * depends on provisioning treatment this report does not model, so it is not
 * called that here.
 */
export function WriteOff() {
  return (
    <StandardReport
      title="Write-Off"
      endpoint="writeoff"
      note="Write-off book and post-write-off recovery · pick a Write-off Year for recovery by vintage"
      kpis={[
        { field: 'writeoff_amount', label: 'Written Off',        fmt: 'inr', variant: 'red' },
        { field: 'writeoff_count',  label: '# Loans',            fmt: 'num' },
        { field: 'recovery_amount', label: 'Recovered',          fmt: 'inr', variant: 'green' },
        { field: 'net_credit_loss', label: 'Written Off − Recovered', fmt: 'inr', variant: 'red' },
        { field: 'recovery_pct',    label: 'Recovered %',        fmt: 'pct', variant: 'amber' },
      ]}
      chartField="writeoff_amount"
      chartLabel="Written Off"
      chartFmt="inr"
      columns={[
        { field: 'writeoff_count',    label: '# Loans',       fmt: 'num' },
        { field: 'writeoff_amount',   label: 'Written Off',   fmt: 'inr' },
        { field: 'sanctioned_amount', label: 'Sanctioned',    fmt: 'inr' },
        { field: 'recovery_amount',   label: 'Recovered',     fmt: 'inr' },
        { field: 'net_credit_loss',   label: 'Written Off − Recovered', fmt: 'inr' },
        { field: 'recovery_pct',      label: 'Recovered %',   fmt: 'pct' },
      ]}
      trend={{
        title: 'Trend — Write-off Recovery',
        measures: [{ key: 'wo_recovery', label: '₹ Recovered', format: 'inr' }],
      }}
    />
  )
}
