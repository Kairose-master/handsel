/**
 * A preview must write nothing.
 *
 * `/api/admin/rescore` exists because changing the scoring engine changes no
 * score: recalculation is event-driven and no sweep walks the whole table, so
 * after `NO_EVIDENCE_FACTOR` shipped (failure-modes §20) every idle agent kept
 * the number the old formula produced — and that stored number is what the
 * leaderboard and the lending gate read.
 *
 * Rewriting every score on the site is the widest single operation in this
 * codebase, so the route is dry by default and the dry run computes the REAL
 * new scores rather than a summary. That is only worth anything if the dry
 * path genuinely writes nothing, which is what this pins: no
 * `credit_score_entries` row, no `agents` update, and — the expensive one —
 * no on-chain registry mirror, which is a real transaction that costs gas and
 * would fire once per agent.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const inserted = vi.fn()
const updated = vi.fn()

/** Chainable stand-in for drizzle's builder: every method returns itself, and
 *  awaiting it yields an empty result set. Enough for a read path whose whole
 *  job here is to produce the no-history assessment. */
function queryStub(): unknown {
  const target = {
    then: (resolve: (v: unknown[]) => unknown) => resolve([]),
  }
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then
      return () => queryStub()
    },
  })
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => queryStub(),
    insert: (...a: unknown[]) => {
      inserted(...a)
      return queryStub()
    },
    update: (...a: unknown[]) => {
      updated(...a)
      return queryStub()
    },
    delete: () => queryStub(),
    execute: () => Promise.resolve([]),
  },
}))

const publishLimit = vi.fn()
const attestCredit = vi.fn()
vi.mock('@/lib/onchain/credit', () => ({
  publishLimit: (...a: unknown[]) => publishLimit(...a),
  attestCredit: (...a: unknown[]) => attestCredit(...a),
}))

import { recalculateCredit } from '@/lib/credit-engine'

beforeEach(() => {
  inserted.mockReset()
  updated.mockReset()
  publishLimit.mockReset()
  attestCredit.mockReset()
})

describe('recalculateCredit({ persist: false })', () => {
  it('returns an assessment without writing anything', async () => {
    const result = await recalculateCredit('agent-1', { persist: false })

    // It still answers — a dry run that returns nothing is not a preview.
    expect(result.score).toBe(300)
    expect(result.rating).toBe('D')

    expect(inserted).not.toHaveBeenCalled()
    expect(updated).not.toHaveBeenCalled()
  })

  it('sends no transaction', async () => {
    // The one that costs money. A bulk preview over N agents must not fire N
    // registry writes competing for one nonce and one gas allowance.
    await recalculateCredit('agent-1', { persist: false })
    expect(publishLimit).not.toHaveBeenCalled()
    expect(attestCredit).not.toHaveBeenCalled()
  })

  it('is the default-on behaviour that is opt-OUT, not opt-in', async () => {
    // Every existing caller passes no options and must keep persisting —
    // settle.ts, loan-sweep.ts, stale-claim.ts and the MCP worker path all
    // rely on the score actually being stored.
    await recalculateCredit('agent-1')
    expect(updated).toHaveBeenCalled()
  })
})
