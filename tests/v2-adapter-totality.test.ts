import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Nothing crosses the V2 → app boundary by accident.
 *
 * `readJobsV2` returns a `V2Job` (fourteen contract fields). The app reads
 * `OnchainJob`, a V1-shaped type. The adapter between them is where a strictly
 * richer type is made to pretend to be a poorer one, so information loss there
 * is not a possibility — it is the default, and every loss so far has been
 * found the same way: in production, one field at a time.
 *
 *   specHash    → `'0x'`   every V2 job read back as "Untitled job", because
 *                          specHash is the JOIN KEY for the brief, not a field
 *   minScore    → `0`      a gate the UI reported and the contract did not have
 *   deadlines   → dropped  the board offered Accept on a job the contract would
 *                          refuse, and the refusal arrived as a digest
 *
 * Three bugs, one hop, three separate discoveries. What they have in common is
 * that a literal satisfying a type is indistinguishable from a fact: `'0x'` IS
 * a Hex and `0` IS a number, so nothing could object.
 *
 * This test makes the loss a decision instead of a default. Every field on the
 * V2 side must either appear on the app side, or be named below with the reason
 * it does not. Adding a field to the contract and forgetting the app is a
 * failure here; deciding not to carry one is a two-line diff that says so.
 *
 * It cannot check that a carried field is carried CORRECTLY — `specHash:
 * j.specHash` and `specHash: '0x'` both name the field. That is what
 * tests/labor-v2-routing.test.ts pins, per field. This one guarantees no field
 * is ever silently absent from that conversation.
 */

const laborV2 = readFileSync('lib/onchain/labor-v2.ts', 'utf8')
const labor = readFileSync('lib/onchain/labor.ts', 'utf8')
const deadlines = readFileSync('lib/deadlines.ts', 'utf8')

/** Top-level property names of an exported type alias, comments stripped. */
function fieldsOf(src: string, typeName: string): string[] {
  const start = src.indexOf(`export type ${typeName}`)
  if (start === -1) throw new Error(`${typeName} not found`)
  const open = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const body = src
    .slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  // Depth 0 only: a nested object's keys are not fields of this type.
  const out: string[] = []
  let nest = 0
  for (const line of body.split('\n')) {
    const name = nest === 0 ? line.match(/^\s{2}([a-zA-Z_$][\w$]*)\??\s*:/) : null
    if (name) out.push(name[1])
    for (const ch of line) {
      if (ch === '{') nest++
      else if (ch === '}') nest--
    }
  }
  return out
}

/**
 * V2 fields deliberately not carried across, each with the reason.
 *
 * A name may only be added here together with its justification. "We do not use
 * it yet" is not one — that was the reasoning that kept `specHash` out ("the
 * fields exist on-chain and can be added when a caller needs them") and it cost
 * a market where no worker could read the work.
 */
const NOT_CARRIED: Record<string, string> = {
  // The four are collapsed into `deadline` + `lapsed`: which deadline governs a
  // job is a function of its status, so carrying all four would let a consumer
  // read the wrong one. The collapse is done in the adapter where the status is
  // known, and `lapsed` is the answer to the only question callers ask.
  openDeadline: 'collapsed into deadline+lapsed, selected by status',
  deliveryDeadline: 'collapsed into deadline+lapsed, selected by status',
  reviewDeadline: 'collapsed into deadline+lapsed, selected by status',
  disputeDeadline: 'collapsed into deadline+lapsed, selected by status',
}

describe('the V2 → app adapter loses nothing by accident', () => {
  const v2 = [...fieldsOf(laborV2, 'V2Job'), ...fieldsOf(deadlines, 'DeadlineJob')]
  const app = fieldsOf(labor, 'OnchainJob')

  it('parses both types — the parse is the test here', () => {
    // Every source-scanning assertion passes vacuously on a failed parse.
    expect(v2).toContain('specHash')
    expect(v2).toContain('payeeAmount')
    expect(v2).toContain('openDeadline')
    expect(app).toContain('specHash')
    expect(app).toContain('lapsed')
    expect(v2.length).toBeGreaterThan(12)
    expect(app.length).toBeGreaterThan(8)
  })

  it('accounts for every V2 field, as carried or as explicitly dropped', () => {
    const unaccounted = v2.filter((f) => !app.includes(f) && !(f in NOT_CARRIED))
    expect(
      unaccounted,
      `V2Job fields neither carried into OnchainJob nor listed in NOT_CARRIED ` +
        `with a reason: ${unaccounted.join(', ')}. Carry them, or add them to ` +
        `NOT_CARRIED explaining why the app does not need them.`,
    ).toEqual([])
  })

  it('keeps NOT_CARRIED honest — no stale entries', () => {
    // A field listed as dropped that IS carried means the reason is describing
    // something that stopped being true, which is how a comment becomes a lie.
    const contradictory = Object.keys(NOT_CARRIED).filter((f) => app.includes(f))
    expect(contradictory, `listed as not carried but present on OnchainJob`).toEqual([])
    const phantom = Object.keys(NOT_CARRIED).filter((f) => !v2.includes(f))
    expect(phantom, `listed as not carried but not a V2 field at all`).toEqual([])
  })

  it('requires a reason, not just a name', () => {
    for (const [field, reason] of Object.entries(NOT_CARRIED)) {
      expect(reason.length, `${field} needs a real reason`).toBeGreaterThan(20)
      // The one excuse that is banned, because it is the one that already cost a
      // production defect.
      expect(reason.toLowerCase()).not.toMatch(/not.*(used|needed) yet|when a caller needs/)
    }
  })

  it('carries the pull-payment fields, because withdrawal is a real step', () => {
    // payee/payeeAmount are how V2 answers "what does this job owe me". V2
    // settlement CREDITS rather than transfers, so these are the only on-chain
    // statement of an unpaid balance — verified live: job #1 settled to Expired
    // with totalEscrowed 0 while the contract still held 0.13 USDC owed.
    // Dropping them means the app cannot show, per job, what is waiting.
    expect(app).toContain('payee')
    expect(app).toContain('payeeAmount')
  })
})
