/**
 * Handsel as an ERC-8195 evaluator — the pure core.
 *
 * TaskMarket (ERC-8195, `daydreamsai/taskmarket-contracts`) has an evaluator
 * slot: a requester calls `assignEvaluator(taskId, evaluator, stakeAmount, …)`,
 * and that evaluator later calls
 *
 *   evaluate(taskId, verdictType, score, confidence, evidenceHash, awards)
 *
 * `evidenceHash` is a `bytes32` the protocol stores and never interprets. That
 * is exactly the shape of a Handsel work proof's `contentHash`, so a Handsel
 * verdict can be anchored on someone else's market with no new field, no
 * contract change, and no request that they trust us — a reader recovers the
 * EIP-712 signer themselves (`docs/verifying-proofs.md`).
 *
 * **This module deliberately does not send a transaction.** Every
 * state-changing TaskMarket call is gated on `_requireForwarder`, and their
 * forwarder only accepts calls from one authorised relay server, so the
 * submitting party is always theirs. What we own is the *decision*: this maps a
 * Handsel grade onto the exact arguments `evaluate()` takes, and — more
 * importantly — decides when there is no verdict to submit at all.
 *
 * Three properties carry the design:
 *
 * 1. **A verdict that cannot be REJECT is not a verdict.** The stub this
 *    replaces (`daydreamsai/skills-market#58`) returned a hardcoded pass. An
 *    evaluator whose only output is APPROVE is a check that cannot fail, and
 *    the stake behind it buys nothing. `passed: false` reaching REJECT is the
 *    property `tests/taskmarket-evaluator.test.ts` pins first.
 *
 * 2. **A timing state must never collapse into a validity state.** The grader
 *    returns `passed: true | false | null`, and `null` means *not graded* — no
 *    LLM key, provider error, our outage. APPROVE on null is the stub's bug
 *    wearing a different hat; REJECT on null bills a worker for our downtime.
 *    So null submits nothing, and the protocol's own fallback runs:
 *    `evaluatorTimeout()` forfeits OUR stake and hands the task back to the
 *    requester as PendingApproval. The party who failed to answer pays.
 *
 * 3. **No evidence, no verdict.** An APPROVE is only worth anchoring if the
 *    `evidenceHash` resolves to a signed proof a third party can check without
 *    us. If proof issuance failed, we are back in case 2 — we eat the stake
 *    rather than assert a pass nobody can verify.
 */

/** `ITMPCore.VerdictType` — ordering is the enum's, not ours:
 *  `enum VerdictType { APPROVE, REJECT, PARTIAL }`
 *  (`src/interfaces/ITMPCore.sol:173`). Encoded as uint8 on the wire. */
export const VERDICT_APPROVE = 0
export const VERDICT_REJECT = 1
export const VERDICT_PARTIAL = 2

export type VerdictType = typeof VERDICT_APPROVE | typeof VERDICT_REJECT | typeof VERDICT_PARTIAL

/** `score` and `confidence` are `uint16` with no unit fixed by the spec. We
 *  publish basis points so a 0–100 grade keeps two decimals of headroom, and
 *  10000 stays inside uint16. Stated here because a bare number on-chain is
 *  meaningless without the scale that produced it. */
export const SCORE_SCALE_BPS = 10_000

/** `ITMPCore.Award` — `{ address worker; uint256 amount; uint16 rank; }`.
 *  `amount` is a decimal string of USDC base units (6 decimals): the caller
 *  owns the escrow arithmetic, we only refuse to exceed it. */
export interface EvaluatorAward {
  worker: `0x${string}`
  amount: string
  rank: number
}

/** The exact argument list of `EvaluatorFacet.evaluate`, in order. */
export interface EvaluateArgs {
  verdictType: VerdictType
  score: number
  confidence: number
  evidenceHash: `0x${string}`
  awards: EvaluatorAward[]
}

/** What Handsel's grader actually returns. `passed: null` is not a soft fail —
 *  it is the absence of a grade (see `lib/text-grading.ts`). */
export interface HandselGrade {
  passed: boolean | null
  reason: string
  /** Present only when a signed proof was issued and stored. */
  proof?: { id: string; contentHash: string; attester: string }
}

export interface VerdictInput {
  grade: HandselGrade
  /** Task escrow in USDC base units, as a decimal string. Awards may not exceed it. */
  rewardBaseUnits: string
  /** Winner(s). A single worker is the Claim/Pitch/Auction case; several is Bounty. */
  awards: EvaluatorAward[]
  /** 0..1. Absent means the grader gave no confidence signal, which is not the
   *  same as low confidence — we publish 0 and say so in the reason. */
  confidence?: number
  /** 0..1, the graded score if the lane produced one. Defaults from the verdict. */
  score?: number
}

