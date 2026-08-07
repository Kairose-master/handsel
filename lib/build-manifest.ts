/**
 * The build manifest — the pure aggregation core of `docs/build-service.md`.
 *
 * "A build's claim is exactly as strong as its weakest grader class, and the
 * manifest must say so per line rather than laundering an LLM opinion into
 * 'verified'." This module is that sentence made checkable: it turns a set of
 * subtask outcomes into one manifest, and computes the one number that keeps
 * the sentence honest — the weakest grader class the whole build can claim.
 *
 * Pure: no DB, no chain, no clock. The caller assembles `ManifestLineInput[]`
 * from whatever store holds subtask state (job specs, work proofs) and calls
 * `buildManifest` once per read.
 */

export type GraderClass = 'reproducible' | 'mechanical' | 'model'
export type LineVerdict = 'pass' | 'fail' | 'refunded' | 'pending'

/** Strength ordering, weakest first — `reproducible`/`mechanical` re-run to
 *  the SAME verdict; `model` re-runs to an independent OPINION
 *  (`lib/taskmarket-evaluator.ts`, `docs/verifying-proofs.md`). A build that
 *  mixes classes can only claim what its weakest line can back up. */
const GRADER_CLASS_RANK: Record<GraderClass, number> = { model: 0, mechanical: 1, reproducible: 2 }

export interface ManifestLineInput {
  subtaskId: string
  title: string
  verdict: LineVerdict
  /** USDC base units actually paid to the worker on this line. '0' unless
   *  verdict === 'pass'. */
  amountBaseUnits: string
  /** null on 'pending' and 'refunded' lines — nothing was graded, so there is
   *  no class to report. Never guess a class for a line that has none. */
  graderClass: GraderClass | null
  /** The signed work proof backing a 'pass' verdict, if one was issued. */
  proofId: string | null
}

export type ManifestLine = ManifestLineInput

export interface BuildManifest {
  buildId: string
  goal: string
  budgetBaseUnits: string
  /** 'open' while the envelope can still draw; 'settled' once closed with at
   *  least one graded line; 'expired' once closed with none (every subtask
   *  failed before grading ran, or the deadline hit with nothing delivered). */
  status: 'open' | 'settled' | 'expired'
  lines: ManifestLine[]
  totalPaidBaseUnits: string
  totalRefundedBaseUnits: string
  /** null when no line has graded yet — there is nothing to be weak about. */
  weakestGraderClass: GraderClass | null
}

function sumBaseUnits(values: string[]): string {
  return values.reduce((sum, v) => sum + BigInt(v), 0n).toString()
}

/** The weakest class among GRADED lines only — a 'pending' or 'refunded' line
 *  contributes no claim, so it cannot weaken one either. */
export function weakestGraderClass(lines: ManifestLineInput[]): GraderClass | null {
  const classes = lines.map((l) => l.graderClass).filter((c): c is GraderClass => c !== null)
  if (classes.length === 0) return null
  return classes.reduce((weakest, c) => (GRADER_CLASS_RANK[c] < GRADER_CLASS_RANK[weakest] ? c : weakest))
}

export function buildManifest(input: {
  buildId: string
  goal: string
  budgetBaseUnits: string
  closed: boolean
  refundedBaseUnits: string
  lines: ManifestLineInput[]
}): BuildManifest {
  const paidLines = input.lines.filter((l) => l.verdict === 'pass')
  const totalPaidBaseUnits = sumBaseUnits(paidLines.map((l) => l.amountBaseUnits))
  const graded = input.lines.some((l) => l.graderClass !== null)

  const status: BuildManifest['status'] = !input.closed ? 'open' : graded ? 'settled' : 'expired'

  return {
    buildId: input.buildId,
    goal: input.goal,
    budgetBaseUnits: input.budgetBaseUnits,
    status,
    lines: input.lines,
    totalPaidBaseUnits,
    totalRefundedBaseUnits: input.refundedBaseUnits,
    weakestGraderClass: weakestGraderClass(input.lines),
  }
}

const GRADER_CLASS_NOTE: Record<GraderClass, string> = {
  reproducible: 'every paid line re-runs to the same verdict for anyone',
  mechanical: 'paid lines re-run given the named toolchain — pin versions before comparing',
  model: 'at least one paid line is an independent OPINION, not a recomputation — see docs/verifying-proofs.md',
}

/** A one-line human summary — "the manifest is the marketing"
 *  (docs/build-service.md, increment 5). Never overstates: a build with any
 *  model-class line says so in the same sentence as the pass count. */
export function renderManifestSummary(manifest: BuildManifest): string {
  const passed = manifest.lines.filter((l) => l.verdict === 'pass').length
  const total = manifest.lines.length
  const paid = (Number(BigInt(manifest.totalPaidBaseUnits)) / 1e6).toFixed(2)
  const refunded = (Number(BigInt(manifest.totalRefundedBaseUnits)) / 1e6).toFixed(2)
  const headline = `${passed}/${total} subtask${total === 1 ? '' : 's'} passed — $${paid} paid, $${refunded} refunded.`
  if (!manifest.weakestGraderClass) return `${headline} Nothing graded yet.`
  return `${headline} ${GRADER_CLASS_NOTE[manifest.weakestGraderClass]}.`
}
