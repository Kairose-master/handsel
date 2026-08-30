import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  assessClaim,
  cooldownUntil,
  claimJobClass,
  fitnessSummary,
  COOLDOWN_MS,
  DEADLINE_SAFETY,
  FAILURE_WINDOW,
  MIN_TURNAROUND_SAMPLES,
  type ClaimFacts,
} from '@/lib/claim-fitness'

const NOW = Date.parse('2026-08-30T12:00:00Z')

function facts(over: Partial<ClaimFacts> = {}): ClaimFacts {
  return {
    now: NOW,
    autonomous: true,
    liveness: 'ready',
    heartbeatAgeSec: 3,
    canDeliver: true,
    deliverableKind: 'text',
    missingCapabilities: [],
    repoAccess: 'not-applicable',
    repoFullName: null,
    deadlineSec: null,
    medianTurnaroundSec: null,
    classHistory: null,
    ...over,
  }
}

describe('a claim nothing is wrong with', () => {
  it('passes, with nothing to report', () => {
    const v = assessClaim(facts())
    expect(v.ok).toBe(true)
    expect(v.findings).toEqual([])
    expect(v.blocked).toBe(null)
    expect(fitnessSummary(v)).toBe('fit to claim')
  })
})

describe('unknown never blocks', () => {
  // The posture the whole module is built on, and the same one the gas and
  // bond preflights take: a probe that cannot answer must not be the thing
  // that stops a working agent from earning.
  it('lets every unknown through, for a person and for auto-mine alike', () => {
    for (const autonomous of [true, false]) {
      const v = assessClaim(
        facts({
          autonomous,
          liveness: 'unknown',
          repoAccess: 'unknown',
          deadlineSec: null,
          medianTurnaroundSec: null,
          classHistory: null,
        }),
      )
      expect(v.ok, String(autonomous)).toBe(true)
    }
  })

  it('does not refuse a repo job merely because GitHub could not be asked', () => {
    const v = assessClaim(facts({ repoAccess: 'unknown', repoFullName: 'me/repo' }))
    expect(v.ok).toBe(true)
  })

  it('does not run the deadline check without a median to compare against', () => {
    // A cold-start agent has no history and must be able to take a first job.
    const v = assessClaim(facts({ deadlineSec: Math.floor(NOW / 1000) + 5, medianTurnaroundSec: null }))
    expect(v.ok).toBe(true)
  })

  it('does not run the deadline check on a market with no deadlines', () => {
    const v = assessClaim(facts({ deadlineSec: null, medianTurnaroundSec: 3600 }))
    expect(v.ok).toBe(true)
  })
})

describe('hard checks bind everyone', () => {
  // An offline worker or a missing repository permission is a certainty, not
  // a judgement — an owner clicking claim is as wrong about it as auto-mine.
  it('refuses when the worker that would do the job is offline', () => {
    for (const autonomous of [true, false]) {
      const v = assessClaim(facts({ autonomous, liveness: 'offline', heartbeatAgeSec: 3600 }))
      expect(v.ok, String(autonomous)).toBe(false)
      expect(v.blocked?.code).toBe('runtime-offline')
      expect(v.blocked?.reason).toContain('1h')
    }
  })

  it('says "never" rather than a bogus age for a worker that never polled', () => {
    const v = assessClaim(facts({ liveness: 'offline', heartbeatAgeSec: null }))
    expect(v.blocked?.reason).toContain('never')
  })

  it('lets a merely-stale heartbeat through — that is what the grace window is for', () => {
    expect(assessClaim(facts({ liveness: 'stale', heartbeatAgeSec: 150 })).ok).toBe(true)
  })

  it('refuses a deliverable the agent does not declare, and names what is missing', () => {
    for (const autonomous of [true, false]) {
      const v = assessClaim(
        facts({ autonomous, canDeliver: false, deliverableKind: 'image', missingCapabilities: ['image'] }),
      )
      expect(v.ok, String(autonomous)).toBe(false)
      expect(v.blocked?.code).toBe('capability')
      expect(v.blocked?.reason).toContain('image')
    }
  })

  it('refuses a repo job the account has no access to, and says where to fix it', () => {
    for (const autonomous of [true, false]) {
      const v = assessClaim(facts({ autonomous, repoAccess: 'denied', repoFullName: 'someone/private' }))
      expect(v.ok, String(autonomous)).toBe(false)
      expect(v.blocked?.code).toBe('repo-access')
      expect(v.blocked?.reason).toContain('someone/private')
      expect(v.blocked?.reason).toMatch(/GitHub/)
    }
  })
})

