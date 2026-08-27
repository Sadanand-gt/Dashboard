import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Skeleton from '@mui/material/Skeleton'
import Tooltip from '@mui/material/Tooltip'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'

import { api } from '../api/client'
import { useSlicerParams } from '../store/filterStore'
import { ExportCsvButton } from '../components/ExportCsvButton'
import { heatBand, heatStyle, median } from '../components/heat'

/**
 * PAR 60 Collection — recovery from the deep-arrears book, month by month.
 *
 * SOURCE IS THE TREND ENGINE, and that is the whole point of this page.
 *
 * An earlier build derived the cohort itself from `eom_dpd > 60` on
 * rpt_collection_loans. It read Rs 0.029 Cr for August against the trend's
 * Rs 0.067 Cr, and the trend is the one that is right: checked against
 * "August, 2026 Dashboards" -> "Trend - PAR60 Collection", `par60_collection`
 * matches EXACTLY in 8 of 12 months (Sep-25 .. Apr-26), with a mean absolute
 * difference of 0.78% across the year. The remaining months are May +1.24%,
 * Jun +0.28%, Jul +1.22% and the in-progress August at -6.55%.
 *
 * The two disagreed because they derive DPD differently — the trend walks a
 * day-level ledger, collection_fact compares instalment-level cumulative due
 * against cash. Rather than reimplement the trend's rule (an attempt produced
 * 18,055 loans, 20% of the book at PAR>60, which is plainly wrong), this page
 * simply reads the measure that reconciles.
 *
 * PINNED TO EXCL W/O, deliberately. `_apply_portfolio` adds the entire
 * written-off POS to par60_pos in the "with" view while par60_collection has no
 * write-off companion, so Recovery % would collapse toward zero and mean
 * nothing. The Excel reconciliation is on the excl-W/O values too.
 */

const INK = '#0F172A'
const MUTED = '#64748B'
const FAINT = '#94A3B8'
const LINE = '#E2E8F0'

const DIMS: [string, string][] = [
  ['business_segment', 'Business Segment'], ['zone_name', 'Zone'],
  ['cluster_name', 'Cluster'], ['region_name', 'Region'],
  ['area_name', 'Unit'], ['branch_name', 'Branch'], ['lo_id', 'Loan Officer'],
  ['prod_classification', 'Prod. Classification'], ['cycle_no', 'Cycle'],
  ['disb_year', 'Disbursement Year'],
]

// Three readings of the same book: the cash that came back, the stock it came
// back from, and the rate between them. Kept as one toggle rather than three
// tables — they share every axis.
const MEASURES = {
  par60_collection: {
    label: 'Collection ₹', fmt: 'inr' as const, dir: 'good-high' as const,
    hint: 'Rupees collected in the month from loans that were PAR>60 at the PREVIOUS month-end. This is the measure reconciled to the August workbook — 8 of 12 months exact, 0.78% mean absolute difference.',
  },
  par60_pos: {
    label: 'Stock ₹', fmt: 'inr' as const, dir: 'bad-high' as const,
    hint: 'Outstanding principal sitting at PAR>60 at each month-end. The book the collection is being recovered FROM — rising stock with flat collection is the shape to watch for.',
  },
  par60_recovery_pct: {
    label: 'Recovery %', fmt: 'pct' as const, dir: 'good-high' as const,
    hint: 'Collection ÷ the PAR>60 stock it came from. Excl W/O only: in the With W/O view the entire written-off book is added to the stock while the collection stays live-book, which would drive this toward zero for no real reason.',
  },
  par1_60_collection: {
    label: '1–60 Collection ₹', fmt: 'inr' as const, dir: 'good-high' as const,
    hint: 'Collected from loans in the 1–60 bucket at the previous month-end. Beside PAR>60 it shows whether recovery is coming from early arrears or deep ones — the two behave very differently and are worth separating.',
  },
}
type MeasureKey = keyof typeof MEASURES

const WINDOWS: [number | 0, string][] = [[12, '12M'], [24, '24M'], [36, '36M'], [0, 'All']]

