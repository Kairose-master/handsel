import { explainOnchainError } from '@/lib/onchain/errors'

/**
 * Server actions that touch the on-chain layer must never let a raw
 * exception escape uncaught — Next.js redacts unhandled server errors in
 * production ("The specific message is omitted..."), which makes on-chain
 * failures (bad RPC, paymaster rejection, insufficient gas policy, bad key)
 * impossible for users or us to diagnose. Wrap the risky call and reduce it
 * to one controlled, safe sentence.
 *
 * What this does NOT do: make a thrown message reach the browser. Next.js
 * redacts EVERY error thrown from a server action in production, controlled
 * or not — the sentence built here survives only in the server log and in
 * development. To put it in front of the user, RETURN `.message` from the
 * action (`{ error }`) instead of `throw`ing the result; see
 * `sendFromTreasury` and docs/failure-modes.md §73. Callers that still
 * `throw asActionError(...)` get a readable server log and a digest in the UI.
 */
export function asActionError(error: unknown, context: string): Error {
  console.error(`[${context}]`, error)
  // The full error (multi-KB UserOperation dumps included) is in the server
  // log above; what reaches the user is the one sentence they can act on.
  return new Error(`${context}: ${explainOnchainError(error)}`)
}
