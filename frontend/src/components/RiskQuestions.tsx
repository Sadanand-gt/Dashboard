import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Skeleton from '@mui/material/Skeleton'
import Tooltip from '@mui/material/Tooltip'

/**
 * Client Risk Categorization — this page's whole brief on one strip.
 *
 * Five cards: the AML risk grade, then the four questions the origination form
 * asks, in the form's order. Each card carries its own pending count and names
 * the source field behind it.
 *
 * WHAT WAS TAKEN OUT, AND WHY
 *  · A KPI row underneath repeated PEP / Works Abroad / LUC Pending — the same
 *    three numbers twice on one screen.
 *  · A "not yet assessed" footer listed the four blank counts as chips. Those
 *    ARE the five pending lines on the cards, to the loan. The one thing it said
 *    that the cards could not — that these are the same borrowers, not four
 *    separate gaps — now lives in the pending tooltip, which is where someone
 *    reading a pending number would look for it.
 *  · A gradient banner, and the slim header that replaced it. The header's
 *    "93,352 loans · Rs 355.44 Cr" is the table's own Grand Total row, and its
 *    unassessed count is the pending line on all five cards. The single fact it
 *    carried that nothing else did — that the blanks are the SAME borrowers —
 *    moved into the pending tooltip, where someone reading a pending number is
 *    already looking.
 *  · The answer chips. The headline IS the flagged answer, so the chip beside
 *    it — "High 1,594" under "1,594 High" — was the same number twice on the
 *    same card, five times across the strip. Only the COMPLEMENT survives, on
 *    the sub-line: "how many are low risk" is a real question, "how many are
 *    high risk" is already the number above it.
 *
 * Every card is now the same FOUR rows — label, headline, sub-line, pending — so
 * the dashed pending rule lines up across the strip without a spacer. Anything
 * that would add a line to one card only (the single-answer note) rides on the
 * sub-line instead.
 */

const INK = '#0F172A'
const MUTED = '#64748B'
const FAINT = '#94A3B8'
const LINE = '#E2E8F0'

// One tone per MEANING, not per card, so colour reads the same across the row:
// red = the answer that flags risk, amber = an operational gap, slate = benign.
const TONE = {
  alert: { fg: '#B91C1C', bar: '#DC2626' },
  warn:  { fg: '#B45309', bar: '#D97706' },
  ok:    { fg: '#334155', bar: '#94A3B8' },
} as const

export interface Answer {
  label: string; count: number; pos: number; pct: number
  flag: boolean; tone: 'alert' | 'warn' | 'ok'
}
export interface Question {
  key: string; label: string; question: string; source_field: string
  available: boolean
  answers: Answer[]
  pending: { count: number; pos: number; pct: number } | null
  flag_count: number; flag_pos: number; flag_label?: string | null
}
export interface Unassessed {
  count: number; pos: number; all_four: number; pct: number
  fields: { question: string; source_field: string; count: number }[]
}

const fmtN = (n: number) => Math.round(n || 0).toLocaleString('en-IN')
const fmtCr = (n: number) => `₹${((n || 0) / 1e7).toFixed(2)} Cr`
const fmtPct = (n: number) => `${(n ?? 0).toFixed(2)}%`

export function RiskQuestions({ questions, unassessed, newBy, priorDay, loading }: {
  questions: Question[]
  /** Only the OVERLAP is used, inside each pending tooltip — see QuestionCard. */
  unassessed?: Unassessed | null
  newBy?: Record<string, number | undefined>
  priorDay?: string | null
  loading?: boolean
}) {
  return (
    <Paper variant="outlined" sx={{ borderColor: LINE, overflow: 'hidden' }}>
      <Box sx={{ display: 'grid', gap: 0,
                 gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)',
                                        lg: 'repeat(5, 1fr)' } }}>
        {loading && [0, 1, 2, 3, 4].map((i) => (
          <Box key={i} sx={{ px: 1.25, py: 0.85, borderRight: `1px solid ${LINE}` }}>
            <Skeleton width="60%" height={12} /><Skeleton width="48%" height={24} />
            <Skeleton height={7} sx={{ mt: 0.6 }} />
          </Box>
        ))}
        {!loading && questions.map((q, i) => (
          <QuestionCard key={q.key} q={q} last={i === questions.length - 1}
            newCount={newBy?.[q.key]} priorDay={priorDay} overlap={unassessed?.all_four} />
        ))}
      </Box>
    </Paper>
  )
}

