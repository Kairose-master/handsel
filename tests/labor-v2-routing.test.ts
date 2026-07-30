import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Does the app know which contract it is talking to?
 *
 * `lib/onchain/labor.ts` targets V1 and is correct for it — V1 is still live on
 * Sepolia. But every call site in the product goes through it, and three of its
 * functions disagree with V2 in ways that do not fail politely:
 *
 *   postJob    V2 takes a FOURTH argument and pulls `bounty + fee`. The V1
 *              encoding targets a selector V2 does not have, and an allowance of
 *              exactly the bounty reverts on any deployment with a fee.
 *   acceptJob  identical selector, so it encodes fine — and reverts anyway,
 *              because V2 pulls a bond and V1's call site sends no allowance.
 *              The supply side simply stops.
 *   readJobs   V2's getter returns FOURTEEN fields against this seven-field
 *              tuple. That does not throw; it produces numbers. And the
 *              `?? 'Open'` fallback turns V2's eighth status into `Open`, which
 *              puts every timeout-settled job back on the board as open work.
 *
 * These are source assertions because the alternative is a chain. What they pin
 * is that a decision is MADE — the file used to carry a comment saying this
 * would be "wrong the moment the address changes", and a warning is not a
 * mechanism.
 */

const code = (p: string) =>
  readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const labor = () => code('lib/onchain/labor.ts')
const laborV2 = () => code('lib/onchain/labor-v2.ts')

describe('every V1 entry point that V2 changed asks first', () => {
  for (const fn of ['postJob', 'acceptJob'] as const) {
    it(`${fn} routes to the V2 implementation`, () => {
      // The guard has to sit INSIDE the function, not merely somewhere in the
      // file — so match from the declaration to the branch.
      expect(labor()).toMatch(new RegExp(`export async function ${fn}[\\s\\S]{0,600}isV2Market`))
      expect(labor()).toMatch(new RegExp(`export async function ${fn}[\\s\\S]{0,600}${fn}V2`))
    })
  }

  it('the read path routes too, because a mis-decode is silent', () => {
    expect(labor()).toMatch(/function fetchJobsUncached[\s\S]{0,600}isV2Market/)
    expect(labor()).toMatch(/function fetchJobsUncached[\s\S]{0,600}readJobsV2/)
  })

  it('the V1 encodings are still there, unchanged, below the branch', () => {
    // V1 is live on Sepolia holding real testnet escrow. Routing must ADD a
    // path, never replace one.
    expect(labor()).toMatch(/functionName: 'postJob',\s*args: \[amount, BigInt\(minScore\), specHash\]/)
  })
})

