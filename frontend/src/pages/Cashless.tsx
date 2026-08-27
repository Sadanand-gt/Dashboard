import { StandardReport } from '../components/StandardReport'

export function Cashless() {
  return (
    <StandardReport
      title="Cashless Collection"
      endpoint="cashless"
      portfolio
      note="Cashless = pay mode 'CL' (digital / bank) · IL only"
      kpis={[
        { field: 'mtd_collection',     label: 'MTD Collection', fmt: 'inr' },
        { field: 'mtd_cashless',       label: 'MTD Cashless',   fmt: 'inr', variant: 'green' },
        { field: 'mtd_cashless_pct',   label: 'MTD Cashless %', fmt: 'pct', variant: 'green' },
        { field: 'daily_collection',   label: 'T-1 Collection', fmt: 'inr' },
        { field: 'daily_cashless_pct', label: 'T-1 Cashless %', fmt: 'pct', variant: 'green' },
      ]}
      chartField="mtd_cashless_pct"
      chartLabel="MTD Cashless %"
      chartFmt="pct"
      columns={[
        { field: 'daily_collection',   label: 'T-1 Collection', fmt: 'inr' },
        { field: 'daily_cashless',     label: 'T-1 Cashless',   fmt: 'inr' },
        { field: 'daily_cashless_pct', label: 'T-1 Cashless %', fmt: 'pct', heat: 'good-high',
          base: { field: 'daily_collection' } },
        { field: 'mtd_collection',     label: 'MTD Collection', fmt: 'inr' },
        { field: 'mtd_cashless',       label: 'MTD Cashless',   fmt: 'inr' },
        { field: 'mtd_cashless_pct',   label: 'MTD Cashless %', fmt: 'pct', heat: 'good-high',
          base: { field: 'mtd_collection' } },
      ]}
    />
  )
}
