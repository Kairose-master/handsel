/**
 * Saying so when the chain's commitment is not the artifact that got paid.
 *
 * `submitWork` writes `resultHash = keccak256(output)` and the contract has no
 * second submission — `Status.Accepted` is required and the job is `Submitted`
 * by then. The grading retry loop was built around that (lib/grading-retry.ts:
 * grade first, submit the attempt that settles). **The peer-review revision
 * loop was not**, and on 2026-09-02 04:19Z the office-harness session watched
 * it happen live: a revision's `submitWork` reverted, the off-chain flow
 * carried on, and the job settled with the chain still committed to the
 * pre-revision text.
 *
 * The blast radius is narrower than it first looks — `lib/attestation.ts` and
 * `lib/work-proof-store.ts` build a proof from the stored deliverable, not
 * from the chain's hash, so nothing in this codebase currently reports the
 * stale value as if it were the artifact.
 *
 * It is still exactly the wrong kind of quiet. The product's claim is that a
 * deliverable is *verifiable*, and the way an outsider verifies is to hash
 * what they were given and compare it against the chain. That check now fails
 * on any revised job, and it fails looking like the worker substituted the
 * work.
 *
 * Fixing it properly needs a contract that accepts a second submission, which
 * is a redeploy. Until then the honest thing is available and cheap: **record
 * the divergence and publish it**, so a verifier sees "revised after
 * submission, chain holds the first hash" instead of an unexplained mismatch.
 * A mismatch that is disclosed is a fact about the process; the same mismatch
 * undisclosed is indistinguishable from fraud.
 *
 * Pure. The caller supplies the chain's value and the text that was paid for.
 */
import { keccak256, toHex } from 'viem'

/** Exactly what `lib/callback/labor-market.ts` commits, so the two cannot
 *  drift into hashing different things and reporting a false divergence. */
export function resultHashOf(output: string): `0x${string}` {
  return keccak256(toHex(output || '(empty output)'))
}

export type CommitmentStatus =
  /** The chain's hash is the artifact that settled. */
  | 'match'
  /** The artifact changed after `submitWork`; the chain holds the earlier one. */
  | 'diverged'
  /** Nothing was committed on chain, or nothing was stored off it. Not a
   *  divergence — an absence, and reporting it as a mismatch would accuse
   *  somebody of something that did not happen. */
  | 'unknown'

export type Commitment = {
  status: CommitmentStatus
  /** What the chain says. */
  onchain: string | null
  /** What the delivered artifact actually hashes to. */
  actual: string | null
  /** One line for a proof or a job page. Null when there is nothing to say. */
  note: string | null
}

const EMPTY_HASH = `0x${'0'.repeat(64)}`

export function commitmentFor(input: {
  onchainResultHash: string | null | undefined
  acceptedOutput: string | null | undefined
}): Commitment {
  const onchain = input.onchainResultHash && input.onchainResultHash !== EMPTY_HASH ? input.onchainResultHash.toLowerCase() : null
  const output = input.acceptedOutput
  if (!onchain || output === null || output === undefined || output === '') {
    return { status: 'unknown', onchain, actual: null, note: null }
  }
  const actual = resultHashOf(output).toLowerCase()
  if (actual === onchain) return { status: 'match', onchain, actual, note: null }
  return {
    status: 'diverged',
    onchain,
    actual,
    note:
      'Revised after submission. The contract has no second submitWork, so the on-chain resultHash is the ' +
      'FIRST submission; the deliverable published here is the revision that was reviewed and paid for. ' +
      'Hash the published text to verify it against this record, not against the chain.',
  }
}
