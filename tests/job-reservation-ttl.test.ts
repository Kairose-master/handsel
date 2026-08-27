import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  reservationLapsed,
  RESERVATION_TTL_MS,
  RESERVATION_HARD_TTL_MS,
} from '@/lib/job-reservation'

const NOW = Date.parse('2026-08-27T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms)

describe('when an office loses priority on its own step', () => {
  it('does not start the clock before the agent can work', () => {
    // The whole finding. A desk of new hires held $0 and could not stake a
    // bond; the window ran out while they were structurally unable to move,
    // and one unwired stranger took all four "independent" reads. Independence
    // was the deliverable, so the buyer got four correlated answers instead.
    const stillBlocked = { reservedAt: ago(5 * 60 * 60 * 1000), eligibleSince: null }
    expect(reservationLapsed(stillBlocked, NOW)).toBe(false)
  })

  it('lapses after the window once the agent has been able', () => {
    expect(
      reservationLapsed(
        { reservedAt: ago(RESERVATION_TTL_MS * 3), eligibleSince: ago(RESERVATION_TTL_MS + 1000) },
        NOW,
      ),
    ).toBe(true)
  })

  it('holds while the agent has been able for less than the window', () => {
    expect(
      reservationLapsed({ reservedAt: ago(RESERVATION_TTL_MS * 3), eligibleSince: ago(60_000) }, NOW),
    ).toBe(false)
  })

  it('opens the job eventually even if the agent is never able', () => {
    // The backstop, and the reason gating on eligibility is safe at all. An
    // agent that never becomes able would otherwise hold the reservation
    // forever — reintroducing, through the fix, the exact entombment the TTL
    // was written to prevent.
    expect(
      reservationLapsed({ reservedAt: ago(RESERVATION_HARD_TTL_MS + 1000), eligibleSince: null }, NOW),
    ).toBe(true)
  })

  it('keeps the hard clock well clear of the soft one', () => {
    // If they were close the backstop would fire on ordinary slowness and the
    // fix would do nothing.
    expect(RESERVATION_HARD_TTL_MS).toBeGreaterThan(RESERVATION_TTL_MS * 4)
    // And short enough that nobody's escrow sits overnight.
    expect(RESERVATION_HARD_TTL_MS).toBeLessThanOrEqual(12 * 60 * 60 * 1000)
  })

  it('is exclusive at the boundary, so neither clock lapses early', () => {
    expect(reservationLapsed({ reservedAt: ago(RESERVATION_HARD_TTL_MS), eligibleSince: null }, NOW)).toBe(false)
    expect(
      reservationLapsed({ reservedAt: ago(RESERVATION_TTL_MS), eligibleSince: ago(RESERVATION_TTL_MS) }, NOW),
    ).toBe(false)
  })
})

describe('who starts the clock', () => {
  const src = readFileSync('lib/job-reservation.ts', 'utf8')
  const mine = readFileSync('lib/auto-mine.ts', 'utf8')

  it('records the first sighting only, so a busy agent cannot reset itself', () => {
    expect(src).toContain('eligible_since IS NULL')
  })

  it('stamps only the calling agent’s own reservations', () => {
    // Without the agent_id predicate one agent's sweep would start every
    // other agent's clock, which is worse than the bug being fixed.
    expect(src).toMatch(/spec_hash = ANY\(\$1\) AND agent_id = \$2/)
  })

  it('is called from the miner only after the gas preflight', () => {
    // "Able" has to mean able. Stamping before the preflight would record an
    // agent that cannot transact as having had its chance.
    const preflight = mine.indexOf('agentGasReadiness')
    const stamp = mine.indexOf('markReservationsEligible')
    expect(preflight).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(preflight)
  })

  it('cannot fail the sweep', () => {
    const window = mine.slice(mine.indexOf('markReservationsEligible'))
    expect(window.slice(0, 300)).toContain('.catch(')
  })

  it('adds its column before anything selects it', () => {
    // The self-migrating side-table pattern: no migration gates this, so the
    // ALTER has to sit in ensureTable, which every read awaits first.
    const ensure = src.slice(src.indexOf('async function ensureTable'), src.indexOf('export function reservationLapsed'))
    expect(ensure).toContain('ADD COLUMN IF NOT EXISTS eligible_since')
  })
})
