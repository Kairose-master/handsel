/**
 * The headline strip's honesty rules.
 *
 * A row of confident numbers across the top of a dashboard is the most
 * believable place in a UI to put a lie, so the interesting behaviour here
 * is what the module REFUSES to say.
 */
import { describe, expect, it } from 'vitest'

import { agentsLabel, burnPerHour, isMeasured } from '@/lib/office-command-bar'

describe('burnPerHour', () => {
  it('divides a real 24h total into a rate', () => {
    expect(burnPerHour(24)).toBe(1)
    expect(burnPerHour(12)).toBe(0.5)
  })

  it('returns null when nothing was spent, rather than $0.00/h', () => {
    // "$0.00/h" reads as "the meter is running and it is cheap". No spend at
    // all is a different statement, and the UI must be able to tell them
    // apart.
    expect(burnPerHour(0)).toBeNull()
    expect(burnPerHour(null)).toBeNull()
  })

  it('never reports a negative rate', () => {
    expect(burnPerHour(-5)).toBeNull()
  })
})

describe('isMeasured', () => {
  it('separates a real zero from an absent measurement', () => {
    expect(isMeasured(0)).toBe(true)
    expect(isMeasured(null)).toBe(false)
    expect(isMeasured(undefined)).toBe(false)
  })
})

describe('agentsLabel', () => {
  it('leads with the agents that can actually take a job', () => {
    // An agent with no smart account cannot accept work, so a bare roster
    // count overstates the desk — the reference's "18 / 24" shape, with the
    // left number meaning "able to work".
    expect(agentsLabel({ total: 24, provisioned: 18 })).toBe('18 / 24')
    expect(agentsLabel({ total: 3, provisioned: 0 })).toBe('0 / 3')
  })
})