describe('soft checks bind only autonomous claims', () => {
  const tight = { deadlineSec: Math.floor(NOW / 1000) + 60, medianTurnaroundSec: 3600 }

  it('refuses an auto-mine claim into a deadline the agent cannot make', () => {
    const v = assessClaim(facts({ autonomous: true, ...tight }))
    expect(v.ok).toBe(false)
    expect(v.blocked?.code).toBe('deadline')
    expect(v.blocked?.reason).toContain('1h') // the agent's own median, quoted
  })

  it('lets an owner take that same job, and still tells them', () => {
    // The owner is entitled to make the judgement; auto-mine is not entitled
    // to make it with the owner's bond.
    const v = assessClaim(facts({ autonomous: false, ...tight }))
    expect(v.ok).toBe(true)
    expect(v.findings.map((f) => f.code)).toContain('deadline')
    expect(v.blocked).toBe(null)
  })

  it('allows a deadline with the documented safety margin over the median', () => {
    const median = 600
    const comfortable = Math.floor(NOW / 1000) + Math.ceil(median * DEADLINE_SAFETY) + 1
    expect(assessClaim(facts({ deadlineSec: comfortable, medianTurnaroundSec: median })).ok).toBe(true)
    const exactly = Math.floor(NOW / 1000) + Math.floor(median * DEADLINE_SAFETY) - 1
    expect(assessClaim(facts({ deadlineSec: exactly, medianTurnaroundSec: median })).ok).toBe(false)
  })

  it('does not report a negative remaining time on an already-expired deadline', () => {
    const v = assessClaim(facts({ deadlineSec: Math.floor(NOW / 1000) - 999, medianTurnaroundSec: 60 }))
    expect(v.blocked?.reason).not.toMatch(/-\d/)
  })
})

describe('the failure cooldown', () => {
  const failingHistory = {
    jobClass: 'code',
    graded: 4,
    failed: 3,
    lastFailedAt: NOW - 60_000,
  }

  it('sits out a class the agent keeps failing', () => {
    // The reported account had a worker silently failing every job it took,
    // staking a bond each time; nothing stopped it.
    const v = assessClaim(facts({ classHistory: failingHistory }))
    expect(v.ok).toBe(false)
    expect(v.blocked?.code).toBe('cooldown')
    expect(v.blocked?.reason).toContain('3 of its last 4')
    expect(v.blocked?.reason).toContain('code')
  })

  it('is a cooldown, not a ban: it says when it lifts and lifts by itself', () => {
    // A state only a human can leave is limbo, not a queue.
    const v = assessClaim(facts({ classHistory: failingHistory }))
    expect(v.blocked?.clearsAt).toBe(failingHistory.lastFailedAt + COOLDOWN_MS)
    expect(v.blocked?.reason).toContain('nothing else is required')
    const later = assessClaim(facts({ now: failingHistory.lastFailedAt + COOLDOWN_MS + 1, classHistory: failingHistory }))
    expect(later.ok).toBe(true)
  })

  it('does not punish an old failure among many passes', () => {
    expect(cooldownUntil({ jobClass: 'code', graded: 4, failed: 1, lastFailedAt: NOW })).toBe(null)
  })

  it('waits for enough evidence before calling it a pattern', () => {
    // Two failures out of two is a bad afternoon.
    expect(cooldownUntil({ jobClass: 'code', graded: 2, failed: 2, lastFailedAt: NOW })).toBe(null)
    expect(cooldownUntil({ jobClass: 'code', graded: 3, failed: 3, lastFailedAt: NOW })).toBe(NOW + COOLDOWN_MS)
  })

  it('is null with no history at all', () => {
    expect(cooldownUntil(null)).toBe(null)
    expect(cooldownUntil({ jobClass: 'code', graded: 0, failed: 0, lastFailedAt: null })).toBe(null)
  })

  it('never exceeds the window it claims to measure', () => {
    // "failed 5 of its last 4" would be nonsense in the refusal text.
    const v = assessClaim(facts({ classHistory: { jobClass: 'code', graded: 40, failed: 4, lastFailedAt: NOW } }))
    expect(v.blocked?.reason).toContain(`of its last ${FAILURE_WINDOW}`)
  })
})

