import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Button from '@mui/material/Button'
import Table from '@mui/material/Table'
import TableHead from '@mui/material/TableHead'
import TableBody from '@mui/material/TableBody'
import TableRow from '@mui/material/TableRow'
import TableCell from '@mui/material/TableCell'
import TableSortLabel from '@mui/material/TableSortLabel'
import Skeleton from '@mui/material/Skeleton'
import Tooltip from '@mui/material/Tooltip'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'

import { api } from '../api/client'
import { useSlicerParams } from '../store/filterStore'
import { ExportCsvButton } from '../components/ExportCsvButton'
import { TrendSection } from '../components/TrendSection'
import { usePagedRows, Paginator } from '../components/TableControls'
import { heatBand, heatStyle, spineColor, makeBenchFor, type Heat } from '../components/heat'

const INK = '#0F172A'
const MUTED = '#64748B'
const FAINT = '#94A3B8'
const LINE = '#E2E8F0'
const REC = '#16A34A'     // recovered

const fmtCr = (n: number) =>
  `₹${((n || 0) / 1e7).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Cr`
const fmtN = (n: number) => Math.round(n || 0).toLocaleString('en-IN')
const fmtPct = (n: number) => `${(n ?? 0).toFixed(2)}%`

// Loan-wise export. Headers are the source column names spelled out — a file
// that leaves the dashboard has to be readable without it.
const LOAN_EXPORT_COLS: [string, string][] = [
  ['loan_id', 'Loan ID'],
  ['loan_source', 'Loan Source'],
  ['business_segment', 'Business Segment'],
  ['product_id', 'Product'],
  ['wo_source', 'Write-off Source'],
  ['writeoff_date', 'Write-off Date'],
  ['writeoff_month', 'Write-off Month'],
  ['writeoff_fy', 'Write-off FY'],
  ['cluster_name', 'Cluster'],
  ['region_name', 'Region'],
  ['area_name', 'Unit'],
  ['branch_name', 'Branch'],
  ['branch_id', 'Branch ID'],
  ['lo_id', 'Loan Officer ID'],
  ['disbursement_date', 'Disbursement Date'],
  ['writeoff_amount', 'Write-off Amount'],
  ['recovery_amount', 'Recovered After Write-off'],
  ['recovery_mtd', 'Collected This Month'],
  ['last_recovery_date', 'Last Recovery Date'],
]

type Row = Record<string, any>
type Col = {
  field: string
  label: string
  fmt: (n: number) => string
  /** Direction that makes shading mean something. Omitted = never shaded. */
  heat?: Heat
  /** The value's own denominator, so 0/0 is left unjudged rather than painted worst. */
  base?: string
  /** The one column that takes a fill; the rest take colour and weight only. */
  primary?: boolean
  color?: string
  bold?: boolean
  hint?: string
}

// Every column is a fact about the written-off book. "Sanctioned amount" was
// dropped 2026-08-12: it is the loan's ORIGINAL sanction, not a write-off
// figure, and sitting beside the write-off amount it read as though the two
// were comparable. Avg ticket, avg vintage, accounts-recovered % and net credit
// loss were removed the same day and are deliberately NOT reinstated here.
const COLS: Col[] = [
  { field: 'writeoff_count', label: '# Loans', fmt: fmtN, heat: 'bad-high' },
  { field: 'writeoff_amount', label: 'Write-off Amount', fmt: fmtCr, bold: true, heat: 'bad-high' },
  // Share of the written-off book. Concentration is the question a grouped
  // write-off table is actually asked — one branch at 30% is a different
  // problem from thirty branches at 1%.
  { field: 'share_pct', label: 'Share of W/O', fmt: fmtPct,
    hint: 'This group’s write-off amount as a share of the whole selection. Reads concentration: one branch carrying 30% is a different problem from thirty carrying 1% each.' },
  { field: 'recovery_amount', label: 'Recovered', fmt: fmtCr, color: REC, heat: 'good-high' },
  // Was only on a card before, so it could not be compared across groups —
  // which is the entire point of a monthly recovery figure.
  { field: 'recovery_mtd', label: 'Recovered MTD', fmt: fmtCr, color: REC, heat: 'good-high',
    hint: 'Collected against written-off loans since the 1st of this month.' },
  { field: 'recovery_pct', label: 'Recovery %', fmt: fmtPct, bold: true,
    heat: 'good-high', base: 'writeoff_amount', primary: true,
    hint: 'Recovered ÷ write-off amount, for this group’s own written-off book.' },
]
const HEAT_FIELDS = COLS.filter((c) => c.heat).map((c) => c.field)