function QuestionCard({ q, last, newCount, priorDay, overlap }: {
  q: Question; last: boolean; newCount?: number; priorDay?: string | null
  /** loans blank on EVERY question, so the tooltip can say it exactly. */
  overlap?: number
}) {
  const edge = { borderRight: last ? 'none' : `1px solid ${LINE}` }

  if (!q.available) {
    return (
      <Box sx={{ px: 1.25, py: 0.85, ...edge, background: '#FAFAFA' }}>
        <Title label={q.label} question={q.question} field={q.source_field} />
        <Box sx={{ mt: 0.4, fontSize: '0.72rem', fontWeight: 700, color: FAINT }}>Not captured</Box>
      </Box>
    )
  }

  const pending = q.pending ?? { count: 0, pos: 0, pct: 0 }
  const flagged = q.answers.find((a) => a.flag)
  // Headline is the RISK answer where there is one; where there is not
  // (Nationality) it is the answer actually given, which is the only useful
  // reading of a question whose every recorded reply is identical.
  const head = flagged ?? q.answers[0]
  const others = q.answers.filter((a) => a !== head)
  const tone = flagged ? TONE[flagged.tone] : TONE.ok
  const total = q.answers.reduce((t, a) => t + a.count, 0) + pending.count

  return (
    <Box sx={{ px: 1.25, py: 0.85, ...edge }}>
      <Title label={q.label} question={q.question} field={q.source_field} />

      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.45, mt: 0.3 }}>
        <Box sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '1.15rem',
                   fontWeight: 800, color: tone.fg, lineHeight: 1.1 }}>
          {fmtN(head?.count ?? 0)}
        </Box>
        <Box sx={{ fontSize: '0.6rem', fontWeight: 700, color: tone.fg, minWidth: 0,
                   overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {head?.label ?? '—'}
        </Box>
        {!!newCount && priorDay && (
          <Tooltip placement="top" title={`${fmtN(newCount)} loans carry this flag today that did not on the previous snapshot (${priorDay}). Gross arrivals — ten in against ten out must not read as zero.`}>
            <Box sx={{ fontSize: '0.55rem', fontWeight: 700, color: '#B45309', cursor: 'help' }}>
              ▲{fmtN(newCount)}
            </Box>
          </Tooltip>
        )}
      </Box>
      {/* The headline IS the flagged answer, so a chip repeating it was the same
          number twice on one card. Only the OTHER answers are listed here —
          "how many are low risk" is a real question, "how many are high risk"
          is already the number above it. */}
      <Box sx={{ fontSize: '0.58rem', color: MUTED, display: 'flex', gap: 0.5,
                 flexWrap: 'wrap', alignItems: 'baseline' }}>
        <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
          {fmtPct(head?.pct ?? 0)} · {fmtCr(head?.pos ?? 0)}
        </Box>
        {others.map((a) => (
          <Tooltip key={a.label} placement="top"
            title={`${a.label} — ${fmtN(a.count)} loans (${fmtPct(a.pct)}), ${fmtCr(a.pos)}`}>
            <Box component="span" sx={{ whiteSpace: 'nowrap', cursor: 'help', color: '#475569' }}>
              · {a.label}{' '}
              <Box component="span" sx={{ fontFamily: 'JetBrains Mono, monospace',
                                          fontWeight: 700 }}>{fmtN(a.count)}</Box>
            </Box>
          </Tooltip>
        ))}
        {q.answers.length === 1 && (
          <Tooltip placement="top"
            title={`“${q.answers[0].label}” is the ONLY value ever recorded against ${q.source_field}. Read it as a question that has not yet distinguished between borrowers, not as a population that was checked and cleared.`}>
            <Box component="span" sx={{ color: FAINT, cursor: 'help', whiteSpace: 'nowrap' }}>
              · only value on record
            </Box>
          </Tooltip>
        )}
      </Box>

      {/* Whole-book bar: every answer plus the blanks, so the card accounts for
          all of its own loans instead of showing one number out of context. */}
      <Box sx={{ display: 'flex', height: 5, borderRadius: 1, overflow: 'hidden',
                 mt: 0.6, background: '#F1F5F9' }}>
        {q.answers.map((a) => (
          <Tooltip key={a.label} placement="top"
            title={`${a.label} — ${fmtN(a.count)} loans (${fmtPct(a.pct)}), ${fmtCr(a.pos)}`}>
            <Box sx={{ width: `${total ? a.count / total * 100 : 0}%`,
                       background: TONE[a.tone].bar, cursor: 'help' }} />
          </Tooltip>
        ))}
        {pending.count > 0 && (
          <Tooltip placement="top"
            title={`No answer recorded — ${fmtN(pending.count)} loans (${fmtPct(pending.pct)}), ${fmtCr(pending.pos)}`}>
            {/* Hatched, not flat grey: "nothing recorded" must not look like
                just another answer on the bar. */}
            <Box sx={{ width: `${total ? pending.count / total * 100 : 0}%`, cursor: 'help',
                       backgroundImage: 'repeating-linear-gradient(45deg,#CBD5E1 0 3px,#F1F5F9 3px 6px)' }} />
          </Tooltip>
        )}
      </Box>

      {/* Pending stays in the card it belongs to and names the field that is
          blank — a gap is only actionable if you know what to go and fill. */}
      <Box sx={{ mt: 0.5, pt: 0.4, borderTop: `1px dashed ${LINE}` }}>
        {pending.count > 0 ? (
          <Tooltip placement="bottom-start"
            title={`${fmtN(pending.count)} loans have nothing recorded against ${q.source_field}, carrying ${fmtCr(pending.pos)} of outstanding. They are NOT counted as "no" — an unanswered risk question is unassessed, not clear.${overlap ? ` ${fmtN(overlap)} loans are blank on EVERY question on this strip, so this is one population that was never taken through the questionnaire rather than a gap peculiar to this field.` : ''}`}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.35, cursor: 'help',
                       whiteSpace: 'nowrap' }}>
              <Box sx={{ fontSize: '0.6rem', fontWeight: 700, color: '#B45309',
                         fontFamily: 'JetBrains Mono, monospace' }}>{fmtN(pending.count)}</Box>
              <Box sx={{ fontSize: '0.56rem', color: '#B45309' }}>pending</Box>
              <Box sx={{ fontSize: '0.54rem', color: FAINT, fontFamily: 'JetBrains Mono, monospace' }}>
                {q.source_field}
              </Box>
            </Box>
          </Tooltip>
        ) : (
          <Box sx={{ fontSize: '0.58rem', fontWeight: 700, color: '#15803D' }}>fully answered</Box>
        )}
      </Box>
    </Box>
  )
}

/** Short label on the card; the form's exact wording, and the source column, on
 *  hover. Dotted underline is the affordance that there is more to read. */
function Title({ label, question, field }: {
  label: string; question: string; field: string
}) {
  return (
    <Tooltip placement="top-start"
      title={<span>{question}<br /><em style={{ opacity: 0.75 }}>source field: {field}</em></span>}>
      <Box sx={{ fontSize: '0.63rem', fontWeight: 700, color: INK, lineHeight: 1.2,
                 cursor: 'help', display: 'inline-block',
                 borderBottom: `1px dotted ${FAINT}`, whiteSpace: 'nowrap',
                 overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
        {label}
      </Box>
    </Tooltip>
  )
}
