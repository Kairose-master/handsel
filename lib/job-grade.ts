/**
 * Whether a grading verdict is the JOB's verdict, or just an off-chain draft.
 *
 * A grade describes a submission. The settlement path attempts `submitWork`
 * first and then grades — but a failed `submitWork` is caught and logged rather
 * than fatal ("grading still runs on the raw output", `lib/callback/labor-market.ts`),
 * which is right for the worker's credit history: the runtime really did produce
 * that output and really was judged on it. It is NOT right for the job card,
 * because the chain has no submission to attach the verdict to.
 *
 * Observed on Base mainnet, job #3: the escrow sat `Accepted` with `resultHash`
 * zero — nothing had ever been submitted on-chain — while the board rendered a
 * red "Acceptance tests FAILED" on it. Two true facts, one false picture: a
 * reader concludes the deliverable arrived and lost, when the deliverable never
 * reached the contract at all.
 *
 * The same file already draws this exact line one layer down: it publishes an
 * ERC-8004 validation only `if (submitted)`, on the reasoning that otherwise it
 * "would publish an on-chain validation claim referencing a submission the chain
 * has no record of". The display had no such guard. This is it.
 *
 * `resultHash` is the exact signal rather than a heuristic on status: it is set
 * by `submitWork` and by nothing else, and it survives the V1/V2 facade
 * (`lib/onchain/labor.ts`), so one rule covers both contracts.
 */

/** True when `submitWork` actually landed for this job. */
export function submissionLanded(resultHash: string | null | undefined): boolean {
  if (!resultHash) return false
  const hex = resultHash.trim().toLowerCase().replace(/^0x/, '')
  // '' is V1's placeholder ('0x'); all-zero is the contract's untouched slot.
  return hex.length > 0 && /[1-9a-f]/.test(hex)
}

/**
 * The grade to SHOW for a job — null when the chain recorded no submission.
 *
 * Nulling rather than annotating, because a job card has one verdict slot and
 * the honest content of it here is nothing. The grade is not lost: it stays in
 * `job_specs.testResult` and in the worker's credit events, which is where a
 * judgement about the worker belongs.
 */
export function gradeForDisplay<T>(resultHash: string | null | undefined, testResult: T | null | undefined): T | null {
  return submissionLanded(resultHash) ? (testResult ?? null) : null
}
