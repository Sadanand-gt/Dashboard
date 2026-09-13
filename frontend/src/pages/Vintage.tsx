import { useState, useMemo, forwardRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Button from '@mui/material/Button'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import Skeleton from '@mui/material/Skeleton'
import Tooltip from '@mui/material/Tooltip'
import ToggleButton, { type ToggleButtonProps } from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { api } from '../api/client'
import { useSlicerParams, useFilterStore } from '../store/filterStore'
import { ExportCsvButton } from '../components/ExportCsvButton'

const INK = '#0F172A'
const MUTED = '#64748B'
const FAINT = '#94A3B8'
const LINE = '#E2E8F0'

// Cohorts read oldest -> newest, so the palette runs cool -> warm: an eye
// scanning the list sees time passing, and the newest vintage stands out in red
// because it is the one a credit team can still act on.
const COHORT_COLORS = [
  '#0F766E', '#0891B2', '#1565C0', '#4F46E5', '#7C3AED',
  '#A21CAF', '#BE185D', '#DC2626', '#EA580C', '#D97706',
]
const colorFor = (i: number, n: number) =>
  COHORT_COLORS[Math.round((i / Math.max(1, n - 1)) * (COHORT_COLORS.length - 1))]

/** Global slicers this report cannot honour. A vintage follows a cohort forward
 *  from origination, so filtering on a loan's CURRENT delinquency would keep only
 *  the loans sitting in that state today and discard the rest of the cohort —
 *  describing a survivor set, not a vintage. */
const IGNORED_SLICERS: Record<string, string> = {
  od_status: 'OD Status', od_bucket: 'OD Bucket', od_movement: 'OD Movement',
  bucket_movement: 'Bucket Movement', status_code: 'Status Code',
}

const QUARTER_MONTHS = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec']

/* ── Conditional formatting ────────────────────────────────────────────────
 * Excel's own 3-colour scale, applied ROW BY ROW — the way you would select a
 * row in the sheet and hit Colour Scales. A vintage belongs to its origination
 * month, so each cohort is judged against its own range: its lowest reading is
 * green, its highest is red, amber in between. Every row therefore reads as
 * that cohort's own journey — where it stayed clean, and the month it turned.
 *
 * The cost, stated plainly: colour compares months WITHIN a cohort, not one
 * cohort against another. A young row that has only reached 0.03 still runs to
 * red at its own worst month. Reading one cohort against another means reading
 * the numbers down a MOB column, which is what the chart is for.
 *
 * Scaling per row also rescales automatically with the DPD threshold and the
 * basis, so nothing here is pinned to cutoffs that suit only PAR>0.
 */
const SCALE = ['#63BE7B', '#FFEB84', '#F8696B'] as const   // green → amber → red
const rgbOf = (h: string): [number, number, number] =>
  [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgbOf(a), [r2, g2, b2] = rgbOf(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * t)
  return `rgb(${c(r1, r2)},${c(g1, g2)},${c(b1, b2)})`
}
/** Shades v within [lo, hi]. A row whose readings are all identical — a young
 *  cohort still at 0.00 — has no range to shade and stays green. */
function scaleFill(v: number, lo: number, hi: number): string {
  if (!(hi > lo)) return SCALE[0]
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
  return t <= 0.5 ? mix(SCALE[0], SCALE[1], t * 2) : mix(SCALE[1], SCALE[2], (t - 0.5) * 2)
}
const SCALE_CSS = `linear-gradient(90deg, ${SCALE[0]}, ${SCALE[1]}, ${SCALE[2]})`

interface Series {
  cohort: string; loans: number; disbursed: number
  max_mob: number; breached_loans: number; values: number[]
}
interface CurvesResp {
  series: Series[]; threshold: number; grain: string; basis: string
  as_of: string | null; max_mob: number
}

const fmtCr = (v: number) => `₹${(v / 1e7).toFixed(2)} Cr`
const fmtN = (v: number) => (v ?? 0).toLocaleString('en-IN')

/** Spells out an abbreviated cohort, so "Q1'23" is never guessed at — these are
 *  CALENDAR quarters while the house FY runs Apr–Mar. */
function cohortHint(c: string): string {
  const q = /^Q([1-4])'(\d{2})$/.exec(c)
  if (q) return `${QUARTER_MONTHS[Number(q[1]) - 1]} 20${q[2]} · calendar quarter`
  const m = /^([A-Za-z]{3})'(\d{2})$/.exec(c)
  if (m) return `${m[1]} 20${m[2]}`
  return `Calendar year ${c}`
}

export function Vintage() {
  const slicer = useSlicerParams()
  const setPanelOpen = useFilterStore((s) => s.setPanelOpen)
  const [threshold, setThreshold] = useState(30)
  const [grain, setGrain] = useState<'month' | 'quarter' | 'year'>('quarter')
  const [basis, setBasis] = useState<'pos' | 'disb' | 'count'>('pos')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const [showChart, setShowChart] = useState(true)

  const params = { ...slicer, threshold, grain, basis }
  const { data, isLoading, isError } = useQuery<CurvesResp>({
    queryKey: ['vintage', params],
    queryFn: () => api.get('/api/vintage/curves', { params }).then((r) => r.data),
  })

  const series = data?.series ?? []
  const maxMob = data?.max_mob ?? 0

  const activeSlicers = Object.keys(slicer)
  const ignoredActive = activeSlicers.filter((k) => k in IGNORED_SLICERS).map((k) => IGNORED_SLICERS[k])
  const honoured = activeSlicers.length - ignoredActive.length

  // Every cohort is drawn by default; the picker takes them AWAY. Showing only
  // the newest few silently answered a different question than the one asked,
  // and the whole point of a vintage chart is comparing old against new.
  const visible = useMemo(
    () => new Set(series.map((s) => s.cohort).filter((c) => !hidden.has(c))),
    [series, hidden])

  const toggle = (cohort: string) => setHidden((prev) => {
    const next = new Set(prev)
    next.has(cohort) ? next.delete(cohort) : next.add(cohort)
    return next
  })

  const chart = useMemo(() => {
    const rows: Record<string, number | null | string>[] = []
    for (let m = 0; m <= maxMob; m++) {
      const r: Record<string, number | null | string> = { mob: m }
      series.forEach((s) => {
        if (visible.has(s.cohort)) r[s.cohort] = m < s.values.length ? s.values[m] : null
      })
      rows.push(r)
    }
    return rows
  }, [series, maxMob, visible])

  const at = (s: Series, m: number) => (m < s.values.length ? s.values[m] : null)
  const totalDisb = series.reduce((t, s) => t + s.disbursed, 0)
  const totalLoans = series.reduce((t, s) => t + s.loans, 0)

  // Every month on book, exactly as the workbook's sheet lists them. The old
  // 0/3/6/9/12… sample hid the month a cohort actually turned, which is the
  // thing a credit team reads a vintage matrix for.
  const MOB_COLS = useMemo(
    () => Array.from({ length: maxMob + 1 }, (_, m) => m), [maxMob])

  /** One colour domain PER COHORT ROW — its own lowest and highest readings.
   *  The API pads every series to its horizon, so `values` carries no gaps; the
   *  dots in the matrix are ages the cohort has not reached, which are outside
   *  the array and correctly play no part in the row's range. */
  const rowDomain = useMemo(() => {
    const m = new Map<string, [number, number]>()
    series.forEach((s) => {
      const vs = s.values.filter((v): v is number => v != null)
      m.set(s.cohort, vs.length ? [Math.min(...vs), Math.max(...vs)] : [0, 0])
    })
    return m
  }, [series])

  const exportRows = useMemo(() => series.map((s) => {
    const o: Record<string, unknown> = {
      cohort: s.cohort, loans: s.loans, disbursed: s.disbursed, max_mob: s.max_mob,
    }
    MOB_COLS.forEach((m) => { o[`mob_${m}`] = at(s, m) })
    return o
  }), [series, MOB_COLS])
  const exportCols = useMemo<[string, string][]>(
    () => ([['cohort', 'Cohort'], ['loans', '# Loans'], ['disbursed', 'Disbursed'], ['max_mob', 'Max MOB'],
            ...MOB_COLS.map((m) => [`mob_${m}`, `MOB ${m}`] as [string, string])]), [MOB_COLS])

  const idx = useMemo(() => {
    const m = new Map<string, number>()
    series.forEach((s, i) => m.set(s.cohort, i))
    return m
  }, [series])

  const ABOUT = 'A vintage curve follows each cohort forward from disbursement, so vintages are compared at the same AGE rather than on the same date. Once a loan breaches it stays counted, which is why every line only rises and then flattens. Curves stop at the age a cohort has actually reached — a young vintage is never drawn flat to the right edge.'

  // The page is a fixed-height column: chrome on top, the matrix taking whatever
  // is left. That removes the dead band under a short table AND stops the page
  // itself scrolling — `main` is overflow-y-auto, which CSS promotes to
  // overflow-x auto too, and a `position: sticky; top: 0` bar does NOT stick
  // horizontally, so any sideways page scroll used to carry the header away.
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1,
               minHeight: '100%', minWidth: 0, maxWidth: '100%' }}>
      {/* ── Command bar: title and every control on ONE line ──────────────── */}
      {/* nowrap is deliberate. Wrapping split the title off onto a line of its
          own and left a band of dead space beside it. The controls are sized to
          fit; on a genuinely narrow screen the bar scrolls rather than stacks.
          z 1600 outranks both overlays that were covering it: the Recharts
          tooltip (pinned to 5 below) and MUI's Tooltip, whose default is 1500. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'nowrap',
                 overflowX: 'auto', flexShrink: 0,
                 position: 'sticky', top: 0, zIndex: 1600,
                 background: '#FFFFFF', borderRadius: 2, px: 1.75, py: 0.6,
                 border: '1px solid rgba(0,0,0,0.07)',
                 boxShadow: '0 2px 8px -4px rgba(15,23,42,0.28)' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}>
          <Box sx={{ fontSize: '0.9rem', fontWeight: 700, color: '#1E293B', whiteSpace: 'nowrap' }}>
            Vintage Curve
          </Box>
          {/* The explanation lives here rather than as a paragraph on the page. */}
          <Tooltip placement="bottom-start" title={ABOUT}>
            <Box sx={{ width: 15, height: 15, borderRadius: '50%', border: `1px solid ${LINE}`,
                       display: 'flex', alignItems: 'center', justifyContent: 'center',
                       fontSize: '0.6rem', color: FAINT, cursor: 'help', fontWeight: 700,
                       flexShrink: 0 }}>i</Box>
          </Tooltip>
        </Box>
        {/* No divider and no "DPD" caption — the buttons say PAR>0 … PAR>90,
            which names the setting better than a label above it would. The
            controls start straight after the heading. */}
        <Pick value={String(threshold)} onChange={(v) => setThreshold(Number(v))}
          options={[['0', 'PAR>0'], ['30', 'PAR>30'], ['60', 'PAR>60'], ['90', 'PAR>90']]} />
        <Pick label="Cohort" value={grain} onChange={(v) => { setGrain(v as typeof grain); setHidden(new Set()) }}
          options={[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']]} />
        <Pick label="Basis" value={basis} onChange={(v) => setBasis(v as typeof basis)}
          options={[
            ['pos', 'POS',
             'Outstanding principal at the moment the loan first breached, over the amount lent to the cohort. This is the reference workbook’s basis and the one this page reconciles to.'],
            ['disb', 'Amount lent',
             'The amount originally lent to loans that ever breached, over the amount lent to the cohort. The more common published vintage; it reads higher, because the loan does not amortise before it goes bad.'],
            ['count', '#Loans',
             'The share of LOANS that had breached, not of rupees — every loan weighs the same. Read against the money bases: sitting above them means the bad loans are smaller than average, sitting below them means a few large loans are carrying the loss. Ours, not the workbook’s — its numerators are all in rupees.'],
          ]} />

        <Box sx={{ flex: 1, minWidth: 8 }} />

        {honoured > 0 && (
          <Tooltip placement="bottom" title="Global slicers applied here. Click to open the slicer panel.">
            <Box onClick={() => setPanelOpen(true)}
              sx={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 5,
                    px: 1.1, py: 0.2, cursor: 'pointer', fontSize: '0.66rem', flexShrink: 0,
                    fontWeight: 700, color: '#1E40AF', whiteSpace: 'nowrap' }}>
              {honoured} filter{honoured > 1 ? 's' : ''}
            </Box>
          </Tooltip>
        )}
        {ignoredActive.length > 0 && (
          <Tooltip placement="bottom"
            title={`${ignoredActive.join(', ')} ${ignoredActive.length > 1 ? 'are' : 'is'} not applied. A vintage follows a cohort from origination, so filtering on a loan's CURRENT delinquency would keep only the loans sitting in that state today and discard the rest of the cohort — the curve would describe a survivor set, not a vintage.`}>
            <Box sx={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 5,
                       px: 1.1, py: 0.2, cursor: 'default', fontSize: '0.66rem', flexShrink: 0,
                       fontWeight: 700, color: '#B45309', whiteSpace: 'nowrap' }}>
              {ignoredActive.length} n/a
            </Box>
          </Tooltip>
        )}
        <Button size="small" variant="text" onClick={() => setShowChart((v) => !v)}
          sx={{ fontSize: '0.68rem', textTransform: 'none', color: MUTED,
                minWidth: 0, px: 1, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {showChart ? 'Hide chart' : 'Show chart'}
        </Button>
        <ExportCsvButton rows={exportRows} columns={exportCols}
          filename={`vintage_par${threshold}_${grain}_${basis}`} />
        {/* Inline, not a stacked block — the four metric cards that used to sit
            under this bar are gone, and what mattered from them reads better
            beside the matrix title than as its own row of chrome. */}
        <Box sx={{ fontSize: '0.66rem', color: FAINT, whiteSpace: 'nowrap', flexShrink: 0 }}>
          as of <Box component="span" sx={{ fontWeight: 700, color: '#1E293B' }}>{data?.as_of ?? '—'}</Box>
        </Box>
      </Box>

      {/* ── Chart, with the cohort picker beside it ──────────────────────── */}
      {showChart && (
        <Paper sx={{ p: 1.5, flexShrink: 0 }}>
          {isLoading ? <Skeleton variant="rectangular" height={300} /> :
           isError ? <Empty text="Could not load the vintage curves." /> :
           series.length === 0 ? (
             <Empty text="No cohorts match the current filters."
               hint="Clear a slicer, or widen the selection from the slicer panel." />
           ) : (
            /* Fixed height on the ROW, not just the plot. Without it the cohort
               column grows to fit its items — at month grain that is 50+ rows,
               which stretched the section to about a thousand pixels and pushed
               the matrix off screen. */
            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'stretch', height: 300 }}>
              <Box sx={{ flex: 1, minWidth: 0, height: '100%' }}>
                {visible.size === 0 ? (
                  <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Empty text="All cohorts hidden." hint="Pick one from the list on the right, or click “all”." />
                  </Box>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart} margin={{ top: 10, right: 12, left: 0, bottom: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" vertical={false} />
                      <XAxis dataKey="mob" tick={{ fontSize: 10, fill: MUTED }}
                        tickLine={false} axisLine={{ stroke: LINE }}
                        label={{ value: 'Months On Book', position: 'insideBottom', offset: -10,
                                 style: { fontSize: 10, fill: FAINT } }} />
                      <YAxis tick={{ fontSize: 10, fill: MUTED }} width={44}
                        tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
                      {[12, 24, 36].filter((m) => m <= maxMob).map((m) => (
                        <ReferenceLine key={m} x={m} stroke="#CBD5E1" strokeDasharray="2 4" />
                      ))}
                      <RTooltip content={<CurveTooltip idx={idx} total={series.length} focus={focus} />}
                        cursor={{ stroke: '#94A3B8', strokeWidth: 1, strokeDasharray: '3 3' }}
                        /* Clamped to the plot and kept below the sticky bar, so a
                           hovered point cannot ride up over the header. */
                        allowEscapeViewBox={{ x: false, y: false }}
                        wrapperStyle={{ zIndex: 5, outline: 'none' }} />
                      {series.filter((s) => visible.has(s.cohort)).map((s) => {
                        const i = idx.get(s.cohort) ?? 0
                        const dim = focus !== null && focus !== s.cohort
                        return (
                          <Line key={s.cohort} type="monotone" dataKey={s.cohort}
                            stroke={colorFor(i, series.length)}
                            strokeWidth={focus === s.cohort ? 3 : 1.6}
                            strokeOpacity={dim ? 0.15 : 1}
                            dot={false} activeDot={{ r: 3.5, strokeWidth: 0 }}
                            /* A gap means the cohort has not lived that long yet
                               — the line must STOP, not join to a later point. */
                            connectNulls={false} isAnimationActive={false} />
                        )
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </Box>

              {/* Cohort picker as a column BESIDE the plot: adding cohorts never
                  pushes the chart down the page. */}
              <Box sx={{ width: { xs: 104, md: 118, xl: 136 }, flexShrink: 0, height: '100%',
                         display: 'flex', flexDirection: 'column', minHeight: 0,
                         borderLeft: `1px solid ${LINE}`, pl: 1.25 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, mb: 0.5 }}>
                  <Box sx={{ fontSize: '0.56rem', fontWeight: 700, color: MUTED,
                             textTransform: 'uppercase', letterSpacing: '0.07em' }}>Cohorts</Box>
                  <Box sx={{ flex: 1 }} />
                  <Box onClick={() => setHidden(new Set())}
                    sx={{ fontSize: '0.58rem', color: hidden.size ? '#1565C0' : FAINT,
                          cursor: 'pointer' }}>all</Box>
                  <Box onClick={() => setHidden(new Set(series.map((s) => s.cohort)))}
                    sx={{ fontSize: '0.58rem', color: visible.size ? '#1565C0' : FAINT,
                          cursor: 'pointer' }}>none</Box>
                </Box>
                <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
                           display: 'flex', flexDirection: 'column', gap: 0.15 }}>
                  {series.map((s) => {
                    const i = idx.get(s.cohort) ?? 0
                    const on = visible.has(s.cohort)
                    return (
                      <Tooltip key={s.cohort} placement="left"
                        title={`${cohortHint(s.cohort)} · ${fmtN(s.loans)} loans · ${fmtCr(s.disbursed)} · to MOB ${s.max_mob}`}>
                        <Box onClick={() => toggle(s.cohort)}
                          onMouseEnter={() => on && setFocus(s.cohort)}
                          onMouseLeave={() => setFocus(null)}
                          sx={{ display: 'flex', alignItems: 'center', gap: 0.6, cursor: 'pointer',
                                px: 0.6, py: 0.15, borderRadius: 1, userSelect: 'none',
                                background: focus === s.cohort ? '#F1F5F9' : 'transparent',
                                '&:hover': { background: '#F8FAFF' } }}>
                          <Box sx={{ width: 9, height: 3, borderRadius: 2, flexShrink: 0,
                                     background: on ? colorFor(i, series.length) : '#CBD5E1' }} />
                          <Box sx={{ fontSize: '0.66rem', fontWeight: on ? 700 : 400,
                                     color: on ? INK : FAINT, whiteSpace: 'nowrap' }}>{s.cohort}</Box>
                        </Box>
                      </Tooltip>
                    )
                  })}
                </Box>
              </Box>
            </Box>
          )}
        </Paper>
      )}

      {/* ── The matrix — takes every pixel the chrome above did not use ───── */}
      <Paper sx={{ overflow: 'hidden', display: 'flex', flexDirection: 'column',
                   flex: '1 1 240px', minHeight: 240 }}>
        <Box sx={{ px: 2, py: 0.7, borderBottom: `1px solid ${LINE}`, flexShrink: 0,
                   display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Box sx={{ fontSize: '0.8rem', fontWeight: 700, color: INK }}>Cohort × Month On Book</Box>
          {!isLoading && series.length > 0 && (
            <Box sx={{ fontSize: '0.66rem', color: FAINT, whiteSpace: 'nowrap' }}>
              {series.length} {grain}ly cohorts · {fmtN(totalLoans)} loans · {fmtCr(totalDisb)}
              {' · '}
              {/* Spell out what a cell divides, because all three bases print a
                  percentage and nothing else on screen distinguishes them. */}
              <Box component="span" sx={{ color: MUTED, fontWeight: 600 }}>
                {basis === 'count' ? 'loans breached ÷ loans'
                  : basis === 'pos' ? 'outstanding at breach ÷ lent'
                  : 'lent to breachers ÷ lent'}
              </Box>
            </Box>
          )}
          <Box sx={{ flex: 1 }} />
          <Tooltip placement="top" title="Excel's 3-colour scale applied ROW BY ROW. A vintage belongs to its origination month, so every cohort is shaded against its OWN range — its lowest reading green, its highest red — and a row reads left to right as that cohort's journey: where it stayed clean, and the month it turned. Because each row carries its own scale, colour compares months within a cohort and NOT one cohort against another; to compare cohorts, read the numbers down a MOB column or use the chart. A dot means the cohort has not reached that age.">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, cursor: 'help' }}>
              <Box component="span" sx={{ fontSize: '0.6rem', color: FAINT, whiteSpace: 'nowrap' }}>
                each cohort · own best
              </Box>
              <Box sx={{ width: 96, height: 9, borderRadius: 0.5, background: SCALE_CSS,
                         border: '1px solid rgba(0,0,0,0.06)' }} />
              <Box component="span" sx={{ fontSize: '0.6rem', color: FAINT, whiteSpace: 'nowrap' }}>
                worst
              </Box>
            </Box>
          </Tooltip>
        </Box>
        {isLoading ? (
          <Box sx={{ p: 2 }}>{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={24} />)}</Box>
        ) : series.length === 0 ? (
          <Empty text="No cohorts match the current filters." />
        ) : (
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', maxWidth: '100%' }}>
            <Table size="small" stickyHeader sx={{
              '& td, & th': { py: 0.45, px: 1 },
              '& thead th': { top: 0, background: '#EFF6FF' },
            }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, position: 'sticky', left: 0, zIndex: 4,
                                   borderRight: `1px solid ${LINE}` }}>Cohort</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}># Loans</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Disbursed</TableCell>
                  {MOB_COLS.map((m) => (
                    <TableCell key={m} align="right" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {m}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {series.map((s) => {
                  const i = idx.get(s.cohort) ?? 0
                  const [lo, hi] = rowDomain.get(s.cohort) ?? [0, 0]
                  return (
                    <TableRow key={s.cohort} hover
                      onMouseEnter={() => setFocus(s.cohort)} onMouseLeave={() => setFocus(null)}
                      sx={{ background: focus === s.cohort ? '#F8FAFF' : undefined }}>
                      {/* A sticky cell needs an opaque background or the columns
                          scroll through it — but a hardcoded white also swallows
                          the row highlight, so it tracks the focused row. */}
                      <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap',
                                       position: 'sticky', left: 0, zIndex: 1,
                                       background: focus === s.cohort ? '#F1F5FF' : '#FFFFFF',
                                       borderRight: `1px solid ${LINE}` }}>
                        <Tooltip placement="right" title={cohortHint(s.cohort)}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, cursor: 'help' }}>
                            <Box sx={{ width: 9, height: 3, borderRadius: 2, flexShrink: 0,
                                       background: visible.has(s.cohort) ? colorFor(i, series.length) : '#CBD5E1' }} />
                            {s.cohort}
                          </Box>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem' }}>{fmtN(s.loans)}</TableCell>
                      <TableCell align="right" sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem' }}>{fmtCr(s.disbursed)}</TableCell>
                      {MOB_COLS.map((m) => {
                        const v = at(s, m)
                        return (
                          <TableCell key={m} align="right" sx={{
                            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem',
                            color: v == null ? '#E2E8F0' : INK,
                            background: v == null ? undefined : scaleFill(v, lo, hi),
                          }}>{v == null ? '·' : v.toFixed(2)}</TableCell>
                        )
                      })}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Box>
        )}
      </Paper>
    </Box>
  )
}

/** Tooltip for the curve. Recharts' default lists every series in render order —
 *  at month grain that is forty rows in arbitrary sequence. This shows only the
 *  cohorts with a reading at the hovered MOB, worst first. */
function CurveTooltip({ active, payload, label, idx, total, focus }: {
  active?: boolean
  payload?: { name: string; value: number }[]
  label?: number | string
  idx: Map<string, number>; total: number; focus: string | null
}) {
  if (!active || !payload?.length) return null
  let rows = payload.filter((p) => p.value != null)
  if (focus) rows = rows.filter((p) => p.name === focus)
  rows = [...rows].sort((a, b) => b.value - a.value)
  const shown = rows.slice(0, 10)
  return (
    <Box sx={{ background: '#FFFFFF', border: `1px solid ${LINE}`, borderRadius: 1.5,
               boxShadow: '0 6px 20px -8px rgba(15,23,42,0.35)', px: 1.1, py: 0.8, minWidth: 150 }}>
      <Box sx={{ fontSize: '0.64rem', fontWeight: 800, color: INK, mb: 0.5 }}>MOB {label}</Box>
      {shown.map((p) => (
        <Box key={p.name} sx={{ display: 'flex', alignItems: 'center', gap: 0.7, py: 0.1 }}>
          <Box sx={{ width: 8, height: 3, borderRadius: 2, flexShrink: 0,
                     background: colorFor(idx.get(p.name) ?? 0, total) }} />
          <Box sx={{ fontSize: '0.64rem', color: MUTED, flex: 1 }}>{p.name}</Box>
          <Box sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.66rem',
                     fontWeight: 700, color: INK }}>{p.value.toFixed(2)}%</Box>
        </Box>
      ))}
      {rows.length > shown.length && (
        <Box sx={{ fontSize: '0.6rem', color: FAINT, mt: 0.4 }}>+{rows.length - shown.length} more</Box>
      )}
    </Box>
  )
}

