import { StandardReport } from '../components/StandardReport'

export function AumLive() {
  return (
    <StandardReport
      title="AUM — DPD Detail"
      endpoint="aum-live"
      portfolio
      note="Live days-past-due read straight from core banking · With / Excl write-off toggle"
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
        { field: 'total_pos',   label: 'POS',     fmt: 'inr' },
        { field: 'total_loans', label: '# Loans', fmt: 'num' },
        { field: 'par0_pct',    label: 'PAR 0+',  fmt: 'pct', risk: true },
        { field: 'par30_pct',   label: 'PAR 30+', fmt: 'pct', risk: true },
        { field: 'par60_pct',   label: 'PAR 60+', fmt: 'pct', risk: true },
        { field: 'par90_pct',   label: 'PAR 90+', fmt: 'pct', risk: true },
        { field: 'death_cases', label: 'Death',   fmt: 'num' },
      ]}
    />
  )
}