describe('reporting', () => {
  it('reports every finding, not only the blocking one', () => {
    const v = assessClaim(
      facts({
        liveness: 'offline',
        heartbeatAgeSec: 900,
        canDeliver: false,
        deliverableKind: 'image',
        missingCapabilities: ['image'],
      }),
    )
    expect(v.findings.map((f) => f.code)).toEqual(['runtime-offline', 'capability'])
    expect(fitnessSummary(v)).toContain('+1 more')
  })

  it('leads with the most actionable finding', () => {
    // Order is deliberate: an operator should read the certainty first, not
    // whichever check happened to be written first.
    const v = assessClaim(facts({ liveness: 'offline', heartbeatAgeSec: 900, classHistory: { jobClass: 'code', graded: 4, failed: 4, lastFailedAt: NOW } }))
    expect(v.blocked?.code).toBe('runtime-offline')
  })
})

describe('claimJobClass', () => {
  it('uses the same classifier the market prices with', () => {
    // "This kind of job" must mean one thing in this codebase, not two.
    expect(claimJobClass({ title: 'anything', deliverableKind: 'image' })).toBe('image')
    expect(claimJobClass({ title: null, deliverableKind: null })).toBe('text')
  })
})

describe('the constants say what they mean', () => {
  it('needs a real sample before trusting a median', () => {
    expect(MIN_TURNAROUND_SAMPLES).toBeGreaterThanOrEqual(3)
  })
  it('gives a deadline more room than the median itself', () => {
    expect(DEADLINE_SAFETY).toBeGreaterThan(1)
  })
})

describe('the claim paths actually run the check', () => {
  // A rule nothing calls is not a rule. These pin the CALL — an import
  // survives deleting the call, which is how a regression pin in this repo
  // once passed while the behaviour was gone.
  const dispatch = readFileSync('lib/labor-dispatch.ts', 'utf8')
  const mine = readFileSync('lib/auto-mine.ts', 'utf8')

  it('gates both accept paths on it', () => {
    expect(dispatch).toMatch(/await assertFitToClaim\(worker, job, spec, opts\.autonomous === true\)/)
    expect(dispatch).toMatch(/await assertFitToClaim\(worker, job, spec, false\)/)
  })

  it('keeps exactly one copy of the capability rule', () => {
    // Two copies of the same rule are how the two start disagreeing about
    // the same job — the defect class of §44.
    expect(dispatch).not.toContain("hasn't declared the needed capabilities")
  })

  it('tells auto-mine it is autonomous, or the soft checks never bite', () => {
    expect(mine).toMatch(/acceptAndDispatchJob\(agent, job\.id, callbackUrl, \{ autonomous: true \}\)/)
    expect(mine).toMatch(/autonomous: true/)
  })

  it('filters the tick with one context rather than one query per job', () => {
    expect(mine).toMatch(/agentFitnessContext\(agent\)/)
    expect(mine).toMatch(/candidates: fitCandidates/)
  })

  it('never lets its own failure block a claim', () => {
    // A database or GitHub hiccup that stopped a working agent earning
    // would be a worse bug than the one this prevents.
    const fn = dispatch.slice(dispatch.indexOf('async function assertFitToClaim'), dispatch.indexOf('export async function acceptAndDispatchJob'))
    expect(fn).toMatch(/catch \(e\) \{[\s\S]*?return\n?\s*\}/)
  })

  it('shows the operator why an agent is idle', () => {
    // Otherwise a preflight that quietly stops an agent claiming is the same
    // invisible state an expiring reservation was (§45).
    const roster = readFileSync('lib/mcp/handlers/worker.ts', 'utf8')
    expect(roster).toMatch(/await claimHolds\(a\)/)
    expect(roster).toMatch(/Clears by itself/)
  })
})
