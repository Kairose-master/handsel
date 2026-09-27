import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENVELOPE_REAL_MONEY,
  DEFAULT_ENVELOPE_TESTNET,
  DENIAL_CODES,
  gradeInWords,
  gradeSpend,
  parseEnvelope,
  sumWindow,
  type SpendEnvelope,
} from '@/lib/spend-envelope'

/**
 * The spend envelope is graded immediately before a transfer is signed. These
 * tests are the contract: order of checks, the closed denial list, and that an
 * owner override never lifts a ceiling.
 */

const env: SpendEnvelope = { perTxMaxUsd: 5, dailyMaxUsd: 20, autoApproveMaxUsd: 1 }

describe('gradeSpend — verdict order', () => {
  it('ALLOW at or under the auto-approve line', () => {
    const g = gradeSpend(env, { kind: 'fund_usdc', amountUsd: 1, spentTodayUsd: 0 })
    expect(g).toEqual({ verdict: 'ALLOW', remainingTodayUsd: 19 })
  })
  it('ESCALATE over auto-approve but under both ceilings', () => {
    const g = gradeSpend(env, { kind: 'fund_usdc', amountUsd: 1.01, spentTodayUsd: 0 })
    expect(g.verdict).toBe('ESCALATE')
  })
  it('owner approval turns ESCALATE into ALLOW …', () => {
    const g = gradeSpend(env, { kind: 'fund_usdc', amountUsd: 4, spentTodayUsd: 0, ownerApproved: true })
    expect(g.verdict).toBe('ALLOW')
  })
  it('… but never lifts a ceiling', () => {
    expect(gradeSpend(env, { kind: 'fund_usdc', amountUsd: 5.01, spentTodayUsd: 0, ownerApproved: true })).toMatchObject({
      verdict: 'DENY',
      code: 'OVER_PER_TX_MAX',
    })
    expect(gradeSpend(env, { kind: 'fund_usdc', amountUsd: 3, spentTodayUsd: 18, ownerApproved: true })).toMatchObject({
      verdict: 'DENY',
      code: 'OVER_DAILY_MAX',
    })
  })
  it('per-tx is checked before daily', () => {
    const g = gradeSpend(env, { kind: 'bond', amountUsd: 6, spentTodayUsd: 19 })
    expect(g).toMatchObject({ verdict: 'DENY', code: 'OVER_PER_TX_MAX' })
  })
  it('daily counts what is already spent, exactly to the cent', () => {
    expect(gradeSpend(env, { kind: 'bond', amountUsd: 1, spentTodayUsd: 19 }).verdict).toBe('ALLOW')
    expect(gradeSpend(env, { kind: 'bond', amountUsd: 1, spentTodayUsd: 19.01 })).toMatchObject({ code: 'OVER_DAILY_MAX' })
  })
  it('refuses a zero, negative or NaN amount before anything else', () => {
    for (const amountUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(gradeSpend(env, { kind: 'fund_eth', amountUsd, spentTodayUsd: 0 })).toMatchObject({ code: 'INVALID_AMOUNT' })
    }
  })
  it('a kind outside the envelope is refused even at $0.01', () => {
    const narrow: SpendEnvelope = { ...env, kinds: ['bond'] }
    expect(gradeSpend(narrow, { kind: 'withdraw_eth', amountUsd: 0.01, spentTodayUsd: 0 })).toMatchObject({ code: 'KIND_NOT_ALLOWED' })
    expect(gradeSpend(narrow, { kind: 'bond', amountUsd: 0.01, spentTodayUsd: 0 }).verdict).toBe('ALLOW')
  })
  it('a destination allowlist is case-insensitive and ignored when the spend has no destination', () => {
    const dest = '0x' + 'ab'.repeat(20)
    const strict: SpendEnvelope = { ...env, destinations: [dest] }
    expect(gradeSpend(strict, { kind: 'fund_usdc', amountUsd: 0.5, destination: dest.toUpperCase().replace('0X', '0x'), spentTodayUsd: 0 }).verdict).toBe('ALLOW')
    expect(gradeSpend(strict, { kind: 'fund_usdc', amountUsd: 0.5, destination: '0x' + 'cd'.repeat(20), spentTodayUsd: 0 })).toMatchObject({
      code: 'DESTINATION_NOT_ALLOWED',
    })
    expect(gradeSpend(strict, { kind: 'bond', amountUsd: 0.5, spentTodayUsd: 0 }).verdict).toBe('ALLOW')
  })
})

