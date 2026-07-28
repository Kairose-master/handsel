import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { V2_HANDLES_IT } from '@/lib/dispute-policy'

/**
 * One policy for unresolved disputes, and a mechanism that keeps it that way.
 *
 * The defect this guards against was not a bug in any function. Every call site
 * did what it said. The problem was that FIVE of them independently decided the
 * same thing — `resolveDispute(id, false)`, refund the requester — and the one
 * that ran most often silently became the market's policy. The contract's own
 * `expireDispute` pays the WORKER after 14 days, deliberately, so that a failed
 * escalation cannot pay the party that escalated; `sweepDisputedJobs` ran every
 * five minutes and won by three orders of magnitude.
 *
 * A comment saying "do not resolve disputes off-chain on V2" would have the same
 * force as the comment that failed to stop the struct indices from shifting. So
 * this is a grep: a machine path that resolves a dispute must consult
 * `offchainMayResolveDisputes` in the same file, or this test names it.
 */

const MACHINE_DIRS = ['lib']

/** The human admin action is deliberately NOT gated. Removing the route would
 *  not remove the authority — the operator still holds a key that satisfies
 *  `msg.sender == arbiter` and can settle any job with `cast` in ten seconds.
 *  Pretending the centralization point is gone is the dishonest version of this
 *  change; it is documented instead, in lib/dispute-policy.ts. */
const ALLOWED_UNGATED = new Set([
  'lib/onchain/labor.ts', // the binding itself — it must not know about policy
  'lib/dispute-policy.ts', // the guard
])

/**
 * The one file allowed to resolve a dispute ON a V2 market.
 *
 * Every other machine path stands down there; this one is the replacement, and
 * it may only refund on grounds the requester did not author. Naming it here
 * rather than exempting it silently is the point — "exactly one sanctioned
 * resolver" is the property, and a second one appearing must be a decision
 * somebody makes on purpose.
 */
const V2_GATE = 'lib/dispute-gate.ts'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path)
  }
  return out
}

describe('nothing off-chain resolves a dispute without asking first', () => {
  const callers = MACHINE_DIRS.flatMap(walk)
    .filter((f) => !ALLOWED_UNGATED.has(f))
    .filter((f) => /\bresolveDispute\s*\(/.test(readFileSync(f, 'utf8')))

  it('finds the call sites at all — a grep that matches nothing proves nothing', () => {
    // If this drops to zero the suite below passes vacuously, which is exactly
    // how a guard rots into decoration.
    expect(callers.length).toBeGreaterThan(0)
  })

  it.each(callers.filter((f) => f !== V2_GATE))('%s consults offchainMayResolveDisputes', (file) => {
    expect(readFileSync(file, 'utf8')).toContain('offchainMayResolveDisputes')
  })

  it('has exactly one sanctioned V2 resolver, and it is the gate', () => {
    // The V1 paths stand down on V2; this is what replaces them. A second file
    // resolving disputes on V2 would recreate the original defect — several
    // independent deciders, with whichever runs most often becoming the policy.
    expect(callers).toContain(V2_GATE)
    const v2Resolvers = callers.filter((f) => !readFileSync(f, 'utf8').includes('offchainMayResolveDisputes'))
    expect(v2Resolvers).toEqual([V2_GATE])
  })

  it('the gate only ever refunds — it never resolves toward the worker', () => {
    // resolveDispute(id, true) and expireDispute(id) pay identical money, so
    // the gate has no reason to ever call the first: silence already does it.
    // A `true` here would be the gate claiming an authority it does not need.
    //
    // Read the CODE, not the file. The first version of this matched the
    // doc comment that explains why the `true` form is unnecessary — a guard
    // that fires on the sentence describing the rule is not checking the rule.
    const code = readFileSync(V2_GATE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).toMatch(/resolveDispute\([^)]*,\s*false\s*\)/)
    expect(code).not.toMatch(/resolveDispute\([^)]*,\s*true\s*\)/)
  })

  it('reports standing down, rather than looking like it found nothing', () => {
    // A sweep that returns 0 and a sweep that is not supposed to run read the
    // same in an ops log. They should not.
    expect(V2_HANDLES_IT).toMatch(/v2/i)
  })
})

describe('the V1 exits are still there', () => {
  // V1's contract has no timeout of ANY kind — postJob, acceptJob, submitWork,
  // approveJob, raiseDispute, resolveDispute, cancelJob is its whole external
  // surface. These sweeps are its only way out of Disputed and Accepted, and
  // lib/labor-settle.ts is byte-identical between the two checkouts. Deleting
  // rather than gating would produce escrow that no sweep, no timeout and no
  // contract function could ever move.
  it.each([
    ['lib/labor-settle.ts', 'sweepDisputedJobs'],
    ['lib/labor-settle.ts', 'returnDisputedJobToMarket'],
    ['lib/stale-claim.ts', 'reclaimAbandonedJobs'],
    ['lib/exhausted-refund.ts', 'refundExhaustedJobs'],
  ])('%s still exports %s', (file, fn) => {
    expect(readFileSync(file, 'utf8')).toContain(`export async function ${fn}`)
  })
})
