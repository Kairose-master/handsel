import { describe, expect, it } from 'vitest'
import {
  APPEAL_WINDOW_MS,
  MAX_APPEALS_PER_JOB,
  appealRoute,
  canAppeal,
  panelOutcome,
  recomputeOutcome,
  type AppealRequest,
} from '@/lib/appeal'
import { GRADER_CLASSES } from '@/lib/grader-class'

/**
 * The gap §24 and §25 both pointed at without either of them naming it: a
 * worker had no way to be heard. Both were answered by improving a classifier,
 * which shrinks an error rate and never reaches zero. This is the floor under
 * the error rate.
 */

const NOW = 1_800_000_000_000
const base: AppealRequest = {
  requestingAgentId: 'agent-worker',
  workerAgentId: 'agent-worker',
  passed: false,
  graderClass: 'model',
  gradedAtMs: NOW - 60_000,
  priorAppeals: 0,
  nowMs: NOW,
}

describe('who may appeal', () => {
  it('the graded worker may', () => {
    expect(canAppeal(base).ok).toBe(true)
  })

  it('nobody else may — including the requester', () => {
    const d = canAppeal({ ...base, requestingAgentId: 'agent-requester' })
    expect(d.ok).toBe(false)
    expect(d.ok === false && d.reason).toMatch(/only the graded worker/)
  })

  it('a job with no worker recorded cannot be appealed by anyone', () => {
    // Otherwise the null workerAgentId compares equal to nothing and the guard
    // depends on the caller passing a non-null id, which is the caller's bug to
    // make and ours to eat.
    expect(canAppeal({ ...base, workerAgentId: null }).ok).toBe(false)
  })
})

describe('what may be appealed', () => {
  it('a failure may', () => {
    expect(canAppeal({ ...base, passed: false }).ok).toBe(true)
  })

  it('a pass may not — nobody appeals winning', () => {
    const d = canAppeal({ ...base, passed: true })
    expect(d.ok).toBe(false)
    expect(d.ok === false && d.reason).toMatch(/nothing to appeal/)
  })

  /**
   * The one that matters most. `passed: null` is the §24/§25 exit: it says WE
   * do not know, and records nothing about the worker. Allowing an appeal
   * against it would let a worker convert "no verdict" into "a verdict in my
   * favour" — strictly worse than the floor it replaced.
   */
  it('a null verdict may not, because there is nothing to overturn', () => {
    const d = canAppeal({ ...base, passed: null })
    expect(d.ok).toBe(false)
    expect(d.ok === false && d.reason).toMatch(/no verdict was recorded/)
  })
})

describe('the window', () => {
  it('is open just inside it and shut just outside', () => {
    expect(canAppeal({ ...base, gradedAtMs: NOW - APPEAL_WINDOW_MS + 1000 }).ok).toBe(true)
    expect(canAppeal({ ...base, gradedAtMs: NOW - APPEAL_WINDOW_MS - 1000 }).ok).toBe(false)
  })

  it('an unknown grading time is not permission', () => {
    // Same rule the settlement paths follow: unknown timing means do nothing.
    // Treating it as "probably fresh" would make an unstamped row appealable
    // forever, which outlives the on-chain review deadline it has to fit in.
    const d = canAppeal({ ...base, gradedAtMs: null })
    expect(d.ok).toBe(false)
    expect(d.ok === false && d.reason).toMatch(/appeal window cannot be checked/)
  })

  it('a verdict stamped in the future is refused, not treated as fresh', () => {
    expect(canAppeal({ ...base, gradedAtMs: NOW + 60_000 }).ok).toBe(false)
  })

  it('fits inside the review window it lives in', () => {
    // The chain settles at the review deadline regardless of our database. An
    // appeal window at or past a one-day review window is a promise the chain
    // will not keep, and leaves the resolution path no room to run.
    expect(APPEAL_WINDOW_MS).toBeLessThan(24 * 60 * 60 * 1000)
  })
})

