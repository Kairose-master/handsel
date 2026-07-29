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
