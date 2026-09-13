import { StandardReport } from '../components/StandardReport'

/**
 * Case Movement — the origination funnel, month to date.
 *
 * READ THE FUNNEL LEFT TO RIGHT: applications arrive, the bureau screens them,
 * Personal Discussion visits them, credit sanctions, and money goes out. Each
 * stage has its OWN denominator, so the rates are never chained into a single
 * "approval rate" — that number would be meaningless.
 *
 * TWO COVERAGE FACTS THAT ARE PROPERTIES OF THE SOURCE, NOT OF PERFORMANCE
 *   · PD, post-PD rejection, CGT and GRT are JLG ONLY. IL carries no pd_remarks
 *     and no group meetings, so case_movement.sql writes 0 for those columns on
 *     the IL side by construction. Grouping by Business Segment will therefore
 *     show IL at zero for them — that is absence, not failure. Every affected
 *     column says so in its own hover text.
 *   · Median TAT is deliberately absent. rpt_case_movement stores it as a
 *     per-branch median; totalling medians or averaging them is not the firm's
 *     median, and the underlying day counts are not on the table.
 *
 * WITHDRAWN 2026-08-25 (2) — the NC / EC sanction-rate split. It is the most
 * striking pair of numbers this table can produce (~1% against ~45%) and it is
 * circular: cust_type comes from `SELECT DISTINCT cust_id FROM
 * home_loan_account` with no as-of date, so a customer becomes "existing" the
 * moment their application is sanctioned — on their own first application. "NC"
 * therefore means little more than "has no loan today", which is mostly the
 * CONSEQUENCE of not being sanctioned. On completed months, sanctioned-ever with
 * no month cut-off, JLG NC reads 9 of 33,672 (0.03%) with two months at exactly
 * 0.00%. That is a structural zero, not a credit outcome. The counts stay in the
 * API so the plumbing survives; the rates are gone until cust_type is evaluated
 * as at the application date.
 *
 * WITHDRAWN 2026-08-25 (1) — "Booked", "Credit" and "TVR" are gone from this page.
 * They count applications sitting in status 'BK' / 'CC' / 'TV', and those codes
 * do not exist in `loan_application` at all: JLG's statuses are X / A / B / C1 /
 * S / D / G1 / HV / P1. So all three matched the IL table only, and read 1, 8
 * and 1 respectively for the entire firm this month while 13,860 applications
 * came in. "Booked MTD" was this page's FIRST headline KPI. This is the same
 * trap that made JLG rejections read zero (status 'XR' vs 'X', fixed 2026-08-21)
 * three columns further up the same file. Restoring them needs the JLG status →
 * stage mapping, which is a question for the business, not a guess.
 */
