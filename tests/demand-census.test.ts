import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CSV_HEADER,
  MIN_OBSERVATIONS_FOR_TREND,
  parseCount,
  parseCsv,
  QUERIES,
  renderQuery,
  report,
  toCsvLine,
  trendFor,
  type CensusRow,
} from '../lib/demand-census'

const row = (date: string, counts: Record<string, number | null>): CensusRow => ({ date, counts })

describe('parseCount refuses to invent a zero', () => {
  it('reads a real count', () => {
    expect(parseCount({ total_count: 42 })).toBe(42)
    expect(parseCount({ total_count: 0 })).toBe(0)
  })

  it('returns null on anything unexpected', () => {
    // A failed query recorded as 0 is indistinguishable from a channel that
    // emptied out — which would make the series confirm our own thesis by
    // accident. This is the same rule the ecosystem watch follows on
    // FETCH_FAILED.
    for (const bad of [null, undefined, {}, { total_count: 'lots' }, { total_count: -1 }, { total_count: NaN }, 'nope']) {
      expect(parseCount(bad)).toBeNull()
    }
  })
})

describe('the CSV never turns a missing reading into a number', () => {
  it('writes null as an empty field', () => {
    const line = toCsvLine(row('2026-08-20', { bounty_open: 5, bounty_open_unassigned: null }))
    expect(line.startsWith('2026-08-20,5,,')).toBe(true)
    expect(line).not.toMatch(/,0,/)
  })

  it('round-trips through parseCsv preserving null vs zero', () => {
    const csv = [CSV_HEADER, toCsvLine(row('2026-08-20', { bounty_open: 0, algora_command: null }))].join('\n')
    const parsed = parseCsv(csv)
    expect(parsed[0]!.counts.bounty_open).toBe(0)
    expect(parsed[0]!.counts.algora_command).toBeNull()
  })

  it('treats a header-only file as no data', () => {
    expect(parseCsv(CSV_HEADER)).toEqual([])
    expect(parseCsv('')).toEqual([])
  })
})

describe('renderQuery', () => {
  it('substitutes the 30-day window', () => {
    const out = renderQuery('created:>{{d30}}', Date.parse('2026-08-20T00:00:00Z'))
    expect(out).toBe('created:>2026-07-21')
  })

  it('leaves queries without placeholders alone', () => {
    expect(renderQuery('is:issue is:open label:bounty', 0)).toBe('is:issue is:open label:bounty')
  })
})

describe('trends refuse to speak too early', () => {
  const many = (n: number, v: number) =>
    Array.from({ length: n }, (_, i) => row(`2026-08-${String(i + 1).padStart(2, '0')}`, { bounty_open: v + i }))

  it('flags too few observations rather than printing a percentage', () => {
    const t = trendFor(many(4, 10), 'bounty_open')
    expect(t.tooEarly).toBe(true)
    expect(report(many(4, 10))[0]).toMatch(/too early for a trend/)
  })

  it('computes a trend once there are enough readings', () => {
    const t = trendFor(many(MIN_OBSERVATIONS_FOR_TREND, 100), 'bounty_open')
    expect(t.tooEarly).toBe(false)
    expect(t.first).toBe(100)
    expect(t.last).toBe(100 + MIN_OBSERVATIONS_FOR_TREND - 1)
    expect(t.deltaPct).toBeGreaterThan(0)
  })

  it('skips missing readings instead of treating them as zero', () => {
    const rows = [row('a', { k: 10 }), row('b', { k: null }), row('c', { k: 20 })]
    const t = trendFor(rows, 'k')
    expect(t.observations).toBe(2)
    expect(t.first).toBe(10)
    expect(t.last).toBe(20)
  })

  it('does not divide by zero when the channel started empty', () => {
    const rows = [row('a', { k: 0 }), row('b', { k: 5 })]
    expect(trendFor(rows, 'k').deltaPct).toBeNull()
  })

  it('says nothing at all with no readings', () => {
    expect(report([])[0]).toMatch(/no readings yet/)
  })
})

describe('the query set stays comparable over time', () => {
  it('has a stable header derived from the queries', () => {
    expect(CSV_HEADER).toBe(['date', ...QUERIES.map((q) => q.key)].join(','))
  })

  it('gives every query a stated reason, because a column nobody can justify is noise', () => {
    for (const q of QUERIES) {
      expect(q.why.length).toBeGreaterThan(20)
      expect(q.q).toMatch(/is:issue/)
    }
  })

  it('keys are unique — a duplicate would silently overwrite a column', () => {
    expect(new Set(QUERIES.map((q) => q.key)).size).toBe(QUERIES.length)
  })
})

describe('the module states its own limits', () => {
  const src = readFileSync(new URL('../lib/demand-census.ts', import.meta.url), 'utf8')

  it('says out loud that this is not a measurement of demand', () => {
    expect(src).toMatch(/It is not "demand for agent labor"/)
  })
})