const ABOUT = 'The written-off book and what has since been recovered against it. Source is rpt_writeoff_loans at loan grain — the table on screen is that data grouped, the CSV is the same data unaggregated, so the two cannot disagree. There is no With / Excl W/O toggle because every loan here IS written off; the FY and Month pickers select the write-off VINTAGE instead, which is what makes recovery readable.'

/**
 * Write-Off — the written-off book and what has since been recovered.
 *
 * SOURCE: rpt_writeoff_loans, one row per written-off loan. The table on screen
 * is that data grouped; the CSV is that data unaggregated. They cannot disagree.
 */
export function WriteOff() {
  const slicer = useSlicerParams()
  const [ap1, setAp1] = useState('business_segment')
  const [ap2, setAp2] = useState('none')
  const [fy, setFy] = useState('ALL')       // all years by default
  const [month, setMonth] = useState('ALL')
  // Loan ID lookup is hidden for now — the control was removed from the header,
  // but the param plumbing below stays so restoring it is a one-line change.
  const [loanId] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const [sortBy, setSortBy] = useState('writeoff_amount')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')

  const params = {
    ...slicer,
    group_by: ap1,
    ...(ap2 !== 'none' ? { group_by_2: ap2 } : {}),
    ...(fy !== 'ALL' ? { fy } : {}),
    ...(month !== 'ALL' ? { month } : {}),
    ...(loanId ? { loan_id: loanId } : {}),
  }

  const { data, isLoading } = useQuery({
    queryKey: ['writeoff-analysis', params],
    queryFn: () => api.get('/api/writeoff/analysis', { params }).then((r) => r.data),
  })

  const rawRows: Row[] = data?.rows ?? []
  const grand: Row = data?.grand ?? {}
  const dims: { value: string; label: string }[] = data?.dims ?? []
  const fyOptions: string[] = data?.fy_options ?? []
  const monthOptions: string[] = data?.month_options ?? []

  // Changing year invalidates a month picked from the previous one.
  useEffect(() => {
    if (month !== 'ALL' && monthOptions.length && !monthOptions.includes(month)) {
      setMonth('ALL')
    }
  }, [month, monthOptions])

  useEffect(() => { setPage(0) }, [ap1, ap2, fy, month, loanId])

  const ap1Label = dims.find((d) => d.value === ap1)?.label ?? 'Group'
  const ap2Label = dims.find((d) => d.value === ap2)?.label ?? ''
  const hasAp2 = ap2 !== 'none' && !!ap2Label

  // Share of the selection's write-off book. Derived on the client because it is
  // a presentation ratio against the CURRENT selection's total — computing it
  // server-side would fix the denominator to something the user cannot see.
  const rows = useMemo<Row[]>(() => {
    const total = Number(grand.writeoff_amount ?? 0)
    return rawRows.map((r): Row => ({
      ...r,
      share_pct: total ? Number(r.writeoff_amount ?? 0) / total * 100 : 0,
    }))
  }, [rawRows, grand])

  const sorted = useMemo(() => {
    const out = [...rows]
    out.sort((a, b) => {
      const av = sortBy === 'name' ? String(a.name) : Number(a[sortBy] ?? 0)
      const bv = sortBy === 'name' ? String(b.name) : Number(b[sortBy] ?? 0)
      const c = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
      return dir === 'asc' ? c : -c
    })
    return out
  }, [rows, sortBy, dir])

  // Shaded against the row's own segment when grouped two deep, else against the
  // Grand Total — the same rule every other report page uses.
  const benchFor = useMemo(
    () => makeBenchFor(sorted, { ...grand, share_pct: 0 }, HEAT_FIELDS, hasAp2),
    [sorted, grand, hasAp2])

  const bandOf = (r: Row, c: Col) =>
    c.heat ? heatBand(r[c.field], benchFor(r as any, c.field), c.heat,
                      c.base ? Number(r[c.base] ?? 0) : undefined) : null

  const onSort = (field: string) => {
    if (sortBy === field) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortBy(field); setDir(field === 'name' ? 'asc' : 'desc') }
  }

  // Loan rows are fetched on click, not held in the page — see ExportCsvButton.
  const fetchLoans = async () => {
    const { fy: _f, month: _m, ...rest } = params as any
    const r = await api.get('/api/writeoff/loans', {
      params: { ...rest, ...(fy !== 'ALL' ? { fy } : {}), ...(month !== 'ALL' ? { month } : {}) },
    })
    return r.data.rows as Row[]
  }

  // No wording when nothing is narrowed — an empty period needs no label.
  const periodLabel = [fy === 'ALL' ? '' : fy, month === 'ALL' ? '' : month]
    .filter(Boolean).join(' · ') || 'all years'

  const paged = usePagedRows(sorted, pageSize, page)
  const colCount = 1 + (hasAp2 ? 1 : 0) + COLS.length

  // Fixed-height column: chrome on top, the table taking whatever is left. Keeps
  // the page from scrolling sideways, which is what carries a `top: 0` sticky
  // header out of view (`main` is overflow-y-auto, and CSS promotes that to
  // overflow-x auto too).
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1,
               minHeight: '100%', minWidth: 0, maxWidth: '100%' }}>
      {/* ── Command bar: title and every control on ONE line ──────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'nowrap',
                 overflowX: 'auto', flexShrink: 0,
                 position: 'sticky', top: 0, zIndex: 1600,
                 background: '#FFFFFF', borderRadius: 2, px: 1.75, py: 0.6,
                 border: '1px solid rgba(0,0,0,0.07)',
                 boxShadow: '0 2px 8px -4px rgba(15,23,42,0.28)' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, flexShrink: 0 }}>
          <Box sx={{ fontSize: '0.9rem', fontWeight: 700, color: '#1E293B', whiteSpace: 'nowrap' }}>
            Write-Off
          </Box>
          <Tooltip placement="bottom-start" title={ABOUT}>
            <Box sx={{ width: 15, height: 15, borderRadius: '50%', border: `1px solid ${LINE}`,
                       display: 'flex', alignItems: 'center', justifyContent: 'center',
                       fontSize: '0.6rem', color: FAINT, cursor: 'help', fontWeight: 700,
                       flexShrink: 0 }}>i</Box>
          </Tooltip>
        </Box>

        <Sel label="AP #1" value={ap1} onChange={setAp1} width={144}
          options={dims.map((d) => [d.value, d.label])} />
        <Sel label="AP #2" value={ap2} onChange={setAp2} width={144}
          options={[['none', '— None —'] as [string, string],
                    ...dims.filter((d) => d.value !== ap1).map((d) => [d.value, d.label] as [string, string])]} />
        {/* "Write-off FY / Month" would repeat the page title on every control,
            so the period selects are just FY and Month here. */}
        <Sel label="FY" value={fy} onChange={setFy} width={104}
          options={[['ALL', 'All years'] as [string, string],
                    ...fyOptions.map((y) => [y, y] as [string, string])]} />
        <Sel label="Month" value={month} onChange={setMonth} width={104}
          options={[['ALL', 'All months'] as [string, string],
                    ...monthOptions.map((m) => [m, m] as [string, string])]} />

        <Box sx={{ flex: 1, minWidth: 8 }} />

        <ExportCsvButton rows={[]} columns={LOAN_EXPORT_COLS} fetchRows={fetchLoans}
          filename="write_off_loans" label="Export CSV" />
        <Box sx={{ fontSize: '0.66rem', color: FAINT, whiteSpace: 'nowrap', flexShrink: 0 }}>
          as of <Box component="span" sx={{ fontWeight: 700, color: '#1E293B' }}>{data?.as_of ?? '—'}</Box>
        </Box>
      </Box>

      {/* ── The table — takes every pixel the chrome above did not use ───── */}
      <Paper variant="outlined" sx={{ borderColor: LINE, overflow: 'hidden',
                                      display: 'flex', flexDirection: 'column',
                                      flex: '1 1 240px', minHeight: 240 }}>
        <Box sx={{ px: 1.5, py: 0.7, borderBottom: `1px solid ${LINE}`, flexShrink: 0,
                   display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Box sx={{ fontSize: '0.8rem', fontWeight: 700, color: INK }}>
            {ap1Label}{hasAp2 ? ` × ${ap2Label}` : ''}
          </Box>
          {/* The four cards this page used to open with are now one line. They
              were a screen of chrome for four numbers that never needed it. */}
          {!isLoading && (
            <Box sx={{ fontSize: '0.66rem', color: FAINT, whiteSpace: 'nowrap' }}>
              {periodLabel} · {fmtN(grand.writeoff_count)} loans ·{' '}
              <Box component="span" sx={{ color: MUTED, fontWeight: 700 }}>
                {fmtCr(grand.writeoff_amount)}
              </Box>{' '}written off ·{' '}
              <Box component="span" sx={{ color: REC, fontWeight: 700 }}>
                {fmtCr(grand.recovery_amount)}
              </Box>{' '}recovered ({fmtPct(grand.recovery_pct)}) ·{' '}
              <Box component="span" sx={{ color: REC, fontWeight: 700 }}>
                {fmtCr(grand.recovery_mtd)}
              </Box>{' '}this month
            </Box>
          )}
          <Box sx={{ flex: 1 }} />
          <Tooltip placement="top" title={`Shaded against ${hasAp2 ? `the MEDIAN of the rows sharing the same ${ap2Label}, so a group is judged against its own book` : 'the GRAND TOTAL, the correctly weighted figure for this selection'}. Green is better, red is worse; a row at the benchmark is left unpainted so the eye only stops on difference. Recovery % is left unjudged where a group has no written-off amount to recover against.`}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'help' }}>
              <Box component="span" sx={{ fontSize: '0.6rem', color: FAINT }}>
                vs {hasAp2 ? `${ap2Label} median` : 'grand total'}
              </Box>
              {[0, 1, 2, 3, 4].map((b) => (
                <Box key={b} sx={{ width: 16, height: 9, borderRadius: 0.5,
                                   background: b === 2 ? '#F1F5F9' : heatStyle(b, true).background }} />
              ))}
            </Box>
          </Tooltip>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', maxWidth: '100%' }}>
          <Table size="small" stickyHeader sx={{
            '& td, & th': { py: 0.45 },
            '& thead th': { top: 0, background: '#F8FAFF' },
          }}>
            <TableHead>
              <TableRow>
                <SortTh label={ap1Label} field="name" sortBy={sortBy} dir={dir} onSort={onSort} corner />
                {hasAp2 && <SortTh label={ap2Label} field="name2" sortBy={sortBy} dir={dir} onSort={onSort} />}
                {COLS.map((c) => (
                  <SortTh key={c.field} label={c.label} field={c.field} hint={c.hint}
                    sortBy={sortBy} dir={dir} onSort={onSort} align="right" />
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={colCount}><Skeleton height={150} /></TableCell></TableRow>
              )}
              {!isLoading && paged.total === 0 && (
                <TableRow><TableCell colSpan={colCount} align="center"
                  sx={{ py: 5, color: MUTED, fontSize: '0.85rem' }}>
                  No written-off loans for this selection.
                </TableCell></TableRow>
              )}
              {!isLoading && paged.pageRows.map((r, i) => {
                // The spine reads the PRIMARY column, so one glance down the left
                // edge ranks the rows without reading a single number.
                const primary = COLS.find((c) => c.primary)
                const spine = primary ? spineColor(bandOf(r, primary)) : 'transparent'
                return (
                  <TableRow key={`${r.name}-${r.name2 ?? ''}-${i}`} hover>
                    <TableCell sx={{ fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap',
                                     position: 'sticky', left: 0, zIndex: 1, background: '#FFFFFF',
                                     borderLeft: `3px solid ${spine}`,
                                     borderRight: `1px solid ${LINE}` }}>{r.name}</TableCell>
                    {hasAp2 && (
                      <TableCell sx={{ fontSize: '0.75rem', color: '#475569', whiteSpace: 'nowrap' }}>
                        {r.name2 ?? '—'}
                      </TableCell>
                    )}
                    {COLS.map((c) => (
                      <TableCell key={c.field} align="right"
                        sx={{ fontSize: '0.75rem', whiteSpace: 'nowrap',
                              fontFamily: 'JetBrains Mono, monospace',
                              ...(c.heat
                                ? heatStyle(bandOf(r, c), !!c.primary)
                                : { color: c.color ?? 'inherit',
                                    fontWeight: c.bold ? 700 : 400 }) }}>
                        {c.fmt(r[c.field])}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })}
            </TableBody>
            {!isLoading && paged.total > 0 && (
              <TableBody>
                {/* Pinned to the bottom of the scroll box: on a 143-branch
                    grouping the total was three pages away from the header. */}
                <TableRow sx={{ position: 'sticky', bottom: 0, zIndex: 2 }}>
                  <TableCell sx={{ fontSize: '0.75rem', fontWeight: 800, position: 'sticky',
                                   left: 0, zIndex: 3, background: '#F1F5F9',
                                   borderTop: `2px solid ${LINE}`,
                                   borderRight: `1px solid ${LINE}` }}>Grand Total</TableCell>
                  {hasAp2 && <TableCell sx={{ background: '#F1F5F9', borderTop: `2px solid ${LINE}` }} />}
                  {COLS.map((c) => (
                    <TableCell key={c.field} align="right"
                      sx={{ fontSize: '0.75rem', fontWeight: 800, whiteSpace: 'nowrap',
                            fontFamily: 'JetBrains Mono, monospace',
                            background: '#F1F5F9', borderTop: `2px solid ${LINE}`,
                            color: c.color ?? INK }}>
                      {c.fmt(c.field === 'share_pct' ? 100 : grand[c.field])}
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            )}
          </Table>
        </Box>
        <Paginator page={paged.page} pages={paged.pages} total={paged.total}
          pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
      </Paper>

      {/* Below the table, exactly as Current Outstanding does it. TrendSection
          owns its own collapsed state and does not fetch until opened, so a
          second page-level toggle was redundant — and putting the section ABOVE
          the table meant opening it shoved the report off screen. AP#1/AP#2 are
          passed so the trend groups the same way the table does. */}
      <TrendSection
        title="Trend — Write-off Recovery"
        portfolio="with" ap1={ap1} ap2={ap2}
        measures={[{ key: 'wo_recovery', label: '₹ Recovered', format: 'inr' }]} />
    </Box>
  )
}

// ── small controls ───────────────────────────────────────────────────────────
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

function SortTh({ label, field, sortBy, dir, onSort, align = 'left', corner, hint }: {
  label: string; field: string; sortBy: string; dir: 'asc' | 'desc'
  onSort: (f: string) => void; align?: 'left' | 'right'; corner?: boolean; hint?: string
}) {
  const cell = (
    <TableCell align={align}
      sx={{ fontWeight: 700, fontSize: '0.7rem', whiteSpace: 'nowrap',
            // Frozen on BOTH axes, so it must outrank the header row (MUI's
            // stickyHeader puts th at z-index 2) and the frozen body column.
            ...(corner ? { position: 'sticky', left: 0, zIndex: 4,
                           borderRight: `1px solid ${LINE}` } : {}) }}>
      <TableSortLabel active={sortBy === field} direction={sortBy === field ? dir : 'desc'}
        onClick={() => onSort(field)}
        sx={{ color: '#1E40AF !important', '& .MuiTableSortLabel-icon': { color: '#1565C0 !important' } }}>
        {label}
      </TableSortLabel>
    </TableCell>
  )
  return hint ? <Tooltip placement="top" title={hint}>{cell}</Tooltip> : cell
}