export function CaseMovement() {
  return (
    <StandardReport
      title="Case Movement"
      endpoint="case-movement"
      note="Origination funnel, month to date — applications → bureau → PD → sanction → disbursement"
      kpis={[
        { field: 'total_apps_mtd',        label: 'Applications',   fmt: 'num' },
        { field: 'sanctioned_mtd',        label: 'Sanctioned',     fmt: 'num', variant: 'green' },
        { field: 'rejected_mtd',          label: 'Rejected',       fmt: 'num', variant: 'red' },
        { field: 'disbursed_mtd_amount',  label: 'Disbursed',      fmt: 'inr', variant: 'green' },
        { field: 'approval_ratio_total',  label: 'Sanction %',     fmt: 'pct' },
      ]}
      chartField="disbursed_mtd_amount"
      chartLabel="MTD Disbursed"
      chartFmt="inr"
      columns={[
        // ── Volume through the funnel ────────────────────────────────────
        { field: 'total_apps_mtd', label: 'Applications', fmt: 'num',
          hint: 'Every application dated this month, top-ups and duplicates included. The widest count on the page and the denominator for the duplicate rate.' },
        // NOT labelled "New Clients". The underlying flag is evaluated against
        // TODAY's loan book, so a genuine first-time borrower who was sanctioned
        // is reclassified as existing — this column mostly counts applicants who
        // did not get a loan. See the note above the component.
        { field: 'new_clients_mtd', label: 'No Prior Loan', fmt: 'num',
          hint: 'Applications from customers who hold no loan with us AS AT TODAY — not "new clients". The flag carries no as-of date, so anyone whose application was sanctioned now has a loan row and is counted as existing instead, including on their first-ever application. Read this as application volume from people not on the book, never as new-customer acquisition.' },
        { field: 'cb_checked_total', label: 'CB Screened', fmt: 'num',
          hint: 'Applications that reached a bureau check — non-top-up and non-duplicate. This is the denominator for Sanction %.' },
        { field: 'pd_done_mtd', label: 'PD Done', fmt: 'num',
          hint: 'Personal Discussion visits completed. JLG ONLY — IL carries no pd_remarks, so IL reports 0 by construction rather than "not measured".' },
        { field: 'sanctioned_mtd', label: 'Sanctioned', fmt: 'num',
          hint: 'Applications with a sanction date in this month, excluding top-ups.' },
        { field: 'rejected_mtd', label: 'Rejected', fmt: 'num', heat: 'bad-high',
          hint: 'Applications rejected during this month. JLG rejections use status “X”, IL uses “XR” — the two systems differ and both are handled.' },
        // The split that carries the cost signal: work that failed AFTER a field
        // visit spent a field visit. Work screened out at the bureau spent a query.
        { field: 'rejected_post_pd_mtd', label: 'Rejected past PD', fmt: 'num', heat: 'bad-high',
          hint: 'Of the rejections, those already past Personal Discussion — a rejection that cost a field visit rather than a bureau query. JLG ONLY; IL reports 0.' },
        { field: 'disbursed_mtd_count', label: 'Disbursed #', fmt: 'num' },
        { field: 'disbursed_mtd_amount', label: 'Disbursed ₹', fmt: 'inr' },
        { field: 'avg_ticket', label: 'Avg Ticket', fmt: 'inr',
          hint: 'Disbursed amount ÷ disbursed count, recomputed at whatever grouping is on screen — never an average of branch averages.' },

        // ── Rates. Each has its own denominator; they do not chain. ───────
        { field: 'approval_ratio_total', label: 'Sanction %', fmt: 'pct',
          heat: 'good-high', primary: true, base: { field: 'cb_checked_total' },
          hint: 'Sanctioned ÷ CB screened. The SANCTION stage’s own rate — not the BRE engine’s approval rate, which has a different denominator. A branch that screened nothing has no rate and is left unshaded rather than painted red.' },
        { field: 'disbursal_rate', label: 'Disbursal %', fmt: 'pct',
          heat: 'good-high', base: { field: 'sanctioned_mtd' },
          hint: 'Disbursed count ÷ sanctioned count, both within this month. A flow-against-flow ratio, not a cohort conversion: a loan sanctioned late last month can disburse early this one, so it can exceed 100%. A persistently low reading means sanctions are stalling before the money moves.' },
        { field: 'post_pd_reject_pct', label: 'Wasted PD %', fmt: 'pct', heat: 'bad-high',
          base: { field: 'rejected_mtd' },
          hint: 'Of this month’s rejections, the share already past Personal Discussion. High means field effort is being spent on applications the bureau stage could have screened out earlier. JLG ONLY; IL reports 0.' },
        { field: 'duplicate_pct', label: 'Duplicate %', fmt: 'pct', heat: 'bad-high',
          base: { field: 'total_apps_mtd' },
          hint: 'Applications flagged as duplicates ÷ all applications. A data-quality and field-discipline reading rather than a credit one.' },
        { field: 'grt_completion_pct', label: 'GRT %', fmt: 'pct',
          heat: 'good-high', base: { field: 'cgt1_mtd' },
          hint: 'Group Recognition Tests passed ÷ Compulsory Group Trainings run. JLG ONLY; IL has no group meetings and reports 0.' },
      ]}
    />
  )
}
