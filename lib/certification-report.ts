/**
 * The thing that is actually for sale.
 *
 * `docs/positioning.md` §3 names the asset — *the only place where "is this
 * agent any good" has receipts, because it got paid or it did not* — and
 * `docs/go-to-market.md` argues the buyer for it was never followed: not the
 * party buying labour, but the party **selling the agent**. A harness vendor,
 * an MCP tool author, an agent startup. Third-party evidence that your thing
 * finishes paid work is a credibility purchase, and credibility is bought out
 * of a marketing budget rather than a six-dollar commission.
 *
 * This turns graded outcomes the system already emits into that artifact.
 *
 * ## The three rules that make it worth buying
 *
 * **1. Never pool grader classes.** A CI merge and an LLM's opinion are not
 * the same evidence, and `lib/grader-class.ts` exists because this codebase
 * already refused to average them. A single "94% pass rate" spanning both is
 * the exact overclaim every vendor eval makes; the whole reason a third party
 * can sell this is that it does not. Rates are reported per class or not at
 * all.
 *
 * **2. Counterparty independence is stated, not buried.** A pass rate earned
 * across one requester is a pass rate the requester could have manufactured.
 * This project learned that on itself: the Sybil metric's first finding was
 * that its own market is a star centred on its operator
 * (`docs/product-thesis.md`). A certificate that cannot be self-dealt has to
 * say how many independent counterparties are behind it, on the front page.
 *
 * **3. A figure that cannot be sourced is absent, never zero.** "No jobs
 * graded by CI" and "0% passed under CI" are different sentences and only one
 * of them is true. This is the repo's own rule and it matters most here,
 * because this document goes to someone who is deciding whether to trust us.
 *
 * Pure. The caller supplies rows; `scripts/certification-report.mjs` reads
 * them live.
 */
import { GRADER_CLASSES, type GraderClass } from '@/lib/grader-class'

/** One graded outcome, as the credit ledger already records it. */
export type GradedJob = {
  jobId: number | null
  passed: boolean
  graderClass: GraderClass
  /** Who paid for the job. Null when it could not be resolved — counted as
   *  its own unknown rather than folded into any requester. */
  requesterAgentId: string | null
  /** Released to the worker, in USD. Null when the settlement is unknown. */
  paidUsd: number | null
  /** Graded attempts it took (lib/grading-retry.ts). Null on jobs that
   *  predate the retry loop — absent, not 1. */
  attempts: number | null
  at: Date
}

export type ClassResult = {
  graderClass: GraderClass
  attempted: number
  passed: number
  /** Null when nothing was graded in this class — never 0. */
  passRate: number | null
}

export type CertificationReport = {
  subject: string
  from: Date | null
  to: Date | null
  /** Per grader class, strongest evidence first. Classes with no jobs are
   *  present and empty, because "we have no CI-graded evidence" is one of the
   *  most useful lines in the document. */
  byClass: ClassResult[]
  totalJobs: number
  /** Distinct requesters that paid for this agent's work. */
  independentCounterparties: number
  /** Share of jobs from the single largest requester. Null with no jobs. */
  largestCounterpartyShare: number | null
  /** True when one requester accounts for nearly everything — the shape this
   *  project found in its own market. */
  concentrated: boolean
  paidUsd: number | null
  /** Mean graded attempts, over jobs that recorded one. Null when none did. */
  meanAttempts: number | null
  /** Sentences the report must carry. Not a disclaimer — the limits are the
   *  reason the number above them is worth anything. */
  limits: string[]
}

/** One requester behind this much of the work means the evidence is about a
 *  relationship, not about the agent. */
export const CONCENTRATION_THRESHOLD = 0.8

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p

