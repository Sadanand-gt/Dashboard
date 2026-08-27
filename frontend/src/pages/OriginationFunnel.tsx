import { useState, useMemo } from 'react'
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
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'

import { api } from '../api/client'
import { useSlicerParams } from '../store/filterStore'
import { ExportCsvButton } from '../components/ExportCsvButton'

const INK = '#0F172A'
const MUTED = '#64748B'
const FAINT = '#94A3B8'
const LINE = '#E2E8F0'
const RED = '#DC2626'
const AMBER = '#D97706'
const GREEN = '#16A34A'
const BLUE = '#1565C0'

const fmtN = (n: number) => Math.round(n || 0).toLocaleString('en-IN')
const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `${Number(n).toFixed(2)}%`)
const fmtCr = (n: number) => `₹${((n || 0) / 1e7).toFixed(2)} Cr`
const fmtRs = (n: number) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`

const CATEGORIES = ['New to Credit', 'New to Company', 'Existing Borrower', 'Employee']

const ABOUT = 'Follows every application from the month it was punched to wherever it stands today — approved, rejected at a named stage, or still in process. Built at application grain, so a cohort can be followed to completion instead of being cut off at a month end. Sanction rates divide by DECIDED, not by applications, so a cohort still in flight is not penalised for being young; how much of it is still in flight is reported separately as Pending.'

const CARRY_OVER = 'An application punched on 25 July is often still moving in August. A month-to-date report counts "punched this month" and "decided this month" as if they were the same population — they are not. Pick a punch month here and you follow that cohort wherever its decisions landed.'

interface StageRow {
  stage: string; label: string; named: boolean
  rejected_here: number; live_here: number
  median_days: number | null; top_reason: string | null
}
interface CatRow {
  category: string; applications: number; is_approved: number; is_rejected: number
  is_inprocess: number; sanction_rate: number; pending_rate: number
  avg_days: number; avg_ticket: number; disbursed_amount: number
}
interface CohortRow extends CatRow { cohort: string; decided: number }
interface MeetRow {
  purpose: string; completed: number; pending: number; cancelled: number
  pending_pct: number; cancelled_pct: number
}

export function OriginationFunnel() {
  const slicer = useSlicerParams()
  const [cohort, setCohort] = useState('ALL')
  const [category, setCategory] = useState('ALL')
  const [show, setShow] = useState(true)

  const params = {
    ...slicer,
    ...(cohort !== 'ALL' ? { cohort } : {}),
    ...(category !== 'ALL' ? { category } : {}),
  }
  // Written out rather than looped through a helper: a hook called from inside a
  // local function is one conditional away from changing call order between
  // renders, which React cannot recover from.
  const get = (path: string) => () =>
    api.get(`/api/origination-funnel/${path}`, { params }).then((r) => r.data)
  const stagesQ = useQuery<{ rows: StageRow[]; totals: Record<string, number>; as_of: string | null }>(
    { queryKey: ['of-stages', params], queryFn: get('stages') })
  const catQ = useQuery<{ rows: CatRow[] }>(
    { queryKey: ['of-category', params], queryFn: get('category') })
  const meetQ = useQuery<{ rows: MeetRow[] }>(
    { queryKey: ['of-meetings', params], queryFn: get('meetings') })
  const cohQ = useQuery<{ rows: CohortRow[] }>(
    { queryKey: ['of-cohorts', params], queryFn: get('cohorts') })

  const isLoading = stagesQ.isLoading
  const stages = stagesQ.data?.rows ?? []
  const T = stagesQ.data?.totals ?? {}
  const cats = catQ.data?.rows ?? []
  const meets = meetQ.data?.rows ?? []
  const cohorts = cohQ.data?.rows ?? []

  const cohortOptions = useMemo(
    () => ['ALL', ...cohorts.map((c) => c.cohort)], [cohorts])

  // Largest single stage, so the bars are read against the worst one rather than
  // against the total — a stage holding 57% of rejections should look like it.
  const stageMax = useMemo(
    () => Math.max(1, ...stages.map((s) => s.rejected_here + s.live_here)), [stages])

  const fetchApps = async () => {
    const r = await api.get('/api/origination-funnel/applications', { params })
    return r.data.rows as Record<string, unknown>[]
  }
  const exportCols = useMemo<[string, string][]>(() => ([
    ['application_number', 'Application'], ['loan_source', 'Source'],
    ['cohort_month', 'Punch Month'], ['application_date', 'Application Date'],
    ['outcome', 'Outcome'], ['current_stage', 'Live Stage'],
    ['reject_stage', 'Rejected At'], ['reject_reason', 'Reject Reason'],
    ['reject_type', 'Reject Type'], ['days_to_decision', 'Days to Decision'],
    ['client_category', 'Client Category'], ['bureau_decision', 'Bureau Decision'],
    ['credit_decision', 'Credit Decision'], ['hv_done', 'House Visit Done'],
    ['sanctioned', 'Sanctioned'], ['approved', 'Approved'], ['disbursed', 'Disbursed'],
    ['applied_amount', 'Applied'], ['sanctioned_amount', 'Sanctioned Amt'],
    ['disbursed_amount', 'Disbursed Amt'],
    ['cluster_name', 'Cluster'], ['region_name', 'Region'], ['area_name', 'Unit'],
    ['branch_name', 'Branch'], ['branch_id', 'Branch ID'], ['lo_id', 'LO'],
    ['product_id', 'Product'], ['prod_classification', 'Prod. Classification'],
  ]), [])

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
            Origination Funnel
          </Box>
          <Tooltip placement="bottom-start" title={ABOUT}>
            <Box sx={{ width: 15, height: 15, borderRadius: '50%', border: `1px solid ${LINE}`,
                       display: 'flex', alignItems: 'center', justifyContent: 'center',
                       fontSize: '0.6rem', color: FAINT, cursor: 'help', fontWeight: 700,
                       flexShrink: 0 }}>i</Box>
          </Tooltip>
        </Box>

        <Tooltip placement="bottom" title={CARRY_OVER}>
          <span><Sel label="Punch month" value={cohort} onChange={setCohort} width={116}
            options={cohortOptions.map((c) => [c, c === 'ALL' ? 'All months' : c])} /></span>
        </Tooltip>
        <Sel label="Category" value={category} onChange={setCategory} width={150}
          options={[['ALL', 'All categories'] as [string, string],
                    ...CATEGORIES.map((c) => [c, c] as [string, string])]} />
        {/* No top-up toggle on screen. The backend still excludes them and still
            accepts include_topup=1, but ZERO applications in the last 13 months
            carry a top-up product (the ANY_TOPUP_* products exist in the
            catalogue and are simply unused right now). A control labelled "Excl"
            that excludes nothing tells the reader something untrue. Restoring it
            is a one-line change if top-up origination resumes. */}
        <Box sx={{ flex: 1, minWidth: 8 }} />

        <Button size="small" variant="text" onClick={() => setShow((v) => !v)}
          sx={{ fontSize: '0.68rem', textTransform: 'none', color: MUTED,
                minWidth: 0, px: 1, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {show ? 'Hide detail' : 'Show detail'}
        </Button>
        <ExportCsvButton rows={[]} columns={exportCols} fetchRows={fetchApps}
          filename={`origination_funnel_${cohort}`} label="Export CSV" />
        <Box sx={{ fontSize: '0.66rem', color: FAINT, whiteSpace: 'nowrap', flexShrink: 0 }}>
          as of <Box component="span" sx={{ fontWeight: 700, color: '#1E293B' }}>
            {stagesQ.data?.as_of ?? '—'}</Box>
        </Box>
      </Box>

      {/* ── Headline strip ───────────────────────────────────────────────── */}
      <Paper elevation={0} sx={{ display: 'flex', flexWrap: 'wrap', flexShrink: 0,
                                 border: '1px solid rgba(0,0,0,0.07)', borderRadius: 2 }}>
        <M label="Applications" value={isLoading ? '—' : fmtN(T.applications)}
           sub={cohort === 'ALL' ? 'all punch months' : `punched ${cohort}`} />
        <M label="Sanctioned" value={isLoading ? '—' : fmtN(T.is_approved)}
           sub={isLoading ? '' : `${fmtPct(T.sanction_rate)} of decided`} accent={GREEN} />
        <M label="Rejected" value={isLoading ? '—' : fmtN(T.is_rejected)}
           sub={isLoading ? '' : `${fmtPct(T.rejection_rate)} of decided`} accent={RED} />
        <M label="Still in process" value={isLoading ? '—' : fmtN(T.is_inprocess)}
           sub={isLoading ? '' : `${fmtPct(T.pending_rate)} of applications`} accent={AMBER}
           hint="The population a month-to-date report cannot show. These applications have been punched and not yet ruled on — they will land in a later month's decision counts." />
        <M label="Days to decide" value={isLoading ? '—' : String(T.avg_days ?? '—')}
           sub="mean, punch → decision" />
        <M label="Disbursed" value={isLoading ? '—' : fmtCr(T.disbursed_amount)}
           sub={isLoading ? '' : `${fmtN(T.disbursed)} loans · ${fmtRs(T.avg_ticket)} avg`}
           accent={BLUE} last />
      </Paper>

      {show && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'stretch', flexShrink: 0 }}>
          {/* ── Stage ladder ───────────────────────────────────────────── */}
          <Paper variant="outlined" sx={{ borderColor: LINE, flex: '2 1 460px', minWidth: 0,
                                          display: 'flex', flexDirection: 'column' }}>
            <Head title="Where applications stop"
              hint="Rejections are attributed to the stage that produced them (the source's rejection_status); live cases to the stage they are sitting in. An application has one or the other, never both — so the two columns do not double count. Stages named CGT / GRT / House Visit / Sanction are verified against the meeting table's own vocabulary; the rest are shown by their raw code because naming someone's process stage on a guess is worse than leaving it unnamed." />
            <Box sx={{ overflow: 'auto', maxHeight: 320 }}>
              <Table size="small" stickyHeader sx={{ '& td, & th': { py: 0.4 },
                                                     '& thead th': { background: '#F8FAFF' } }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Stage</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Rejected here</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Still here</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Median days</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Top reason</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', width: 110 }} />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {isLoading && <TableRow><TableCell colSpan={6}><Skeleton height={120} /></TableCell></TableRow>}
                  {!isLoading && stages.length === 0 && (
                    <TableRow><TableCell colSpan={6} align="center"
                      sx={{ py: 4, color: MUTED, fontSize: '0.8rem' }}>
                      Nothing to show for this selection.</TableCell></TableRow>
                  )}
                  {stages.map((s) => (
                    <TableRow key={s.stage} hover>
                      <TableCell sx={{ fontSize: '0.73rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {s.named ? s.label : (
                          <Tooltip placement="right" title={`Source status code “${s.stage}”. Not named here — the code's meaning has not been confirmed with the business, and a stage label is read as a statement about your own process. Its behaviour is on this row: volume, how long a rejection took, and the dominant reason.`}>
                            <Box component="span" sx={{ cursor: 'help', borderBottom: `1px dotted ${FAINT}` }}>
                              {s.label}
                            </Box>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell align="right" sx={{ fontSize: '0.73rem', color: RED, fontWeight: 700,
                                                     fontFamily: 'JetBrains Mono, monospace' }}>
                        {fmtN(s.rejected_here)}
                      </TableCell>
                      <TableCell align="right" sx={{ fontSize: '0.73rem', color: s.live_here ? AMBER : FAINT,
                                                     fontWeight: s.live_here ? 700 : 400,
                                                     fontFamily: 'JetBrains Mono, monospace' }}>
                        {fmtN(s.live_here)}
                      </TableCell>
                      <TableCell align="right" sx={{ fontSize: '0.73rem', color: MUTED,
                                                     fontFamily: 'JetBrains Mono, monospace' }}>
                        {s.median_days == null ? '—' : s.median_days.toFixed(1)}
                      </TableCell>
                      <TableCell sx={{ fontSize: '0.68rem', color: MUTED }}>{s.top_reason ?? '—'}</TableCell>
                      <TableCell sx={{ py: 0.4 }}>
                        {/* Rejected and live share one bar so a stage that is
                            mostly a QUEUE reads differently from one that is
                            mostly a KILL, at a glance. */}
                        <Box sx={{ display: 'flex', height: 7, borderRadius: 1, overflow: 'hidden',
                                   background: '#F1F5F9' }}>
                          <Box sx={{ width: `${s.rejected_here / stageMax * 100}%`, background: RED }} />
                          <Box sx={{ width: `${s.live_here / stageMax * 100}%`, background: AMBER }} />
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            {/* Without this the Rejected column silently fails to add up to the
                headline. IL carries no rejection_status at all, so its
                rejections have no stage to be attributed to. */}
            {!isLoading && Number(T.rejected_unattributed) > 0 && (
              <Box sx={{ px: 1.5, py: 0.5, borderTop: `1px solid ${LINE}`,
                         fontSize: '0.63rem', color: FAINT }}>
                <Tooltip placement="top" title="Rejections carrying no stage. Almost all are IL: loan_application_il has no rejection_status column, so an IL rejection cannot be attributed to a stage. They are counted in the headline and shown here so the column above reconciles.">
                  <Box component="span" sx={{ cursor: 'help' }}>
                    + {fmtN(Number(T.rejected_unattributed))} rejections with no stage recorded
                  </Box>
                </Tooltip>
              </Box>
            )}
          </Paper>

          {/* ── Meeting queue ──────────────────────────────────────────── */}
          <Paper variant="outlined" sx={{ borderColor: LINE, flex: '1 1 300px', minWidth: 0,
                                          display: 'flex', flexDirection: 'column' }}>
            <Head title="Field & group activity"
              hint="CGT, GRT and House Visit are scheduled at CENTRE level, not per application, so they are counted separately rather than joined onto the application rows. Pending means scheduled and not yet completed — this is the operational queue, and it is usually where the delay is rather than in the credit decision." />
            <Box sx={{ overflow: 'auto' }}>
              <Table size="small" sx={{ '& td, & th': { py: 0.4 } }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Activity</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Done</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Pending</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Cancelled</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Pending %</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {meetQ.isLoading && <TableRow><TableCell colSpan={5}><Skeleton height={80} /></TableCell></TableRow>}
                  {meets.map((m) => (
                    <TableRow key={m.purpose} hover>
                      <TableCell sx={{ fontSize: '0.73rem', fontWeight: 600 }}>{m.purpose}</TableCell>
                      <TableCell align="right" sx={{ fontSize: '0.73rem', color: GREEN,
                                                     fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(m.completed)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: '0.73rem', color: AMBER, fontWeight: 700,
                                                     fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(m.pending)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: '0.73rem', color: MUTED,
                                                     fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(m.cancelled)}</TableCell>
                      {/* The only absolute threshold on the page, and it is a
                          shape rule rather than a target: a queue holding a fifth
                          of its own volume is a backlog on any book. */}
                      <TableCell align="right" sx={{ fontSize: '0.73rem', fontWeight: 700,
                                                     fontFamily: 'JetBrains Mono, monospace',
                                                     color: m.pending_pct >= 20 ? RED
                                                          : m.pending_pct >= 10 ? AMBER : GREEN }}>
                        {fmtPct(m.pending_pct)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          </Paper>
        </Box>
      )}

      {/* ── Category + cohort ────────────────────────────────────────────── */}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'stretch',
                 flex: '1 1 260px', minHeight: 240 }}>
        <Paper variant="outlined" sx={{ borderColor: LINE, flex: '1 1 400px', minWidth: 0,
                                        display: 'flex', flexDirection: 'column' }}>
          <Head title="By client category"
            hint="From the bureau engine's own CLIENT CATEGORY, assigned BEFORE the decision. New to Credit has no bureau record at all; New to Company has borrowed elsewhere but not from us; Existing Borrower already has a loan with us. This deliberately replaces the NC / EC split on the Case Movement page, which is circular — that flag comes from holding a loan today, so being sanctioned is what makes an applicant “existing”. IL is absent from the bureau database, so IL applications show as Not screened (IL)." />
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <Table size="small" stickyHeader sx={{ '& td, & th': { py: 0.4 },
                                                   '& thead th': { background: '#F8FAFF' } }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Category</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Apps</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Sanctioned</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Rejected</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Live</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Sanction %</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Avg ticket</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {catQ.isLoading && <TableRow><TableCell colSpan={7}><Skeleton height={90} /></TableCell></TableRow>}
                {cats.map((c) => (
                  <TableRow key={c.category} hover>
                    <TableCell sx={{ fontSize: '0.73rem', fontWeight: 600, whiteSpace: 'nowrap' }}>{c.category}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(c.applications)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', color: GREEN, fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(c.is_approved)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', color: RED, fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(c.is_rejected)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', color: c.is_inprocess ? AMBER : FAINT, fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(c.is_inprocess)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>{fmtPct(c.sanction_rate)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', color: MUTED, fontFamily: 'JetBrains Mono, monospace' }}>{c.avg_ticket ? fmtRs(c.avg_ticket) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Paper>

        <Paper variant="outlined" sx={{ borderColor: LINE, flex: '1 1 400px', minWidth: 0,
                                        display: 'flex', flexDirection: 'column' }}>
          <Head title="By punch month" hint={CARRY_OVER} />
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <Table size="small" stickyHeader sx={{ '& td, & th': { py: 0.4 },
                                                   '& thead th': { background: '#F8FAFF' } }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Punched</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Apps</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Sanctioned</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Sanction %</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Still live</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.68rem' }}>Avg days</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {cohQ.isLoading && <TableRow><TableCell colSpan={6}><Skeleton height={90} /></TableCell></TableRow>}
                {cohorts.map((c) => (
                  <TableRow key={c.cohort} hover selected={c.cohort === cohort}
                    onClick={() => setCohort(c.cohort === cohort ? 'ALL' : c.cohort)}
                    sx={{ cursor: 'pointer' }}>
                    <TableCell sx={{ fontSize: '0.73rem', fontWeight: 600 }}>{c.cohort}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(c.applications)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', color: GREEN, fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(c.is_approved)}</TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>{fmtPct(c.sanction_rate)}</TableCell>
                    {/* A cohort with live cases has not finished; its rate can
                        still move. Anything at zero is closed and comparable. */}
                    <TableCell align="right" sx={{ fontSize: '0.73rem', fontFamily: 'JetBrains Mono, monospace',
                                                   color: c.is_inprocess ? AMBER : FAINT,
                                                   fontWeight: c.is_inprocess ? 700 : 400 }}>
                      {c.is_inprocess ? fmtN(c.is_inprocess) : '—'}
                    </TableCell>
                    <TableCell align="right" sx={{ fontSize: '0.73rem', color: MUTED, fontFamily: 'JetBrains Mono, monospace' }}>{c.avg_days}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Paper>
      </Box>
    </Box>
  )
}

function Head({ title, hint }: { title: string; hint: string }) {
  return (
    <Box sx={{ px: 1.5, py: 0.7, borderBottom: `1px solid ${LINE}`, flexShrink: 0,
               display: 'flex', alignItems: 'center', gap: 0.6 }}>
      <Box sx={{ fontSize: '0.78rem', fontWeight: 700, color: INK }}>{title}</Box>
      <Tooltip placement="top-start" title={hint}>
        <Box sx={{ width: 14, height: 14, borderRadius: '50%', border: `1px solid ${LINE}`,
                   display: 'flex', alignItems: 'center', justifyContent: 'center',
                   fontSize: '0.55rem', color: FAINT, cursor: 'help', fontWeight: 700 }}>i</Box>
      </Tooltip>
    </Box>
  )
}

function M({ label, value, sub, accent, hint, last }: {
  label: string; value: string; sub?: string; accent?: string; hint?: string; last?: boolean
}) {
  const body = (
    <Box sx={{ flex: 1, minWidth: 132, px: 1.75, py: 0.7,
               borderRight: last ? 'none' : `1px solid ${LINE}`,
               cursor: hint ? 'help' : 'default' }}>
      <Box sx={{ fontSize: '0.55rem', fontWeight: 700, color: MUTED,
                 textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</Box>
      <Box sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.02rem',
                 fontWeight: 700, color: accent ?? INK, lineHeight: 1.3 }}>{value}</Box>
      {sub && <Box sx={{ fontSize: '0.62rem', color: FAINT, whiteSpace: 'nowrap' }}>{sub}</Box>}
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