function Empty({ text, hint }: { text: string; hint?: string }) {
  return (
    <Box sx={{ py: 5, textAlign: 'center' }}>
      <Box sx={{ fontSize: '0.82rem', color: MUTED, fontWeight: 600 }}>{text}</Box>
      {hint && <Box sx={{ fontSize: '0.7rem', color: FAINT, mt: 0.4 }}>{hint}</Box>}
    </Box>
  )
}

/** A ToggleButton that carries its own tooltip.
 *
 *  Tooltip cannot simply WRAP the button inside a ToggleButtonGroup: the group
 *  clones each child to inject `selected` / `onChange` / `value`, and those
 *  would land on the Tooltip (which forwards unrecognised props to its Popper)
 *  instead of on the button. Taking the props here and passing them down keeps
 *  the group working. Tooltip renders its child directly, adding no DOM node,
 *  so the group's first/last-child border radii still apply. */
const HintButton = forwardRef<HTMLButtonElement, ToggleButtonProps & { hint?: string }>(
  function HintButton({ hint, children, ...rest }, ref) {
    const btn = (
      <ToggleButton ref={ref} {...rest}
        sx={{ px: 0.9, fontSize: '0.65rem', textTransform: 'none', whiteSpace: 'nowrap' }}>
        {children}
      </ToggleButton>
    )
    return hint ? <Tooltip placement="bottom" title={hint}>{btn}</Tooltip> : btn
  })

function Pick({ label, value, options, onChange, hint }: {
  label?: string; value: string
  /** [value, label, per-button hover description] */
  options: [string, string, string?][]
  onChange: (v: string) => void
  hint?: string
}) {
  const group = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
      {label && (
        <Box sx={{ fontSize: '0.56rem', color: MUTED, fontWeight: 700, whiteSpace: 'nowrap',
                   textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</Box>
      )}
      <ToggleButtonGroup size="small" exclusive value={value}
        onChange={(_, v) => v && onChange(v)} sx={{ height: 24 }}>
        {options.map(([v, l, h]) => (
          <HintButton key={v} value={v} hint={h}>{l}</HintButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  )
  return hint ? <Tooltip placement="bottom" title={hint}><span>{group}</span></Tooltip> : group
}
