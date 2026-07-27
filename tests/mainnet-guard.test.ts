import { describe, expect, it } from 'vitest'
import {
  decimalsBlocker,
  formatBlockers,
  mintBlocker,
  realMoneyBlockers,
  type RealMoneyConfig,
} from '@/lib/onchain/mainnet-guard'

const ready: RealMoneyConfig = {
  isRealMoney: true,
  escrowTokenAddress: '0x0000000000000000000000000000000000000001',
  laborMarketAddress: '0x0000000000000000000000000000000000000002',
  paymasterMeteredAck: true,
  faucetEnabled: false,
  contractFeeBps: 200,
  offchainFeeBps: 0,
}

describe('a testnet is left alone', () => {
  it('has no blockers even when nothing is configured', () => {
    // Gating test deployments behind mainnet ceremony would only teach people
    // to set the acknowledgements without reading them.
    expect(
      realMoneyBlockers({
        isRealMoney: false,
        escrowTokenAddress: '',
        laborMarketAddress: '',
        paymasterMeteredAck: false,
        faucetEnabled: true,
        contractFeeBps: 0,
        offchainFeeBps: 200,
      }),
    ).toEqual([])
  })

  it('still allows minting test tokens', () => {
    expect(mintBlocker(false)).toBeNull()
  })
})

describe('real money: each prerequisite blocks on its own', () => {
  const codes = (c: Partial<RealMoneyConfig>) => realMoneyBlockers({ ...ready, ...c }).map((b) => b.code)

  it('passes when every prerequisite is met', () => {
    expect(realMoneyBlockers(ready)).toEqual([])
  })

  it('blocks an unset escrow token — there is no safe default', () => {
    expect(codes({ escrowTokenAddress: '' })).toEqual(['escrow-token-unset'])
  })

  it('blocks an unset labor market', () => {
    expect(codes({ laborMarketAddress: '' })).toEqual(['labor-market-unset'])
  })

  it('blocks an unacknowledged paymaster policy', () => {
    expect(codes({ paymasterMeteredAck: false })).toEqual(['paymaster-unmetered'])
  })

  it('blocks the practice-job faucet', () => {
    expect(codes({ faucetEnabled: true })).toEqual(['faucet-enabled'])
  })

  it('reports every blocker at once rather than one per deploy', () => {
    // Fixing one, redeploying, and discovering the next is how a checklist
    // becomes a week.
    const all = realMoneyBlockers({
      isRealMoney: true,
      escrowTokenAddress: '',
      laborMarketAddress: '',
      paymasterMeteredAck: false,
      faucetEnabled: true,
      contractFeeBps: 0,
      offchainFeeBps: 0,
    })
    // Five now: the four setup blockers plus no-fee-anywhere, which fires
    // because this fixture charges nothing on either side.
    expect(all).toHaveLength(5)
  })

  it('refuses minting before the gas is spent, not after the revert', () => {
    const blocker = mintBlocker(true)
    expect(blocker?.code).toBe('mint-not-available')
  })
})

describe('every blocker explains itself', () => {
  it('carries a detail long enough to act on', () => {
    const all = realMoneyBlockers({
      isRealMoney: true,
      escrowTokenAddress: '',
      laborMarketAddress: '',
      paymasterMeteredAck: false,
      faucetEnabled: true,
      contractFeeBps: 0,
      offchainFeeBps: 0,
    })
    for (const b of all) expect(b.detail.length).toBeGreaterThan(60)
  })

  it('names the environment variable the operator has to set', () => {
    const byCode = Object.fromEntries(
      realMoneyBlockers({ ...ready, escrowTokenAddress: '', paymasterMeteredAck: false }).map((b) => [b.code, b.detail]),
    )
    expect(byCode['escrow-token-unset']).toContain('USDC_ADDRESS')
    expect(byCode['paymaster-unmetered']).toContain('PAYMASTER_METERED')
  })
})

describe('decimalsBlocker — the compatibility check that has no symptom', () => {
  it('passes when the token scales the way the code assumes', () => {
    expect(decimalsBlocker(6, 6)).toBeNull()
  })

  it('catches a token whose decimals differ, in either direction', () => {
    expect(decimalsBlocker(18, 6)?.code).toBe('token-decimals-mismatch')
    expect(decimalsBlocker(2, 6)?.code).toBe('token-decimals-mismatch')
  })

  it('says how far wrong the amounts would be', () => {
    // 18 vs 6 is a factor of a trillion. An operator should not have to work
    // that out from "decimals mismatch".
    expect(decimalsBlocker(18, 6)?.detail).toContain('10^12')
  })

  it('treats an unreadable value as unknown, not as a mismatch', () => {
    // An RPC blip must not stop a working market — the same rule as
    // lib/onchain/labor-read.ts, where unknown and empty are different.
    expect(decimalsBlocker(null, 6)).toBeNull()
  })
})

describe('formatBlockers', () => {
  it('says so plainly when there is nothing wrong', () => {
    expect(formatBlockers([])).toBe('no blockers')
  })

  it('lists codes for a log line', () => {
    expect(formatBlockers(realMoneyBlockers({ ...ready, faucetEnabled: true }))).toBe('faucet-enabled')
  })
})

describe('the fee is collected exactly once', () => {
  it('blocks when the contract AND the platform both charge', () => {
    // lib/platform-fee.ts moves USDC out of the requester's account before the
    // escrow; the contract charges inside postJob. Both configured bills every
    // requester twice, and the off-chain half never appears in the contract's
    // accounting — so the overcharge surfaces as a complaint, not a number.
    const codes = realMoneyBlockers({ ...ready, contractFeeBps: 200, offchainFeeBps: 200 }).map((b) => b.code)
    expect(codes).toContain('fee-charged-twice')
  })

  it('says so when nothing charges anywhere', () => {
    // Not a typo-catcher — feeBps is immutable, so a deployment at zero can
    // never start charging, and the Sybil pricing argument is denominated in
    // that number.
    const codes = realMoneyBlockers({ ...ready, contractFeeBps: 0, offchainFeeBps: 0 }).map((b) => b.code)
    expect(codes).toContain('no-fee-anywhere')
  })

  it('is happy with the contract charging alone', () => {
    // The intended mainnet shape: the fee that still applies when an agent
    // posts with its own key instead of through the operator.
    expect(realMoneyBlockers({ ...ready, contractFeeBps: 200, offchainFeeBps: 0 })).toEqual([])
  })

  it('is happy with the platform charging alone', () => {
    // Still valid while every agent is operator-driven — which is today.
    expect(realMoneyBlockers({ ...ready, contractFeeBps: 0, offchainFeeBps: 200 })).toEqual([])
  })
})
