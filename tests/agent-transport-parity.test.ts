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

describe('self-pay is an EOA-mode concept only', () => {
  const account = code('lib/onchain/account.ts')

  it('never offers self-pay on the path that only kernel mode reaches', () => {
    // In EOA mode "pay your own gas" is coherent: same account, same assets. In
    // kernel mode the agent's USDC is at the KERNEL address and this fallback
    // sends from the EOA — a different account holding none of it. So it does not
    // change who pays gas, it changes WHICH ACCOUNT ACTS, and the failure lands
    // as an allowance error on the approve with nothing naming a gas budget.
    //
    // Two `canSelfPay: false` sites now: ensureAgentGas (the account being topped
    // up is by definition the one with no ether) and this one. The first attempt
    // wrote `lane === 'user' && agentAccountMode === 'eoa'` and tsc rejected it as
    // provably false — the EOA branch returns earlier, so this line is only ever
    // reached in kernel mode and the lane test was dead code dressed as a guard.
    expect((account.match(/canSelfPay: false/g) ?? []).length).toBe(2)
    expect(account).not.toMatch(/canSelfPay: lane === 'user',/)
  })

  it('would have fired on the very next mode switch', () => {
    // Not hypothetical. gas_spend is keyed by agentId and survives
    // re-provisioning; EOA top-ups bill AGENT_TOPUP_COST_USD against
    // AGENT_GAS_BUDGET_USD over a 24h window, and the top-up costs MORE than the
    // per-agent budget. So any agent that took one top-up in EOA mode is already
    // over budget the moment kernel mode starts.
    const budget = readFileSync('lib/gas-budget.ts', 'utf8')
    const topup = Number(budget.match(/AGENT_TOPUP_COST_USD', ([\d.]+)\)/)![1])
    const perAgent = Number(budget.match(/AGENT_GAS_BUDGET_USD', ([\d.]+)\)/)![1])
    expect(topup).toBeGreaterThan(perAgent)
    expect(budget).toContain('GAS_WINDOW_MS = 24 * 60 * 60 * 1000')
  })

  it('still allows self-pay for a top-up nowhere, in either mode', () => {
    // ensureAgentGas passes canSelfPay: false because the account being topped up
    // is by definition the one with no ether. That reasoning is mode-independent
    // and must not pick up the mode check.
    expect(account).toMatch(/canSelfPay: false/)
  })
})

describe('the deploy doc does not promise what the code stopped doing', () => {
  it('marks self-pay degradation as EOA-only', () => {
    // docs/mainnet-deploy.md orders three fuses and says the first "degrades to
    // self-pay. The market keeps working." That was true when written and is now
    // EOA-only, because canSelfPay is false on the kernel path. A deploy document
    // promising graceful degradation that the code no longer provides is worse
    // than no document: it is read once, on the day it matters.
    const doc = readFileSync('docs/mainnet-deploy.md', 'utf8')
    expect(doc).toMatch(/Step 1 is EOA-mode only/)
    // The phrase wraps across a line and a `> ` quote prefix, so match across both.
    expect(doc).toMatch(/kernel mode has no[\s>]+graceful degradation/i)
  })
})
