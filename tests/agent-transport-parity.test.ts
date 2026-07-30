import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Every agent write goes through the mode-aware sender. No exceptions.
 *
 * `sendAgentCall` handles both transports: a sponsored UserOp in kernel mode, a
 * plain transaction in EOA mode. It also carries the gas fuse. Two writes needed
 * to send TWO calls together — `approve` + `postJob`, `approve` + `acceptJob` —
 * and because `sendAgentCall` took a single call, both reached past it to
 * `getAgentKernel` + `sendUserOperation`.
 *
 * That made **posting a job** and **accepting a job** the only two labour-market
 * writes that were kernel-only. On this deployment, which is EOA, there is no
 * bundler and no paymaster, so both were structurally impossible — while submit,
 * approve, dispute, cancel, withdraw and every token transfer worked normally.
 *
 * The symptom was therefore not "on-chain is broken". It was "I cannot post a
 * job and I cannot mine", with everything else fine, and no error to read
 * because the failure was in the half of the code the fuse never saw either:
 * neither path called `decideSponsorship` or `recordGasSpend`, so the two most
 * expensive operations in the system were the two the budget could not count.
 *
 * `sendAgentCalls` is now the single door, and this test is what keeps the next
 * batch write from going around it.
 */

const FILES = [
  'lib/onchain/labor.ts',
  'lib/onchain/labor-v2.ts',
  'lib/onchain/credit.ts',
  'lib/onchain/verified.ts',
  'lib/onchain/treasury.ts',
  'lib/onchain/erc8004.ts',
  'lib/onchain/governance-poll.ts',
]

