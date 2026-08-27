import Box from '@mui/material/Box'
import { StandardReport } from '../components/StandardReport'

export function Delinquencies() {
  return (
    <Box>
      <StandardReport
        title="Delinquencies"
        endpoint="delinquencies"
        portfolio
        note="PAR tracking, 0-30 OD borrower movement and fresh slippage vs previous month-end"
        trend={{ title: 'Trend — PAR>60 Collection', measures: [{ key: 'par60_collection', label: '₹ Collected from PAR>60', format: 'inr' }] }}
        kpis={[
          { field: 'total_pos',      label: 'Total POS',      fmt: 'inr' },
          { field: 'par30_pct',      label: 'PAR 30+',        fmt: 'pct', variant: 'red' },
          { field: 'fresh_slippage', label: 'Fresh Slippage', fmt: 'num', variant: 'red' },
          { field: 'od030_regularized', label: 'Regularized (0-30)', fmt: 'num', variant: 'green' },
          { field: 'members_no_pay', label: 'No Pay (T-1)',   fmt: 'num', variant: 'amber' },
        ]}
        chartField="fresh_slippage"
        chartLabel="Fresh Slippage"
        chartFmt="num"
        columns={[
          { field: 'total_pos',          label: 'POS',            fmt: 'inr' },
          { field: 'total_loans',        label: '# Loans',        fmt: 'num' },
          { field: 'par0_pct',           label: 'PAR 0+',         fmt: 'pct', risk: true,
            base: { field: 'total_pos' } },
          { field: 'par30_pct',          label: 'PAR 30+',        fmt: 'pct', risk: true,
            base: { field: 'total_pos' } },
          { field: 'fresh_slippage',     label: 'Fresh Slippage', fmt: 'num', heat: 'bad-high' },
          { field: 'od030_prev_count',   label: '0-30 Prev',      fmt: 'num' },
          { field: 'od030_regularized',  label: 'Regularized',    fmt: 'num', heat: 'good-high' },
          { field: 'od030_not_paid',     label: 'Not Paid',       fmt: 'num', heat: 'bad-high' },
          { field: 'members_no_pay',     label: 'No Pay',         fmt: 'num', heat: 'bad-high' },
        ]}
      />
    </Box>
  )
}
