import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { keccak256, concat, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * The recovery script must derive the SAME address the app uses.
 *
 * Agent addresses are EOAs derived from the owner key:
 *
 *     agentKey = keccak256(ownerKey ++ toHex(agentId))
 *
 * `lib/onchain/account.ts` uses that to transact; `scripts/recover-agent-funds.mjs`
 * uses it to reach anything the app cannot — ETH, a stray token, anything that
 * is not the one USDC the withdrawal path knows about.
 *
 * If the two ever drift, the script does not error. It reports the balances of
 * an address nobody has ever used, which reads as **"your funds are gone"** —
 * a worse outcome than crashing, and the reason this is pinned rather than
 * trusted.
 */

const app = readFileSync('lib/onchain/account.ts', 'utf8')
const script = readFileSync('scripts/recover-agent-funds.mjs', 'utf8')

/** A key that funds nothing, fixed so the expectation is reproducible. */
const OWNER = ('0x' + '11'.repeat(32)) as `0x${string}`

describe('the app and the recovery script agree on an agent address', () => {
  it('both spell the derivation the same way', () => {
    const shape = /keccak256\(concat\(\[\s*ownerKey(\(\))?,\s*toHex\(agentId\)\s*\]\)\)/
    expect(app, 'lib/onchain/account.ts changed its derivation').toMatch(shape)
    expect(script, 'scripts/recover-agent-funds.mjs changed its derivation').toMatch(shape)
  })

  it('produces a stable address for a fixed key and id', () => {
    // Pinned so a viem change to keccak256/concat/toHex semantics — any of
    // which would silently move every agent address — fails here rather than
    // in production.
    const derived = privateKeyToAccount(keccak256(concat([OWNER, toHex('agt_example')])))
    expect(derived.address).toBe('0x0Ae75cBD79F1f382d5C2D525D2c192BF945BE805')
  })

  it('depends on the agent id, so two agents are two addresses', () => {
    const a = privateKeyToAccount(keccak256(concat([OWNER, toHex('agt_a')]))).address
    const b = privateKeyToAccount(keccak256(concat([OWNER, toHex('agt_b')]))).address
    expect(a).not.toBe(b)
  })

  it('depends on the owner key, so a rotated key is a different fleet', () => {
    // Worth stating plainly: rotating AGENT_OWNER_PRIVATE_KEY does not move the
    // agents, it ORPHANS them. The old key is the only way back to their funds.
    const other = ('0x' + '22'.repeat(32)) as `0x${string}`
    const a = privateKeyToAccount(keccak256(concat([OWNER, toHex('agt_a')]))).address
    const b = privateKeyToAccount(keccak256(concat([other, toHex('agt_a')]))).address
    expect(a).not.toBe(b)
  })
})

describe('the recovery script is read-only unless told otherwise', () => {
  it('sends nothing without an explicit --send flag', () => {
    // It reaches into every agent wallet the operator owns. Defaulting to a
    // sweep would make a fat-fingered invocation a money movement.
    expect(script).toMatch(/if \(!sendEthTo && !sendUsdcTo\)/)
    expect(script).toContain('Read-only')
  })

  it('keeps enough ETH back to pay for its own sweep', () => {
    // balance − gas, with headroom: a price tick between estimate and send
    // would otherwise make the transaction unaffordable and revert, leaving
    // the operator convinced the sweep does not work.
    expect(script).toMatch(/21_000n \* gasPrice \* 2n/)
    expect(script).toMatch(/remaining - cost/)
  })
})