/** Source with comments stripped — a rule must not be satisfied by prose that
 *  merely mentions the thing it forbids. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

describe('the labour market never reaches past the mode-aware sender', () => {
  it('reads the files — the parse is the test here', () => {
    expect(code('lib/onchain/labor-v2.ts')).toContain('postJobV2')
    expect(code('lib/onchain/labor-v2.ts')).toContain('acceptJobV2')
  })

  it('posts and accepts through sendAgentCalls', () => {
    const v2 = code('lib/onchain/labor-v2.ts')
    // Both batch writes, both through the shared door.
    expect((v2.match(/sendAgentCalls\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(code('lib/onchain/labor.ts')).toContain('sendAgentCalls(')
  })

  it('no longer drives the kernel directly from either labour-market file', () => {
    // The precise defect. `sendUserOperation` belongs in account.ts and nowhere
    // else — it is the kernel-only call, so its presence outside that file IS
    // the bug, regardless of which function contains it.
    for (const file of ['lib/onchain/labor.ts', 'lib/onchain/labor-v2.ts']) {
      const src = code(file)
      expect(src, `${file} must not build UserOps itself`).not.toContain('sendUserOperation')
      expect(src, `${file} must not use the kernel client`).not.toContain('getAgentKernel')
    }
  })

  it('keeps every other on-chain write on the sender too', () => {
    // Not a new rule — these already complied. Pinned so the compliant set
    // cannot quietly shrink.
    for (const file of FILES) {
      const src = code(file)
      if (!/sendAgentCall/.test(src)) continue
      expect(src, `${file} mixes transports`).not.toContain('sendUserOperation')
    }
  })
})

describe('the batch sender preserves what the single sender guaranteed', () => {
  const account = code('lib/onchain/account.ts')

  it('routes the single-call helper through the batch one', () => {
    // One implementation, so the fuse and the receipt-waiting cannot drift
    // between them.
    expect(account).toMatch(/sendAgentCall\([\s\S]{0,400}?return sendAgentCalls\(agentId, \[call\], opts\)/)
  })

  it('still consults the gas fuse and records the spend', () => {
    expect(account).toContain('decideSponsorship')
    expect(account).toContain('recordGasSpend')
  })

  it('sends sequentially in EOA mode, where there is nothing to batch with', () => {
    expect(account).toContain('sendSequentially')
    // The LAST hash is the meaningful one: an approve's hash tells a caller
    // nothing, and returning it would make a successful post look like it
    // landed somewhere else. So `hash` is overwritten on every iteration and
    // whatever the final call produced is what is returned.
    expect(account).toMatch(/for \(const \[i, c\] of calls\.entries\(\)\)/)
    expect(account).toMatch(/hash = await sendEoaCall\(agentId, c, lane\)/)
    expect(account).toMatch(/return hash as Hex/)
  })

  it('batches into one UserOp in kernel mode', () => {
    expect(account).toMatch(/encodeCalls\(\s*calls\.map\(/)
  })

  it('refuses an empty batch rather than returning a meaningless hash', () => {
    expect(account).toContain("throw new Error('sendAgentCalls: nothing to send')")
  })

  it('retries the dependent calls, and only those', () => {
    // A sequential batch on a load-balanced RPC has a race an atomic UserOp does
    // not: the approve is mined and its receipt awaited, then the next request
    // lands on a node that has not seen that block, reads the allowance as zero
    // and reverts the gas estimate. Seen once on `postJob`, with the allowance
    // already correct on chain and the same call simulating fine a minute later.
    //
    // The FIRST call depends on nothing earlier in the batch, so a revert there
    // is always real and must surface at once. Retrying it would delay a genuine
    // error for no possible benefit.
    expect(account).toMatch(/const attempts = i === 0 \? 1 : 3/)
    // And a retry can only convert a propagation lag into a success — never a
    // real revert, which still throws once the attempts are spent.
    expect(account).toMatch(/if \(attempt >= attempts\) throw error/)
  })
})

describe('the transport is visible from outside', () => {
  it('reports the account mode on /api/capabilities', () => {
    // It appeared in no page, no endpoint and no log. `agentAccounts: on` was
    // true the whole time the two writes were impossible, because that answers
    // a question one layer above the one that mattered.
    const route = code('app/api/capabilities/route.ts')
    expect(route).toContain('agentAccountMode')
    expect(route).toContain('bundlerConfigured')
    expect(route).toContain('marketIsV2')
  })

  it('reports presence of the bundler, never its URL', () => {
    // The ZeroDev RPC carries an API key and this endpoint is public.
    const route = code('app/api/capabilities/route.ts')
    expect(route).toContain('Boolean(onchainEnv.zerodevRpc)')
    expect(route).not.toMatch(/zerodevRpc\s*,/)
  })
})

describe('self-pay in kernel mode drops the paymaster, not the identity', () => {
  const account = code('lib/onchain/account.ts')

  it('offers self-pay on the user lane and never on the keeper lane', () => {
    // The keeper reserve exists so the permissionless exits keep freeing other
    // people's escrow when the user lane is drained. If keeper ops fell back to
    // agent ETH, a drained reserve would quietly become the agents' problem
    // instead of surfacing as the operator's.
    //
    // The one exception is PAYMASTER_DISABLED, where there is no reserve to
    // drain and refusing keeper work would just stop the exits outright. The
    // rule this asserts is the lane rule, so it is written as the lane rule
    // plus that exception rather than as an exact line — see
    // tests/no-paymaster-mode.test.ts for the exception's own coverage.
    expect(account).toMatch(/canSelfPay: PAYMASTER_DISABLED \|\| lane === 'user',/)
  })

  it('self-pays by removing the paymaster, from the same kernel account', () => {
    // The earlier bug, and why the fix is not "route elsewhere": sending from the
    // agent's EOA changes WHICH ACCOUNT ACTS, not who pays gas, so the call fails
    // on NotWorker or an allowance with nothing naming a budget. An unsponsored
    // UserOp keeps the sender and moves the cost.
    expect(account).toMatch(/getAgentKernel\(agentId, \{ sponsored \}\)/)
    expect(account).toMatch(/export async function getAgentKernel\(agentId: string, opts: \{ sponsored\?: boolean \} = \{\}\)/)
    // The paymaster is attached conditionally — its absence IS the mechanism.
    // WHICH paymaster is no longer fixed (see lib/onchain/paymaster.ts), so this
    // pins the conditional rather than the vendor; the choice has its own tests.
    expect(account).toMatch(/\.\.\.\(sponsored[\s\S]{0,200}paymasterClient\(\)/)
  })

  it('does not meter an op the operator is not paying for', () => {
    // requireSponsoredOp bounds sponsored spend. Charging the self-pay fallback
    // against it would make exhaustion permanent: the escape hatch gated by the
    // thing it escapes.
    expect(account).toMatch(/if \(sponsored\) \{[\s\S]{0,200}requireSponsoredOp\(agentId\)/)
  })

  it('bills the ledger only when sponsored', () => {
    expect(account).toMatch(/if \(sponsored\) \{[\s\S]{0,400}recordGasSpend\(lane, agentId/)
  })

  it('refuses with an actionable message when the account cannot self-pay', () => {
    // ensureAgentGas cannot fund this: it spends the ORACLE's ether and is gated
    // by the same budget, so it would refuse exactly when self-pay is needed —
    // and if it did not, self-pay would be operator-funded, which is sponsorship
    // under another name and would make the budget unenforceable.
    //
    // So the balance is checked here, not left to the bundler, whose answer to an
    // underfunded sender is an AA21 that nobody reads as "fund this address".
    expect(account).toMatch(/cannot self-pay: kernel account/)
    expect(account).toMatch(/AGENT_GAS_FLOOR/)
    expect(account).not.toMatch(/if \(!sponsored\) await ensureAgentGas/)
  })

  it('keeps nonce serialization on both funding paths', () => {
    // A property of the ACCOUNT, not of who pays: two concurrent ops from one
    // smart account collide on nonce (AA25) regardless of funding.
    expect(account).toMatch(/serializedSend\(address/)
  })

  it('still refuses a top-up nowhere, in either mode', () => {
    // ensureAgentGas passes canSelfPay: false because the account being topped up
    // is by definition the one with no ether. Mode-independent.
    expect(account).toMatch(/canSelfPay: false/)
  })
})

describe('the deploy doc and the fuse describe the same behaviour', () => {
  it('states the kernel-mode prerequisite the code enforces', () => {
    // The doc orders three fuses and says the first "degrades to self-pay. The
    // market keeps working." That is now true in BOTH modes — but kernel mode
    // reaches it by dropping the paymaster, which only works if the kernel account
    // holds a little ETH, and nothing tops that up. A deploy document that
    // promises graceful degradation without naming its prerequisite is read once,
    // on the day it matters, and believed.
    const doc = readFileSync('docs/mainnet-deploy.md', 'utf8')
    expect(doc).toMatch(/kernel account[s]? need[s]? a small ETH float/i)
    expect(doc).toMatch(/drops the paymaster/i)
    // And it must not still claim the old, now-fixed limitation.
    expect(doc).not.toMatch(/kernel mode has no[\s>]+graceful degradation/i)
    expect(doc).not.toMatch(/not production-ready on this point/i)
  })
})