describe('how many times', () => {
  it('once', () => {
    expect(canAppeal({ ...base, priorAppeals: 0 }).ok).toBe(true)
    expect(canAppeal({ ...base, priorAppeals: MAX_APPEALS_PER_JOB }).ok).toBe(false)
  })
})

describe('routing by how the verdict was reached, not by how much it is worth', () => {
  it('a recomputable verdict is appealed by recomputing it', () => {
    expect(appealRoute('reproducible')).toBe('recompute')
    expect(appealRoute('mechanical')).toBe('recompute')
  })

  it("a model's opinion needs independent agents, not the same model again", () => {
    // Re-prompting is not a second opinion; it is the same opinion with
    // different sampling noise.
    expect(appealRoute('model')).toBe('panel')
  })

  it('anything that cannot be recomputed by a third party goes to a panel', () => {
    expect(appealRoute('attested')).toBe('panel')
    expect(appealRoute('declared')).toBe('panel')
  })

  it('every grader class routes somewhere', () => {
    // A class with no route is a worker whose appeal silently does nothing.
    for (const cls of GRADER_CLASSES) {
      expect(['recompute', 'panel'], cls).toContain(appealRoute(cls))
    }
  })

  it('makes the cheapest verdict to defend the one anyone can recompute', () => {
    // The incentive is the point: a model verdict costs a panel to defend, a
    // reproducible one costs a rerun. That is the right relative price.
    expect(appealRoute('reproducible')).not.toBe(appealRoute('model'))
  })
})

describe('a recompute appeal', () => {
  it('an agreeing rerun leaves the verdict alone', () => {
    const o = recomputeOutcome({ original: false, rerun: false })
    expect(o.passed).toBe(false)
    expect(o.overturned).toBe(false)
  })

  /**
   * The interesting case, and it does NOT resolve to "the second run wins".
   * Two runs of a deterministic check that disagree prove the check is not
   * deterministic — so it is not evidence about the worker in either direction.
   */
  it('a disagreeing rerun yields NO verdict, not a pass', () => {
    const o = recomputeOutcome({ original: false, rerun: true })
    expect(o.passed).toBeNull()
    expect(o.overturned).toBe(true)
    expect(o.reason).toMatch(/disagrees with itself/)
  })

  it('a rerun that could not run changes nothing', () => {
    // Our infrastructure failing is not evidence for either party. It must not
    // quietly clear a failure, and it must not add one.
    const o = recomputeOutcome({ original: false, rerun: null })
    expect(o.passed).toBe(false)
    expect(o.overturned).toBe(false)
  })
})

describe('a panel appeal', () => {
  it('upheld leaves the failure standing', () => {
    expect(panelOutcome({ verdict: 'upheld' })).toMatchObject({ passed: false, overturned: false })
  })

  it('overturned turns the failure into a pass', () => {
    expect(panelOutcome({ verdict: 'overturned' })).toMatchObject({ passed: true, overturned: true })
  })

  it('a split panel records nothing, rather than defaulting either way', () => {
    // Same rule as tallyPanel's `unproven` and as `passed: null` everywhere
    // else: failure to establish a fact is not a fact.
    const o = panelOutcome({ verdict: 'unproven' })
    expect(o.passed).toBeNull()
    expect(o.overturned).toBe(true)
  })

  it('only an affirmative panel can produce a pass', () => {
    const passes = (['upheld', 'unproven', 'overturned'] as const).filter(
      (v) => panelOutcome({ verdict: v }).passed === true,
    )
    expect(passes).toEqual(['overturned'])
  })
})

describe('every outcome is explainable', () => {
  it('carries a printable reason', () => {
    // An appeal whose result cannot be explained to the worker is not a right,
    // it is a lottery with extra steps.
    for (const o of [
      recomputeOutcome({ original: false, rerun: false }),
      recomputeOutcome({ original: false, rerun: true }),
      recomputeOutcome({ original: false, rerun: null }),
      panelOutcome({ verdict: 'upheld' }),
      panelOutcome({ verdict: 'unproven' }),
      panelOutcome({ verdict: 'overturned' }),
    ]) {
      expect(o.reason.length).toBeGreaterThan(20)
    }
  })
})