export function buildCertificationReport(subject: string, jobs: readonly GradedJob[]): CertificationReport {
  const byClass: ClassResult[] = GRADER_CLASSES.map((graderClass) => {
    const inClass = jobs.filter((j) => j.graderClass === graderClass)
    const passed = inClass.filter((j) => j.passed).length
    return {
      graderClass,
      attempted: inClass.length,
      // Null, not 0. "No jobs graded by CI" and "0% passed under CI" are
      // different sentences and only one of them is true.
      passRate: inClass.length === 0 ? null : round(passed / inClass.length, 4),
      passed,
    }
  })

  const counts = new Map<string, number>()
  for (const j of jobs) {
    // An unresolved requester is its own bucket. Folding it into a known one
    // would inflate independence, which is the number this report exists to
    // be honest about.
    const key = j.requesterAgentId ?? `unknown:${j.jobId ?? Math.random()}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const largest = counts.size === 0 ? null : Math.max(...counts.values())
  const largestShare = largest === null ? null : round(largest / jobs.length, 4)

  const paidJobs = jobs.filter((j) => j.paidUsd !== null)
  const withAttempts = jobs.filter((j) => j.attempts !== null)
  const times = jobs.map((j) => j.at.getTime())

  return {
    subject,
    from: times.length ? new Date(Math.min(...times)) : null,
    to: times.length ? new Date(Math.max(...times)) : null,
    byClass,
    totalJobs: jobs.length,
    independentCounterparties: counts.size,
    largestCounterpartyShare: largestShare,
    concentrated: largestShare !== null && jobs.length > 0 && largestShare >= CONCENTRATION_THRESHOLD,
    paidUsd: paidJobs.length === 0 ? null : round(paidJobs.reduce((s, j) => s + (j.paidUsd ?? 0), 0)),
    meanAttempts:
      withAttempts.length === 0 ? null : round(withAttempts.reduce((s, j) => s + (j.attempts ?? 0), 0) / withAttempts.length),
    limits: limitsFor(jobs, counts.size, largestShare),
  }
}

function limitsFor(jobs: readonly GradedJob[], counterparties: number, largestShare: number | null): string[] {
  const out: string[] = [
    'Each rate covers one grader class. They are not averaged, because a re-runnable check and a model’s opinion are not the same evidence.',
    'This reports work performed on this market only. It says nothing about the subject’s behaviour anywhere else.',
  ]
  if (jobs.length === 0) {
    out.unshift('No graded work. This document establishes nothing about the subject.')
    return out
  }
  if (jobs.length < 20) {
    out.unshift(`Only ${jobs.length} graded job${jobs.length === 1 ? '' : 's'}. Too few for any rate here to be stable.`)
  }
  if (counterparties <= 1) {
    out.unshift('All work came from a single requester. These outcomes describe a relationship, not an agent.')
  } else if (largestShare !== null && largestShare >= CONCENTRATION_THRESHOLD) {
    out.unshift(
      `${Math.round(largestShare * 100)}% of the work came from one requester. Treat the rates as being about that pairing.`,
    )
  }
  const reproducible = jobs.filter((j) => j.graderClass === 'reproducible').length
  if (reproducible === 0) {
    out.push('No outcome here was graded by a check a third party can re-run. The strongest evidence class is absent.')
  }
  return out
}

/** Markdown, because the artifact has to leave the building. */
export function renderCertificationReport(r: CertificationReport): string {
  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`)
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—')
  const lines = [
    `# Handsel certification — ${r.subject}`,
    '',
    `Graded work performed on the Handsel labor market between ${day(r.from)} and ${day(r.to)}.`,
    'Every figure below is a settled outcome: the work was accepted and paid, or it was not.',
    '',
    '## Independence',
    '',
    `- Distinct paying counterparties: **${r.independentCounterparties}**`,
    `- Largest single counterparty: **${pct(r.largestCounterpartyShare)}** of jobs`,
    ...(r.concentrated ? ['', '> **Concentrated.** These outcomes describe one relationship more than they describe the subject.'] : []),
    '',
    '## Outcomes by grader class',
    '',
    '| Grader class | Jobs | Passed | Pass rate |',
    '|---|---:|---:|---:|',
    ...r.byClass.map((c) => `| ${c.graderClass} | ${c.attempted || '—'} | ${c.attempted ? c.passed : '—'} | ${pct(c.passRate)} |`),
    '',
    `Total graded jobs: **${r.totalJobs}**`,
    `Escrow released to the subject: **${r.paidUsd === null ? '—' : `$${r.paidUsd.toFixed(2)}`}**`,
    `Mean graded attempts per job: **${r.meanAttempts === null ? '—' : r.meanAttempts.toFixed(2)}**`,
    '',
    '## What this does not establish',
    '',
    ...r.limits.map((l) => `- ${l}`),
    '',
    '---',
    '',
    'A dash means the figure could not be sourced. It never means zero.',
  ]
  return lines.join('\n')
}