describe('what the V2 writes must get right', () => {
  it('postJob approves postCost, not the bounty', () => {
    const src = laborV2()
    expect(src).toMatch(/functionName: 'postCost'/)
    // Read from the contract rather than recomputed. Same rule the contract
    // states for releaseSplit: a caller that reimplements the arithmetic is a
    // caller that can get it wrong — and here getting it wrong means every
    // posting in the market fails.
    expect(src).not.toMatch(/flatFee\s*\+/)
  })

  it('postJob passes a delivery window inside the contract bounds', () => {
    const src = laborV2()
    // Clamped against values READ from the contract. The bounds became
    // deployment-chosen when Config replaced the constants, so a number
    // compiled in here is one that is correct against one deployment and
    // reverts BadWindow against the next.
    expect(src).toMatch(/MIN_DELIVERY_WINDOW/)
    expect(src).toMatch(/MAX_DELIVERY_WINDOW/)
    expect(src).toMatch(/Math\.min\(Math\.max\(/)
  })

  it('acceptJob approves the bond', () => {
    const src = laborV2()
    expect(src).toMatch(/export async function acceptJobV2[\s\S]{0,900}functionName: 'bondFor'/)
    expect(src).toMatch(/export async function acceptJobV2[\s\S]{0,1400}functionName: 'approve'/)
  })

  it('sends the approval together with the call that consumes it', () => {
    // Two SEPARATE sends would leave a standing allowance to the market if the
    // second never landed — an authorisation nobody asked for, on a contract
    // holding everyone's escrow. So they must travel in one call to the sender.
    //
    // This used to assert `encodeCalls([`, the KERNEL batch encoder, and that is
    // precisely what made these two functions kernel-only: in EOA mode there is
    // no bundler, so posting a job and accepting a job were both impossible while
    // every other market write worked. They now go through `sendAgentCalls`,
    // which batches atomically in kernel mode and sends in order in EOA mode.
    //
    // The concern above survives that fallback only partly, and the honest
    // statement is that in EOA mode these are NOT atomic. Ordering is what keeps
    // it safe: approve first, for exactly the amount the next call spends, so a
    // failure in between leaves a recoverable allowance rather than lost funds.
    // Atomic where the transport allows it and ordered where it does not beats
    // not working at all.
    const src = laborV2()
    for (const fn of ['postJobV2', 'acceptJobV2']) {
      const body = src.slice(src.indexOf(`function ${fn}`))
      const send = body.indexOf('sendAgentCalls(')
      expect(send, `${fn} must send through sendAgentCalls`).toBeGreaterThan(-1)
      const args = body.slice(send, send + 1600)
      const approveAt = args.indexOf("functionName: 'approve'")
      const consumeAt = args.search(/functionName: '(postJob|acceptJob)'/)
      expect(approveAt, `${fn} must approve`).toBeGreaterThan(-1)
      expect(consumeAt, `${fn} must call the market`).toBeGreaterThan(-1)
      expect(approveAt, `${fn} must approve BEFORE it spends`).toBeLessThan(consumeAt)
    }
  })
})

describe('the eighth status survives the trip', () => {
  it('is in the type every consumer reads', () => {
    // Widened rather than cast. `Expired` means a deadline settled the job and
    // NOBODY judged the work — distinct from Completed (someone said it was
    // good) and Refunded (someone said it was not). A reader that collapses it
    // into either is reporting a verdict that was never reached.
    expect(labor()).toMatch(/status: \(typeof JOB_STATUS\)\[number\] \| 'Expired'/)
  })

  it('is never produced by the V1 fallback that would hide it', () => {
    // V1's decoder ends `?? 'Open'`. Against a V2 contract that is the line that
    // would relist settled jobs as available work — which is why the V2 branch
    // returns before reaching it, and why readJobsV2 throws on an unknown status
    // instead of defaulting.
    expect(laborV2()).toMatch(/unknown status index/)
    expect(laborV2()).not.toMatch(/\?\? 'Open'/)
  })
})

/**
 * The brief has to survive the trip too, and it did not.
 *
 * `specHash` is not a display field. It is the ONLY link between a job on chain
 * and its title, description and acceptance criteria in `job_specs` — every
 * reader does `specByHash.get(j.specHash)`. The V2 decoder skipped it and the
 * V1-shaped mapping filled in `specHash: '0x'`, which matches no row.
 *
 * So the first job posted to a V2 market escrowed 0.1 USDC correctly, appeared
 * in the feed correctly, and read back as:
 *
 *   title: "Untitled job", description: null, acceptanceCriteria: null
 *
 * A market in which no worker can see what the work is. The comment that stood
 * there justified it as "the fields exist on-chain and can be added when a
 * caller needs them", which is sound for `minScore` — a value the UI shows — and
 * unsound for a join key: zeroing a key does not degrade one field, it detaches
 * the whole record.
 *
 * All three values were already in the tuple the contract returns. Indices
 * verified against the ABI's own named outputs and against job #1 on Base
 * Sepolia.
 */
describe('the brief survives the trip', () => {
  it('decodes the join key, and does not invent one', () => {
    const src = laborV2()
    expect(src).toMatch(/specHash: raw\[5\] as Hex/)
    expect(src).toMatch(/minScore: Number\(raw\[3\]\)/)
    expect(src).toMatch(/resultHash: raw\[6\] as Hex/)
  })

  it('carries it through the V1-shaped mapping instead of blanking it', () => {
    const src = labor()
    // The exact line that detached every brief.
    expect(src).not.toMatch(/specHash: '0x' as Hex/)
    expect(src).not.toMatch(/minScore: 0,/)
    expect(src).toMatch(/specHash: j\.specHash/)
    expect(src).toMatch(/minScore: j\.minScore/)
  })

  it('puts the key on the type, so a future decoder cannot quietly drop it', () => {
    // A `V2Job` without specHash compiles fine at the mapping site as long as
    // the mapping supplies a literal — which is how this survived. On the type,
    // omitting it is a type error.
    expect(laborV2()).toMatch(/specHash: Hex/)
    expect(laborV2()).toMatch(/minScore: number/)
  })
})
