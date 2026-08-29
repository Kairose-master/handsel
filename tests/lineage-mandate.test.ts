/**
 * The lineage mandate's guards (lib/lineage-mandate.ts).
 *
 * The deployment gate is the important one and it is the reason this file
 * exists: the same branch deploys to a real-money market and a faucet
 * rehearsal, and an unattended evolutionary loop must default to the
 * rehearsal. A regression here would not throw — it would quietly start
 * spending real USDC — so the default-deny case is asserted from several
 * directions.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_BIRTHS_PER_WINDOW,
  MAX_SEED_PER_WINDOW_USD,
  lineageMandateAllowed,
  remainingBirthBudget,
} from '@/lib/lineage-mandate'
import { chooseMutation, MAX_GENOME_SKILLS, type AgentGenome } from '@/lib/agent-lineage'

describe('lineageMandateAllowed', () => {
  it('runs freely on a deployment with no real money (the rehearsal)', () => {
    expect(lineageMandateAllowed({ realMoney: false, allowRealMoneyEnv: undefined })).toEqual({ allowed: true })
  })

  it('REFUSES on a real-money deployment by default', () => {
    expect(lineageMandateAllowed({ realMoney: true, allowRealMoneyEnv: undefined })).toEqual({
      allowed: false,
      why: 'real-money-not-allowed',
    })
  })

  it('stays refused for anything that is not an explicit true', () => {
    for (const env of ['', ' ', 'false', '0', 'yes', 'TRUE ', 'no', 'null', 'undefined']) {
      const gate = lineageMandateAllowed({ realMoney: true, allowRealMoneyEnv: env })
      if (env.trim().toLowerCase() === 'true') {
        expect(gate.allowed, `"${env}" should be the one that opens the gate`).toBe(true)
      } else {
        expect(gate.allowed, `"${env}" must not open the real-money gate`).toBe(false)
      }
    }
  })

  it('opens only on an explicit true', () => {
    expect(lineageMandateAllowed({ realMoney: true, allowRealMoneyEnv: 'true' })).toEqual({ allowed: true })
    expect(lineageMandateAllowed({ realMoney: true, allowRealMoneyEnv: 'True' })).toEqual({ allowed: true })
  })
})

describe('remainingBirthBudget', () => {
  const base = { birthsInWindow: 0, seededInWindowUsd: 0, agentCount: 5, maxAgents: 20 }

  it('allows a full window when nothing has been spent', () => {
    expect(remainingBirthBudget(base)).toEqual({ births: MAX_BIRTHS_PER_WINDOW, seedUsd: MAX_SEED_PER_WINDOW_USD })
  })

  it('closes once the window births are used', () => {
    expect(remainingBirthBudget({ ...base, birthsInWindow: MAX_BIRTHS_PER_WINDOW }).births).toBe(0)
  })

  it('is bounded by the account population cap, not just the window', () => {
    expect(remainingBirthBudget({ ...base, agentCount: 20, maxAgents: 20 }).births).toBe(0)
    expect(remainingBirthBudget({ ...base, agentCount: 19, maxAgents: 20 }).births).toBe(1)
  })

  it('never returns a negative budget when the ledger is already over', () => {
    const over = remainingBirthBudget({
      birthsInWindow: 99,
      seededInWindowUsd: 999,
      agentCount: 999,
      maxAgents: 20,
    })
    expect(over.births).toBe(0)
    expect(over.seedUsd).toBe(0)
  })
})

describe('chooseMutation', () => {
  const genome = (slugs: string[]): AgentGenome => ({
    customInstructions: 'x',
    skillSlugs: slugs,
    connector: null,
    model: null,
  })

  it('prunes the measurably worst skill first', () => {
    expect(
      chooseMutation({
        genome: genome(['a', 'b']),
        skillEvidence: [
          { slug: 'a', deltaPoints: -2 },
          { slug: 'b', deltaPoints: -9 },
        ],
        provenElsewhere: ['c'],
      }),
    ).toEqual({ kind: 'drop-skill', slug: 'b' })
  })

  it('ignores an unmeasured skill — null is not a negative delta', () => {
    expect(
      chooseMutation({
        genome: genome(['a']),
        skillEvidence: [{ slug: 'a', deltaPoints: null }],
        provenElsewhere: [],
      }),
    ).toEqual({ kind: 'none' })
  })

  it('adopts the best skill proven elsewhere when there is nothing to prune', () => {
    expect(
      chooseMutation({
        genome: genome(['a']),
        skillEvidence: [{ slug: 'a', deltaPoints: 4 }],
        provenElsewhere: ['best', 'next'],
      }),
    ).toEqual({ kind: 'add-skill', slug: 'best' })
  })

  it('skips a proven skill it already carries', () => {
    expect(
      chooseMutation({
        genome: genome(['best']),
        skillEvidence: [],
        provenElsewhere: ['best', 'next'],
      }),
    ).toEqual({ kind: 'add-skill', slug: 'next' })
  })

  it('changes nothing when the slots are full', () => {
    expect(
      chooseMutation({
        genome: genome(Array.from({ length: MAX_GENOME_SKILLS }, (_, i) => `s${i}`)),
        skillEvidence: [],
        provenElsewhere: ['best'],
      }),
    ).toEqual({ kind: 'none' })
  })

  it('changes nothing with no evidence at all — the default is not to mutate', () => {
    expect(chooseMutation({ genome: genome([]), skillEvidence: [], provenElsewhere: [] })).toEqual({ kind: 'none' })
  })
})