interface Series {
  months: string[]; labels: string[]
  rows: { name: string; name2?: string; values: (number | null)[] }[]
  grand: (number | null)[]
  partial_last?: boolean; live_label?: string | null
  unsupported?: string[]
}

const fmtCr = (n: number | null) => (n == null ? '—' : `₹${(n / 1e7).toFixed(2)} Cr`)
const fmtL = (n: number | null) => (n == null ? '—' : `₹${(n / 1e5).toFixed(2)} L`)
const fmtPct = (n: number | null) => (n == null ? '—' : `${n.toFixed(2)}%`)

export function Par60Collection() {
  const slicer = useSlicerParams()
  const [ap1, setAp1] = useState('business_segment')
  const [ap2, setAp2] = useState('none')
  const [measure, setMeasure] = useState<MeasureKey>('par60_collection')
  const [win, setWin] = useState<number>(12)

  // portfolio is NOT a control here — see the note above the component.
  const base = useMemo(() => ({
    ...slicer, portfolio: 'excl', pin: 'false',
    ...(win ? { window: String(win) } : {}),
  }), [slicer, win])

  const params = useMemo(() => ({
    ...base, measure, group_by: ap1, ...(ap2 !== 'none' ? { group_by_2: ap2 } : {}),
  }), [base, measure, ap1, ap2])

  const { data, isLoading } = useQuery<Series>({
    queryKey: ['par60-trend', params],
    queryFn: () => api.get('/api/trend/series', { params }).then((r) => r.data),
  })
  // Headline strip reads the grand totals of the other measures at the same
  // scope, so the cards and the table can never describe different books.
  // Written out rather than looped through a helper: a hook called from inside
  // a local function is one conditional away from changing call order between
  // renders, which React cannot recover from.
  const kpiFor = (m: MeasureKey) => () =>
    api.get('/api/trend/series', {
      params: { ...base, measure: m, group_by: 'business_segment' },
    }).then((r) => r.data)
  const collQ = useQuery<Series>({ queryKey: ['par60-kpi', 'par60_collection', base],
                                   queryFn: kpiFor('par60_collection') })
  const posQ = useQuery<Series>({ queryKey: ['par60-kpi', 'par60_pos', base],
                                  queryFn: kpiFor('par60_pos') })
  const recQ = useQuery<Series>({ queryKey: ['par60-kpi', 'par60_recovery_pct', base],
                                  queryFn: kpiFor('par60_recovery_pct') })
  const earlyQ = useQuery<Series>({ queryKey: ['par60-kpi', 'par1_60_collection', base],
                                    queryFn: kpiFor('par1_60_collection') })

  const months = data?.months ?? []
  const labels = data?.labels ?? []
  const rows = data?.rows ?? []
  const grand = data?.grand ?? []
  const M = MEASURES[measure]
  const hasAp2 = ap2 !== 'none'
  const ap1Label = DIMS.find((d) => d[0] === ap1)?.[1] ?? 'Group'
  const ap2Label = DIMS.find((d) => d[0] === ap2)?.[1] ?? ''

  const last = <T,>(a: (T | null)[] | undefined) =>
    (a && a.length ? a[a.length - 1] : null)
  const prev = <T,>(a: (T | null)[] | undefined) =>
    (a && a.length > 1 ? a[a.length - 2] : null)

  const fmt = (v: number | null) =>
    M.fmt === 'pct' ? fmtPct(v) : (Math.abs(v ?? 0) >= 1e7 ? fmtCr(v) : fmtL(v))

  /** Shaded DOWN each month column: a month is judged against the other groups
   *  in that same month, never against a different month. Comparing across
   *  columns would just re-draw seasonality. */
  const benchByMonth = useMemo(() => {
    const m = new Map<number, number | null>()
    months.forEach((_, i) => {
      m.set(i, median(rows.map((r) => r.values[i]).filter((v): v is number => v != null)))
    })
    return m
  }, [rows, months])

  const exportRows = useMemo(() => rows.map((r) => {
    const o: Record<string, unknown> = { name: r.name, ...(hasAp2 ? { name2: r.name2 } : {}) }
    labels.forEach((l, i) => { o[l] = r.values[i] })
    return o
  }), [rows, labels, hasAp2])
  const exportCols = useMemo<[string, string][]>(() => ([
    ['name', ap1Label], ...(hasAp2 ? [['name2', ap2Label] as [string, string]] : []),
    ...labels.map((l) => [l, l] as [string, string]),
  ]), [ap1Label, ap2Label, hasAp2, labels])

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1,
               minHeight: '100%', minWidth: 0, maxWidth: '100%' }}>
      {/* ── Command bar ──────────────────────────────────────────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'nowrap',
                 overflowX: 'auto', flexShrink: 0,
                 position: 'sticky', top: 0, zIndex: 1600,
                 background: '#FFFFFF', borderRadius: 2, px: 1.75, py: 0.6,
                 border: '1px solid rgba(0,0,0,0.07)',
                 boxShadow: '0 2px 8px -4px rgba(15,23,42,0.28)' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}>
          <Box sx={{ fontSize: '0.9rem', fontWeight: 700, color: '#1E293B', whiteSpace: 'nowrap' }}>
            PAR 60 Collection
          </Box>
          <Tooltip placement="bottom-start" title="Recovery from loans that were more than 60 days past due at the PREVIOUS month-end, month by month. Read from the trend engine, which reconciles to “August, 2026 Dashboards” → “Trend - PAR60 Collection”: 8 of 12 months match exactly, 0.78% mean absolute difference. Excl write-off throughout — see the chip.">
            <Box sx={{ width: 15, height: 15, borderRadius: '50%', border: `1px solid ${LINE}`,
                       display: 'flex', alignItems: 'center', justifyContent: 'center',
                       fontSize: '0.6rem', color: FAINT, cursor: 'help', fontWeight: 700,
                       flexShrink: 0 }}>i</Box>
          </Tooltip>
        </Box>

        <Sel label="AP #1" value={ap1} onChange={setAp1} width={150} options={DIMS} />
        <Sel label="AP #2" value={ap2} onChange={setAp2} width={150}
          options={[['none', '— None —'] as [string, string],
                    ...DIMS.filter((d) => d[0] !== ap1)]} />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
          <ToggleButtonGroup size="small" exclusive value={measure} sx={{ height: 24 }}
            onChange={(_, v) => v && setMeasure(v)}>
            {(Object.keys(MEASURES) as MeasureKey[]).map((k) => (
              <Tooltip key={k} placement="bottom" title={MEASURES[k].hint}>
                <ToggleButton value={k} sx={{ px: 0.9, fontSize: '0.65rem', textTransform: 'none' }}>
                  {MEASURES[k].label}
                </ToggleButton>
              </Tooltip>
            ))}
          </ToggleButtonGroup>
        </Box>

        <ToggleButtonGroup size="small" exclusive value={win} sx={{ height: 24, flexShrink: 0 }}
          onChange={(_, v) => v != null && setWin(v)}>
          {WINDOWS.map(([v, l]) => (
            <ToggleButton key={l} value={v} sx={{ px: 0.9, fontSize: '0.65rem', textTransform: 'none' }}>
              {l}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Box sx={{ flex: 1, minWidth: 8 }} />

        {/* Not a toggle. Recovery % is only defined excl W/O, so the page says
            what it is showing instead of offering a view that would mislead. */}
        <Tooltip placement="bottom" title="Written-off loans are excluded throughout. This is not a toggle: in the With W/O view the whole written-off book is added to the PAR>60 stock while the collection stays live-book, so Recovery % would collapse for no real reason. The workbook reconciliation is on these same excl-W/O figures.">
          <Box sx={{ background: '#F1F5F9', border: `1px solid ${LINE}`, borderRadius: 5,
                     px: 1.1, py: 0.2, fontSize: '0.63rem', fontWeight: 700,
                     color: MUTED, whiteSpace: 'nowrap', cursor: 'help', flexShrink: 0 }}>
            Excl. W/O
          </Box>
        </Tooltip>
        <ExportCsvButton rows={exportRows} columns={exportCols}
          filename={`par60_${measure}_${ap1}`} label="Export CSV" />
      </Box>

      {/* ── Headline strip: latest month, all four measures ──────────────── */}
      <Paper elevation={0} sx={{ display: 'flex', flexWrap: 'wrap', flexShrink: 0,
                                 border: '1px solid rgba(0,0,0,0.07)', borderRadius: 2 }}>
        <K label="PAR>60 Collection" value={fmtCr(last(collQ.data?.grand))}
           prev={fmtCr(prev(collQ.data?.grand))} loading={collQ.isLoading} accent="#16A34A" />
        <K label="PAR>60 Stock" value={fmtCr(last(posQ.data?.grand))}
           prev={fmtCr(prev(posQ.data?.grand))} loading={posQ.isLoading} accent="#DC2626" />
        <K label="Recovery %" value={fmtPct(last(recQ.data?.grand))}
           prev={fmtPct(prev(recQ.data?.grand))} loading={recQ.isLoading} />
        <K label="1–60 Collection" value={fmtCr(last(earlyQ.data?.grand))}
           prev={fmtCr(prev(earlyQ.data?.grand))} loading={earlyQ.isLoading} accent="#1565C0" last
           hint="Collected from the 1-60 bucket. Beside the PAR>60 figure it shows where recovery is actually coming from." />
      </Paper>

      {/* ── Month matrix ─────────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ borderColor: LINE, overflow: 'hidden',
                                      display: 'flex', flexDirection: 'column',
                                      flex: '1 1 240px', minHeight: 240 }}>
        <Box sx={{ px: 1.5, py: 0.7, borderBottom: `1px solid ${LINE}`, flexShrink: 0,
                   display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Box sx={{ fontSize: '0.8rem', fontWeight: 700, color: INK }}>
            {M.label} — {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
          </Box>
          {data?.partial_last && data.live_label && (
            <Tooltip placement="top" title={`${data.live_label} is the month in progress — it holds only the days elapsed so far, so it is not comparable with the completed months beside it.`}>
              <Box sx={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 5,
                         px: 1, py: 0.15, fontSize: '0.62rem', fontWeight: 700,
                         color: '#B45309', cursor: 'help' }}>
                {data.live_label} partial
              </Box>
            </Tooltip>
          )}
          {/* rpt_trend_full has no column for some slicers. The API returns
              them rather than filtering silently, so the page must say so —
              otherwise the user sees an unfiltered trend believing it is cut. */}
          {!!data?.unsupported?.length && (
            <Tooltip placement="top" title={`${data.unsupported.join(', ')} ${data.unsupported.length > 1 ? 'are' : 'is'} not applied — the monthly trend table carries no such column, so the figures below are NOT cut by ${data.unsupported.length > 1 ? 'those slicers' : 'that slicer'}.`}>
              <Box sx={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 5,
                         px: 1, py: 0.15, fontSize: '0.62rem', fontWeight: 700,
                         color: '#B45309', cursor: 'help', whiteSpace: 'nowrap' }}>
                {data.unsupported.length} slicer{data.unsupported.length > 1 ? 's' : ''} n/a
              </Box>
            </Tooltip>
          )}
          <Box sx={{ flex: 1 }} />
          <Tooltip placement="top" title="Shaded DOWN each month column — every group is judged against the other groups in that same month, never against a different month. Shading across a row would only redraw seasonality.">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'help' }}>
              <Box component="span" sx={{ fontSize: '0.6rem', color: FAINT }}>vs same-month median</Box>
              {[0, 1, 2, 3, 4].map((b) => (
                <Box key={b} sx={{ width: 16, height: 9, borderRadius: 0.5,
                                   background: b === 2 ? '#F1F5F9' : heatStyle(b, true).background }} />
              ))}
            </Box>
          </Tooltip>
        </Box>

        {isLoading ? (
          <Box sx={{ p: 2 }}>{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={24} />)}</Box>
        ) : rows.length === 0 ? (
          <Box sx={{ py: 5, textAlign: 'center', color: MUTED, fontSize: '0.85rem' }}>
            Nothing at PAR&gt;60 for this selection.
          </Box>
        ) : (
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', maxWidth: '100%' }}>
            <Table size="small" stickyHeader sx={{
              '& td, & th': { py: 0.45, px: 1 },
              '& thead th': { top: 0, background: '#EFF6FF' },
            }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, position: 'sticky', left: 0, zIndex: 4,
                                   borderRight: `1px solid ${LINE}` }}>{ap1Label}</TableCell>
                  {hasAp2 && <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{ap2Label}</TableCell>}
                  {labels.map((l) => (
                    <TableCell key={l} align="right" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{l}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={`${r.name}-${r.name2 ?? ''}-${i}`} hover>
                    <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap', fontSize: '0.75rem',
                                     position: 'sticky', left: 0, zIndex: 1, background: '#FFFFFF',
                                     borderRight: `1px solid ${LINE}` }}>{r.name}</TableCell>
                    {hasAp2 && (
                      <TableCell sx={{ fontSize: '0.75rem', color: '#475569', whiteSpace: 'nowrap' }}>
                        {r.name2 ?? '—'}
                      </TableCell>
                    )}
                    {r.values.map((v, j) => (
                      <TableCell key={j} align="right" sx={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem',
                        whiteSpace: 'nowrap',
                        color: v == null ? '#E2E8F0' : undefined,
                        ...(v == null ? {} : heatStyle(heatBand(v, benchByMonth.get(j), M.dir), true)),
                      }}>{v == null ? '·' : fmt(v)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
              <TableBody>
                <TableRow sx={{ position: 'sticky', bottom: 0, zIndex: 2 }}>
                  <TableCell sx={{ fontWeight: 800, fontSize: '0.75rem', position: 'sticky',
                                   left: 0, zIndex: 3, background: '#F1F5F9',
                                   borderTop: `2px solid ${LINE}`,
                                   borderRight: `1px solid ${LINE}` }}>Grand Total</TableCell>
                  {hasAp2 && <TableCell sx={{ background: '#F1F5F9', borderTop: `2px solid ${LINE}` }} />}
                  {grand.map((v, j) => (
                    <TableCell key={j} align="right" sx={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem',
                      fontWeight: 800, whiteSpace: 'nowrap', color: INK,
                      background: '#F1F5F9', borderTop: `2px solid ${LINE}` }}>
                      {v == null ? '·' : fmt(v)}
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Box>
  )
}

function K({ label, value, prev, accent, hint, loading, last }: {
  label: string; value: string; prev: string
  accent?: string; hint?: string; loading?: boolean; last?: boolean
}) {
  const body = (
    <Box sx={{ flex: 1, minWidth: 150, px: 1.75, py: 0.75,
               borderRight: last ? 'none' : `1px solid ${LINE}`,
               cursor: hint ? 'help' : 'default' }}>
      <Box sx={{ fontSize: '0.55rem', fontWeight: 700, color: MUTED,
                 textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</Box>
      <Box sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.05rem',
                 fontWeight: 700, color: accent ?? INK, lineHeight: 1.3 }}>
        {loading ? '—' : value}
      </Box>
      {/* Prior month, stated rather than turned into a delta: one month of a
          deep-arrears series moves for reasons a percentage will not explain. */}
      <Box sx={{ fontSize: '0.62rem', color: FAINT, whiteSpace: 'nowrap' }}>
        {loading ? '' : `prev month ${prev}`}
      </Box>
    </Box>
  )
  return hint ? <Tooltip placement="bottom" title={hint}>{body}</Tooltip> : body
}

function Sel({ label, value, onChange, options, width = 140 }: {
  label: string; value: string; onChange: (v: string) => void
  options: [string, string][]; width?: number
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
      <Box sx={{ fontSize: '0.56rem', color: MUTED, fontWeight: 700, whiteSpace: 'nowrap',
                 textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</Box>
      <FormControl size="small">
        <Select value={value} onChange={(e) => onChange(e.target.value)}
          sx={{ fontSize: '0.7rem', height: 24, minWidth: width }}>
          {options.map(([v, l]) => (
            <MenuItem key={v} value={v} sx={{ fontSize: '0.72rem' }}>{l}</MenuItem>
          ))}
        </Select>
      </FormControl>
    </Box>
  )
}
