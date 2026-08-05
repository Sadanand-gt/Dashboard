import { StandardReport } from '../components/StandardReport'

export function PosPar() {
  return (
    <StandardReport
      title="POS & Portfolio at Risk"
      endpoint="pos-par"
      portfolio
      note="PAR bands by outstanding principal · With / Excl write-off toggle"
      variant={{
        label: 'View',
        options: [
          { value: 'LIVE', label: 'Live' },
          { value: 'EOM',  label: 'Month End' },
        ],
      }}
      kpis={[
        { field: 'total_pos',   label: 'Total POS', fmt: 'inr' },
        { field: 'total_loans', label: '# Loans',   fmt: 'num' },
        { field: 'par0_pct',    label: 'PAR 0+',    fmt: 'pct', variant: 'amber' },
        { field: 'par30_pct',   label: 'PAR 30+',   fmt: 'pct', variant: 'red' },
        { field: 'par90_pct',   label: 'PAR 90+',   fmt: 'pct', variant: 'red' },
      ]}
      chartField="total_pos"
      chartLabel="POS"
      chartFmt="inr"
      columns={[
        { field: 'total_pos',   label: 'POS',      fmt: 'inr' },
        { field: 'total_loans', label: '# Loans',  fmt: 'num' },
        { field: 'par0_pos',    label: 'PAR 0+ ₹', fmt: 'inr' },
        { field: 'par0_pct',    label: 'PAR 0+',   fmt: 'pct', risk: true },
        { field: 'par30_pct',   label: 'PAR 30+',  fmt: 'pct', risk: true },
        { field: 'par60_pct',   label: 'PAR 60+',  fmt: 'pct', risk: true },
        { field: 'par90_pct',   label: 'PAR 90+',  fmt: 'pct', risk: true },
      ]}
    />
  )
}
