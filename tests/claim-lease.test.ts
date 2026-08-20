import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ABANDON_STREAK_FOR_RESTRICTION,
  decideClaim,
  GRACE_SECONDS,
  LEASE_SECONDS,
  restrictionFor,
  SILENCE_EVIDENCE_CLASS,
  type ClaimState,
} from '../lib/claim-lease'
import { classRank, MIN_CLASS_FOR_MONEY } from '../lib/evidence-assurance'

const T0 = 1_000_000
const state = (o: Partial<ClaimState> = {}): ClaimState => ({
  jobId: '5',
  worker: 'plotter',
  acceptedAtSec: T0,
  ...o,
})

describe('the lease', () => {
  it('holds while the worker is reporting', () => {
    const d = decideClaim(state({ lastHeartbeatSec: T0 + 100 }), T0 + 200)
    expect(d.action).toBe('hold')
    expect(d.silentForSec).toBe(100)
  })

  it('holds right up to the lease boundary, and warns one second past it', () => {
    expect(decideClaim(state(), T0 + LEASE_SECONDS).action).toBe('hold')
    expect(decideClaim(state(), T0 + LEASE_SECONDS + 1).action).toBe('warn')
  })

  it('warns rather than revoking inside grace, because a rebooting worker looks like this', () => {
    const d = decideClaim(state(), T0 + LEASE_SECONDS + GRACE_SECONDS)
    expect(d.action).toBe('warn')
    expect(d.reason).toMatch(/rebooting/)
  })

  it('revokes once grace is exhausted', () => {
    const d = decideClaim(state(), T0 + LEASE_SECONDS + GRACE_SECONDS + 1)
    expect(d.action).toBe('revoke')
    expect(d.remedy).toBe('REPUTATION_NOTE')
  })

  it('counts silence from acceptance when the worker never reported at all', () => {
    // §29's four stuck jobs: accepted, then nothing, ever.
    const d = decideClaim(state(), T0 + 3600)
    expect(d.silentForSec).toBe(3600)
    expect(d.action).toBe('revoke')
  })

  it('defers to the on-chain reclaim path past the deadline instead of racing it', () => {
    const d = decideClaim(state({ deadlineSec: T0 + 60 }), T0 + 61)
    expect(d.action).toBe('deadline')
    expect(d.reason).toMatch(/race the contract/)
  })

  it('lets the deadline win even when the worker is alive and reporting', () => {
    const d = decideClaim(state({ lastHeartbeatSec: T0 + 59, deadlineSec: T0 + 60 }), T0 + 60)
    expect(d.action).toBe('deadline')
  })
})

describe('silence never takes money', () => {
  it('refuses to authorise a slash in every reachable state', () => {
    const times = [0, LEASE_SECONDS, LEASE_SECONDS + 1, LEASE_SECONDS + GRACE_SECONDS + 1, 10 ** 6]
    for (const dt of times) {
      expect(decideClaim(state(), T0 + dt).maySlashBond).toBe(false)
      expect(decideClaim(state({ deadlineSec: T0 + 5 }), T0 + dt).maySlashBond).toBe(false)
    }
  })

  it('classifies silence below the floor that moving money requires', () => {
    // This is the load-bearing link: the remedy is reversible BECAUSE the
    // evidence is weak, not because we felt lenient.
    expect(classRank(SILENCE_EVIDENCE_CLASS)).toBeLessThan(classRank(MIN_CLASS_FOR_MONEY))
  })

  it('only ever proposes reversible remedies', () => {
    const d = decideClaim(state(), T0 + 10 ** 6)
    expect(['REPUTATION_NOTE', 'CAPABILITY_RESTRICTION', undefined]).toContain(d.remedy)
  })
})

describe('abandonment is a pattern, not an incident', () => {
  it('does nothing on the first abandonment — a crash is not misconduct', () => {
    const r = restrictionFor(1)
    expect(r.remedy).toBe('REPUTATION_NOTE')
    expect(r.maxConcurrentClaims).toBe(Infinity)
  })

  it('restricts concurrency once it is a streak, and still takes nothing', () => {
    const r = restrictionFor(ABANDON_STREAK_FOR_RESTRICTION)
    expect(r.remedy).toBe('CAPABILITY_RESTRICTION')
    expect(r.maxConcurrentClaims).toBe(1)
  })

  it('is silent for a clean worker', () => {
    expect(restrictionFor(0).remedy).toBe('NONE')
  })
})

describe('the module keeps its own constraints', () => {
  const src = readFileSync(new URL('../lib/claim-lease.ts', import.meta.url), 'utf8')

  it('declares no monetary constant — the timeouts are policy, the money rule is not ours', () => {
    const body = src.slice(src.indexOf('export const LEASE_SECONDS'))
    expect(body).not.toMatch(/USD|CENTS|_FEE|BOND_[A-Z]*(AMOUNT|BPS)/)
  })

  it('states why silence cannot slash rather than only doing it', () => {
    expect(src).toMatch(/Silence is not evidence of fault/)
    expect(src).toMatch(/free-option/)
  })
})
