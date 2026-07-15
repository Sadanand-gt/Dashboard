import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { api } from '../api/client'
import { KpiCard } from '../components/KpiCard'
import { ReportTable, type Column } from '../components/ReportTable'
import { useSlicerParams } from '../store/filterStore'
import { fmtInr, fmtNum, fmtPct, sumField } from '../lib/format'

type Row = Record<string, unknown>

const DPD_BUCKETS = [
  { key: 'standard', label: 'Regular', color: '#1DB87A' },
  { key: 'dpd_1_30', label: '1-30', color: '#F0A500' },
  { key: 'dpd_31_60', label: '31-60', color: '#F59E0B' },
  { key: 'dpd_61_90', label: '61-90', color: '#E84545' },
  { key: 'dpd_91_180', label: '91-180', color: '#C2300E' },
  { key: 'dpd_181_360', label: '181-360', color: '#8B0000' },
  { key: 'dpd_360p', label: '360+', color: '#6B21A8' },
]

export function AumLive() {
  const params = useSlicerParams()
  const { data: rows = [] } = useQuery<Row[]>({
    queryKey: ['aum-live', params],
    queryFn: () => api.get('/api/aum-live', { params }).then((r) => r.data),
  })

  const totalPos = sumField(rows, 'total_pos')
  const par0 = sumField(rows, 'par0_pos')
  const par30 = sumField(rows, 'par30_pos')
  const par90 = sumField(rows, 'par90_pos')

  const bucketChart = DPD_BUCKETS.map((b) => ({
    bucket: b.label,
    pos: +(sumField(rows, `${b.key}_pos`) / 1e7).toFixed(2),
    color: b.color,
  }))

  const columns: Column[] = [
    { key: 'branch_name', label: 'Branch' },
    { key: 'loan_source', label: 'Type' },
    { key: 'total_loans', label: '# Loans', align: 'right', format: (v) => fmtNum(Number(v)) },
    { key: 'total_pos', label: 'POS', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'par0_pos', label: 'PAR 0+', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'par30_pos', label: 'PAR 30+', align: 'right', format: (v) => fmtInr(Number(v)) },
    { key: 'par90_pos', label: 'PAR 90+', align: 'right', format: (v) => fmtInr(Number(v)) },
  ]

  return (
    <Box className="space-y-5">
      <Box>
        <Box className="text-lg font-semibold" sx={{ color: '#E8F0FB' }}>AUM — DPD Detail</Box>
        <Box className="text-xs" sx={{ color: '#7FA8D4' }}>
          Portfolio by DPD bucket (7 buckets) using core-banking DPD — as of today
        </Box>
      </Box>

      <Box className="flex flex-wrap gap-3">
        <KpiCard label="Total POS" value={fmtInr(totalPos)} sub={`${fmtNum(sumField(rows, 'total_loans'))} loans`} variant="default" />
        <KpiCard label="PAR 0+" value={fmtPct(totalPos ? par0 / totalPos * 100 : 0)} sub={fmtInr(par0)} variant="amber" />
        <KpiCard label="PAR 30+" value={fmtPct(totalPos ? par30 / totalPos * 100 : 0)} sub={fmtInr(par30)} variant="red" />
        <KpiCard label="PAR 90+" value={fmtPct(totalPos ? par90 / totalPos * 100 : 0)} sub={fmtInr(par90)} variant="red" />
      </Box>

      <Paper>
        <Box className="px-4 py-3 font-semibold text-sm border-b" sx={{ borderColor: 'rgba(46,125,204,0.15)' }}>
          POS by DPD Bucket (₹ Cr)
        </Box>
        <Box sx={{ height: 320, p: 2 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bucketChart} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(46,125,204,0.1)" vertical={false} />
              <XAxis dataKey="bucket" tick={{ fill: '#7FA8D4', fontSize: 11 }} axisLine={{ stroke: 'rgba(46,125,204,0.2)' }} tickLine={false} />
              <YAxis tick={{ fill: '#7FA8D4', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} />
              <Tooltip contentStyle={{ background: '#1e3a5f', border: '1px solid rgba(46,125,204,0.3)', borderRadius: 8, fontSize: 12 }} formatter={(v: number) => [`₹${v} Cr`]} />
              <Bar dataKey="pos" barSize={32}>
                {bucketChart.map((b, i) => <Cell key={i} fill={b.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Box>
      </Paper>

      <ReportTable title="Branch-wise AUM (DPD Detail)" columns={columns} rows={rows} />
    </Box>
  )
}
