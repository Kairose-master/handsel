import { describe, expect, it } from 'vitest'
import { EVENT_INDEXES, REQUESTER_JSON_PATH } from '@/lib/db/event-index'
import { counterpartyEdgeQuery } from '@/lib/credit-engine/counterparty-graph'

describe('the index and the query it serves cannot drift apart', () => {
  // This is the whole reason the JSON path is a shared constant. An expression
  // index only helps when the expression matches character for character, and
  // a mismatch has no symptom: the index stays, the planner ignores it, and the
  // query goes back to a sequential scan on every settlement.
  const compiled = counterpartyEdgeQuery(['a']).toSQL().sql
  const requesterIndex = EVENT_INDEXES.find((i) => i.name === 'agent_events_requester_completed_idx')!

  it('uses the same JSON expression in the query as in the index', () => {
    expect(compiled).toContain(REQUESTER_JSON_PATH)
    expect(requesterIndex.sql).toContain(REQUESTER_JSON_PATH)
  })

  it('scopes both to the same event type, so the partial index applies', () => {
    // A partial index is only usable when the query's WHERE clause implies the
    // index predicate. If the query ever stopped filtering on JOB_COMPLETED,
    // this index would silently stop being eligible.
    expect(compiled).toContain('event_type')
    expect(requesterIndex.sql).toContain(`WHERE event_type = 'JOB_COMPLETED'`)
  })

  it('still binds the ids as parameters — the raw part is the column only', () => {
    const { sql: text, params } = counterpartyEdgeQuery(["a'; drop table agent_events; --"]).toSQL()
    expect(text).not.toContain('drop table')
    expect(params).toContain("a'; drop table agent_events; --")
  })
})

describe('every index declares what it is for', () => {
  it('has a unique name', () => {
    const names = EVENT_INDEXES.map((i) => i.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names the query it serves, so nobody has to guess before deleting one', () => {
    for (const index of EVENT_INDEXES) {
      expect(index.serves.length).toBeGreaterThan(40)
    }
  })

  it('is safe to run on every boot', () => {
    for (const index of EVENT_INDEXES) {
      expect(index.sql).toContain('IF NOT EXISTS')
    }
  })

  it('declares the index name inside its own statement', () => {
    // Otherwise the name used for logging and the name actually created can
    // differ, and the error message points at an index that does not exist.
    for (const index of EVENT_INDEXES) {
      expect(index.sql).toContain(index.name)
    }
  })

  it('covers the per-settlement read of one agent’s history', () => {
    // recalculateCredit walks WHERE agent_id = ? on every settlement. This was
    // unindexed until the Sybil work made the same path heavier.
    expect(EVENT_INDEXES.some((i) => /\(agent_id\)/.test(i.sql))).toBe(true)
  })
})
