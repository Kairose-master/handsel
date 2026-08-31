/**
 * Self-ops findings — each threshold pinned to the live incident that
 * motivated it (2026-08-31): a heartbeat green 950 times without ever
 * calling its endpoint, an oracle that couldn't fund a fresh worker's first
 * transaction, and every storefront closed while "deployed" read as "open".
 */
import { describe, it, expect } from 'vitest'
import {
  detectSelfOpsFindings,
  formatSelfOpsReport,
  HEARTBEAT_STALE_MS,
  ORACLE_DRY_WEI,
  ORACLE_LOW_WEI,
  type PlatformVitals,
} from '@/lib/self-ops'

const NOW = 1_756_000_000_000

function vitals(overrides: Partial<PlatformVitals> = {}): PlatformVitals {
  return {
    now: NOW,
    lastFullCycleAt: NOW - 60_000,
    oracleWei: ORACLE_LOW_WEI * 10n,
    onchainConfigured: true,
    openStorefronts: 1,
    realMoney: false,
    ...overrides,
  }
}

describe('detectSelfOpsFindings', () => {
  it('is quiet when everything is healthy', () => {
    expect(detectSelfOpsFindings(vitals())).toEqual([])
    expect(formatSelfOpsReport([])).toBe('all clear')
  })

  it('flags a heartbeat that has never been observed as critical', () => {
    const f = detectSelfOpsFindings(vitals({ lastFullCycleAt: null }))
    expect(f.map((x) => x.id)).toContain('heartbeat-never')
    expect(f.find((x) => x.id === 'heartbeat-never')!.severity).toBe('critical')
    // The fix must be named — the whole point is not making a person re-derive it.
    expect(f.find((x) => x.id === 'heartbeat-never')!.detail).toContain('CRON_SECRET')
  })

  it('flags a stale heartbeat, and knows a skip-green is not a beat', () => {
    const f = detectSelfOpsFindings(vitals({ lastFullCycleAt: NOW - HEARTBEAT_STALE_MS - 1 }))
    const finding = f.find((x) => x.id === 'heartbeat-stale')!
    expect(finding.severity).toBe('critical')
    expect(finding.detail).toMatch(/unconfigured skip/)
  })

  it('does not flag a heartbeat exactly at the threshold', () => {
    const f = detectSelfOpsFindings(vitals({ lastFullCycleAt: NOW - HEARTBEAT_STALE_MS }))
    expect(f.map((x) => x.id)).not.toContain('heartbeat-stale')
  })

  it('grades the oracle wallet: dry below one top-up, low below ten', () => {
    expect(detectSelfOpsFindings(vitals({ oracleWei: ORACLE_DRY_WEI - 1n })).map((x) => x.id)).toContain('oracle-dry')
    expect(detectSelfOpsFindings(vitals({ oracleWei: ORACLE_LOW_WEI - 1n })).map((x) => x.id)).toContain('oracle-low')
    expect(detectSelfOpsFindings(vitals({ oracleWei: ORACLE_LOW_WEI })).map((x) => x.id)).not.toContain('oracle-low')
  })

  it('says nothing about the oracle when on-chain is not configured or unreadable', () => {
    // No oracle key = nothing to measure, not a dry wallet.
    expect(
      detectSelfOpsFindings(vitals({ onchainConfigured: false, oracleWei: null })).map((x) => x.id),
    ).not.toContain('oracle-dry')
    // Unreadable ≠ zero — an unavailable RPC is not evidence of a balance.
    expect(detectSelfOpsFindings(vitals({ oracleWei: null })).map((x) => x.id)).not.toContain('oracle-dry')
  })

  it('notices — never warns — when every storefront is closed', () => {
    const f = detectSelfOpsFindings(vitals({ openStorefronts: 0 }))
    const finding = f.find((x) => x.id === 'storefront-all-closed')!
    expect(finding.severity).toBe('notice')
  })

  it('stays quiet on an unreadable storefront count', () => {
    expect(detectSelfOpsFindings(vitals({ openStorefronts: null })).map((x) => x.id)).not.toContain(
      'storefront-all-closed',
    )
  })

  it('formats worst-first', () => {
    const f = detectSelfOpsFindings(
      vitals({ openStorefronts: 0, lastFullCycleAt: null, oracleWei: ORACLE_LOW_WEI - 1n }),
    )
    const lines = formatSelfOpsReport(f).split('\n')
    expect(lines[0]).toContain('[critical]')
    expect(lines[lines.length - 1]).toContain('[notice]')
  })
})

describe('ops-cycle wiring', () => {
  it('selfOps is a FAST step — a dead heartbeat cannot report itself from the cron', async () => {
    const { OPS_STEPS } = await import('@/lib/ops-cycle')
    const step = OPS_STEPS.find((s) => s.name === 'selfOps')
    expect(step).toBeDefined()
    expect(step!.fast).toBe(true)
  })
})