describe('the denial list is closed', () => {
  it('every code a grade can return is in DENIAL_CODES', () => {
    const seen = new Set<string>()
    const probes = [
      gradeSpend(env, { kind: 'bond', amountUsd: 0, spentTodayUsd: 0 }),
      gradeSpend({ ...env, kinds: ['bond'] }, { kind: 'fund_eth', amountUsd: 1, spentTodayUsd: 0 }),
      gradeSpend({ ...env, destinations: ['0x' + '00'.repeat(20)] }, { kind: 'fund_eth', amountUsd: 1, destination: '0x' + '11'.repeat(20), spentTodayUsd: 0 }),
      gradeSpend(env, { kind: 'bond', amountUsd: 100, spentTodayUsd: 0 }),
      gradeSpend(env, { kind: 'bond', amountUsd: 5, spentTodayUsd: 19 }),
    ]
    for (const p of probes) if (p.verdict === 'DENY') seen.add(p.code)
    expect([...seen].sort()).toEqual([...DENIAL_CODES].sort())
  })
})

describe('parseEnvelope', () => {
  it('accepts the defaults and rejects an inverted ladder', () => {
    expect(parseEnvelope(DEFAULT_ENVELOPE_REAL_MONEY)).toEqual(DEFAULT_ENVELOPE_REAL_MONEY)
    expect(parseEnvelope(DEFAULT_ENVELOPE_TESTNET)).toEqual(DEFAULT_ENVELOPE_TESTNET)
    expect(parseEnvelope({ perTxMaxUsd: 10, dailyMaxUsd: 5, autoApproveMaxUsd: 1 })).toBeNull()
    expect(parseEnvelope({ perTxMaxUsd: 1, dailyMaxUsd: 5, autoApproveMaxUsd: 2 })).toBeNull()
  })
  it('rejects unknown kinds and malformed destinations', () => {
    expect(parseEnvelope({ ...env, kinds: ['bond', 'teleport'] })).toBeNull()
    expect(parseEnvelope({ ...env, destinations: ['not-an-address'] })).toBeNull()
    expect(parseEnvelope({ ...env, destinations: ['0x' + 'AB'.repeat(20)] })?.destinations).toEqual(['0x' + 'ab'.repeat(20)])
  })
  it('real-money defaults are strictly tighter than testnet', () => {
    expect(DEFAULT_ENVELOPE_REAL_MONEY.perTxMaxUsd).toBeLessThan(DEFAULT_ENVELOPE_TESTNET.perTxMaxUsd)
    expect(DEFAULT_ENVELOPE_REAL_MONEY.dailyMaxUsd).toBeLessThan(DEFAULT_ENVELOPE_TESTNET.dailyMaxUsd)
    expect(DEFAULT_ENVELOPE_REAL_MONEY.autoApproveMaxUsd).toBeLessThan(DEFAULT_ENVELOPE_TESTNET.autoApproveMaxUsd)
  })
})

describe('sumWindow', () => {
  it('counts only the trailing 24h', () => {
    const now = new Date('2026-09-27T12:00:00Z')
    const rows = [
      { amountUsd: 1, at: new Date('2026-09-27T11:00:00Z') },
      { amountUsd: 2, at: new Date('2026-09-26T12:00:01Z') },
      { amountUsd: 4, at: new Date('2026-09-26T11:59:59Z') },
    ]
    expect(sumWindow(rows, now)).toBe(3)
  })
})

describe('gradeInWords', () => {
  it('names the number the caller has to act on', () => {
    expect(gradeInWords(gradeSpend(env, { kind: 'bond', amountUsd: 2, spentTodayUsd: 0 }), env)).toContain('$1')
    expect(gradeInWords(gradeSpend(env, { kind: 'bond', amountUsd: 50, spentTodayUsd: 0 }), env)).toContain('OVER_PER_TX_MAX')
  })
})
