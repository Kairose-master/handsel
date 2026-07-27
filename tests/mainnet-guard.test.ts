import { describe, expect, it } from 'vitest'
import { formatBlockers, mintBlocker, realMoneyBlockers, type RealMoneyConfig } from '@/lib/onchain/mainnet-guard'

const ready: RealMoneyConfig = {
  isRealMoney: true,
  escrowTokenAddress: '0x0000000000000000000000000000000000000001',
  laborMarketAddress: '0x0000000000000000000000000000000000000002',
  paymasterMeteredAck: true,
  faucetEnabled: false,
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
    })
    expect(all).toHaveLength(4)
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

describe('formatBlockers', () => {
  it('says so plainly when there is nothing wrong', () => {
    expect(formatBlockers([])).toBe('no blockers')
  })

  it('lists codes for a log line', () => {
    expect(formatBlockers(realMoneyBlockers({ ...ready, faucetEnabled: true }))).toBe('faucet-enabled')
  })
})