export type EvaluatorDecision =
  /** Submit this to `evaluate()` through their relay. */
  | { submit: true; args: EvaluateArgs; reason: string }
  /** Submit nothing. `evaluatorTimeout()` is the protocol's own answer to an
   *  evaluator that does not answer, and it charges the silence to us. */
  | { submit: false; reason: string; fallback: 'evaluatorTimeout' }

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const UINT_RE = /^\d+$/

/** Clamp a 0..1 ratio into uint16 basis points. Non-finite input — NaN and
 *  ±Infinity alike — is 0, never NaN and never the maximum: clamping Infinity
 *  up to a full score would invent a 100% grade out of a parse failure, which
 *  is the same error as approving an ungraded deliverable, one field down. */
export function toBps(ratio: number | undefined): number {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return 0
  const bps = Math.round(ratio * SCORE_SCALE_BPS)
  if (bps <= 0) return 0
  return bps > SCORE_SCALE_BPS ? SCORE_SCALE_BPS : bps
}

/** Every reason an award list can be unusable. Returns null when it is fine. */
export function awardsProblem(awards: EvaluatorAward[], rewardBaseUnits: string): string | null {
  if (!UINT_RE.test(rewardBaseUnits)) return 'reward is not a base-unit integer'
  if (awards.length === 0) return 'no winner to pay'
  let total = 0n
  const seen = new Set<string>()
  for (const a of awards) {
    if (!ADDRESS_RE.test(a.worker)) return `award worker is not an address: ${a.worker}`
    const key = a.worker.toLowerCase()
    if (seen.has(key)) return `duplicate award worker: ${a.worker}`
    seen.add(key)
    if (!UINT_RE.test(a.amount)) return `award amount is not a base-unit integer: ${a.amount}`
    if (!Number.isInteger(a.rank) || a.rank < 0 || a.rank > 65535) return `award rank out of uint16 range: ${a.rank}`
    total += BigInt(a.amount)
  }
  if (total === 0n) return 'awards total zero'
  // The escrow is the ceiling. Overrunning it would revert on-chain anyway;
  // refusing here means we never ask their relay to broadcast a doomed call.
  if (total > BigInt(rewardBaseUnits)) return `awards (${total}) exceed task reward (${rewardBaseUnits})`
  return null
}

/**
 * Map a Handsel grade onto an `evaluate()` call — or onto the decision not to
 * make one. This is the whole trust surface of the integration, so it is a pure
 * function with no clock, no network, and no fallback that guesses.
 */
export function toEvaluateArgs(input: VerdictInput): EvaluatorDecision {
  const { grade, rewardBaseUnits, awards } = input

  // (2) No grade is not a bad grade. Neither branch of the enum is honest here.
  if (grade.passed === null || grade.passed === undefined) {
    return {
      submit: false,
      fallback: 'evaluatorTimeout',
      reason: `no verdict — grading did not run (${grade.reason || 'no reason given'}); the evaluator stake is forfeit rather than guessed`,
    }
  }

  // (1) The branch that makes the stake mean something.
  if (grade.passed === false) {
    return {
      submit: true,
      reason: grade.reason || 'deliverable did not satisfy the acceptance criteria',
      args: {
        verdictType: VERDICT_REJECT,
        score: toBps(input.score ?? 0),
        confidence: toBps(input.confidence),
        // A REJECT carries no proof — nothing passed, so there is nothing
        // signed to anchor. Zero is the protocol's "no evidence recorded".
        evidenceHash: `0x${'0'.repeat(64)}`,
        awards: [],
      },
    }
  }

  // (3) A pass without a verifiable anchor is an assertion, not evidence.
  const contentHash = grade.proof?.contentHash
  if (!contentHash || !BYTES32_RE.test(contentHash)) {
    return {
      submit: false,
      fallback: 'evaluatorTimeout',
      reason: 'no verdict — the deliverable passed but no signed work proof was issued, so there is no evidenceHash a third party could check',
    }
  }

  const problem = awardsProblem(awards, rewardBaseUnits)
  if (problem) {
    return { submit: false, fallback: 'evaluatorTimeout', reason: `no verdict — ${problem}` }
  }

  const total = awards.reduce((sum, a) => sum + BigInt(a.amount), 0n)
  const partial = total < BigInt(rewardBaseUnits)

  return {
    submit: true,
    reason: grade.reason || 'deliverable satisfies the acceptance criteria',
    args: {
      verdictType: partial ? VERDICT_PARTIAL : VERDICT_APPROVE,
      score: toBps(input.score ?? 1),
      confidence: toBps(input.confidence),
      evidenceHash: contentHash as `0x${string}`,
      awards,
    },
  }
}
