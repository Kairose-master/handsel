import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { HOUSE_FLOOR_USD, buildTreasury, type EscrowHealth } from '@/lib/platform-treasury'

const OK_ESCROW: EscrowHealth = { owedUsd: 100, heldUsd: 120, surplusUsd: 20 }
const t = (over: Partial<Parameters<typeof buildTreasury>[0]> = {}) =>
  buildTreasury({
    feeCredit: 12.5,
    feeRecipient: '0xfee',
    houseBalance: 200,
    houseAddress: '0xhouse',
    payToBalance: 40,
    payTo: '0xpay',
    escrow: OK_ESCROW,
    chargedUsd: 60,
    chargedCount: 20,
    externalBountyUsd: 2,
    ...over,
  })

describe('a figure that could not be read is not zero', () => {
  it('reports an unread balance as unavailable, with the reason', () => {
    // "$0.00 in the house wallet" is the alarm that external posting is about
    // to fail. An RPC timeout printing the same thing is a false alarm that
    // trains the owner to ignore the real one.
    const house = t({ houseBalance: null }).balances.find((b) => b.label.startsWith('House'))!
    expect(house.usd).toBeNull()
    expect(house.unavailable).toMatch(/could not be read/)
  })

  it('distinguishes unset from unreadable', () => {
    expect(t({ houseAddress: null, houseBalance: null }).balances[1].unavailable).toMatch(/not set/)
    expect(t({ payTo: null, payToBalance: null }).balances[2].unavailable).toMatch(/paywall is off/)
  })

  it('never alerts on a figure it did not read', () => {
    // Alerting on absence is how a dashboard teaches its reader to ignore it.
    expect(t({ houseBalance: null }).alerts).toEqual([])
    expect(t({ escrow: { owedUsd: null, heldUsd: null, surplusUsd: null } }).alerts).toEqual([])
  })
})

describe('what an operator has to act on', () => {
  it('warns before the house agent can no longer front a posting', () => {
    const a = t({ houseBalance: HOUSE_FLOOR_USD - 1 }).alerts
    expect(a.join(' ')).toMatch(/no longer front/)
  })

  it('counts the remaining postings at the configured bounty, not at a guess', () => {
    expect(t({ houseBalance: 6, externalBountyUsd: 2 }).alerts.join(' ')).toMatch(/3 more external postings/)
    expect(t({ houseBalance: 6, externalBountyUsd: null }).alerts.join(' ')).not.toMatch(/more external/)
  })

  it('treats a short contract as an incident, not a metric', () => {
    const a = t({ escrow: { owedUsd: 100, heldUsd: 90, surplusUsd: -10 } }).alerts
    expect(a.join(' ')).toMatch(/short \$10\.00/)
    expect(a.join(' ')).toMatch(/live incident/)
  })

  it('is quiet when everything is fine', () => {
    expect(t().alerts).toEqual([])
  })
})

describe('it reads and never signs', () => {
  it('reports the fee credit as collectable without offering to collect it', () => {
    // docs/fee-withdrawal.md refuses to automate this: it would put the key
    // that owns the whole fee stream into a server environment. The view adds
    // a number, not a button, and not one byte of key material.
    const r = t()
    expect(r.collectableUsd).toBe(12.5)
    expect(r.balances[0].hint).toMatch(/never swept/)
    expect(JSON.stringify(r)).not.toMatch(/privateKey|withdrawTo\(|signer/i)
  })

  it('separates what is collectable from what is locked in escrow', () => {
    // The one question the three scattered numbers could never answer
    // together: what is mine now versus what is somebody else's until a job
    // settles.
    const r = t()
    expect(r.collectableUsd).not.toBe(r.escrow.heldUsd)
    expect(r.escrow.owedUsd).toBe(100)
  })

  it('carries cumulative inflow separately from any balance', () => {
    // Charged is not held: money can be charged, spent on escrow, and
    // returned. Conflating them would overstate what is there.
    const r = t()
    expect(r.chargedUsd).toBe(60)
    expect(r.chargedCount).toBe(20)
  })
})

describe('who may see it', () => {
  const action = readFileSync('app/actions/platform-treasury.ts', 'utf8')
  const admin = readFileSync('lib/admin.ts', 'utf8')

  it('requires the treasury permission, not merely a session', () => {
    // The first draft gated on getSession() alone, which would have shown
    // every user the platform's fee balance, its house float, and how many
    // postings that float has left — an operational map of when the market is
    // cheapest to attack.
    expect(action).toContain("requirePermission('treasury')")
    expect(admin).toContain("'treasury'")
  })

  it('checks before reading anything', () => {
    const at = action.indexOf("requirePermission('treasury')")
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(action.indexOf('usdcBalanceOf'))
  })

  it('exposes no write path', () => {
    for (const forbidden of ['withdraw(', 'withdrawTo(', 'transferUsdc(', 'sendAgentCall']) {
      expect(action, forbidden).not.toContain(forbidden)
    }
  })
})
