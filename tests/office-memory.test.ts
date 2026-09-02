import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  OFFICE_MEMORY,
  digestDeliverable,
  foldMemory,
  renderOfficeMemory,
  type OfficeMemoryEntry,
} from '@/lib/office-memory'

/**
 * Office memory — verified deliverables compounding into the desk's shared
 * context. The two rules under test: only settled work enters (enforced by
 * WHERE the hook sits — the payout path), and the memory is bounded with
 * hire-time injection, so a posted brief never changes under a worker.
 */

const entry = (n: number, over: Partial<OfficeMemoryEntry> = {}): OfficeMemoryEntry => ({
  at: `2026-09-0${(n % 9) + 1}T00:00:00.000Z`,
  jobRef: `#${n}`,
  title: `Step ${n}`,
  paidUsd: 1.14,
  digest: `digest ${n}`,
  ...over,
})

describe('foldMemory — bounded, oldest-out, one entry per job', () => {
  it('appends and caps at MAX_ENTRIES, dropping the oldest', () => {
    let entries: OfficeMemoryEntry[] = []
    for (let i = 1; i <= OFFICE_MEMORY.MAX_ENTRIES + 3; i++) entries = foldMemory(entries, entry(i))
    expect(entries).toHaveLength(OFFICE_MEMORY.MAX_ENTRIES)
    expect(entries[0].jobRef).toBe('#4')
    expect(entries.at(-1)!.jobRef).toBe(`#${OFFICE_MEMORY.MAX_ENTRIES + 3}`)
  })

  it('replaces a prior entry for the same job instead of duplicating it', () => {
    const entries = foldMemory([entry(1), entry(2)], entry(1, { digest: 'revised' }))
    expect(entries).toHaveLength(2)
    expect(entries.at(-1)!.digest).toBe('revised')
    expect(entries.filter((e) => e.jobRef === '#1')).toHaveLength(1)
  })
})

describe('digestDeliverable — bounded and honest about the cut', () => {
  it('folds whitespace and keeps a short deliverable whole', () => {
    expect(digestDeliverable('a\n\n  b\tc')).toBe('a b c')
  })
  it('cuts a long one and says so', () => {
    const d = digestDeliverable('x'.repeat(5000))
    expect(d.length).toBeLessThan(800)
    expect(d).toContain('[cut')
  })
})

describe('renderOfficeMemory — a citable ledger, or nothing', () => {
  it('renders empty entries to the empty string', () => {
    expect(renderOfficeMemory([])).toBe('')
  })
  it('states the provenance rule and cites job and payout per line', () => {
    const text = renderOfficeMemory([entry(7, { paidUsd: 2.29 })])
    expect(text).toContain('passed independent grading and was PAID')
    expect(text).toContain('#7')
    expect(text).toContain('$2.29')
  })
})

describe('the wiring — settle folds, hire injects', () => {
  it('the payout path folds memory next to the work proof, best-effort', () => {
    const src = readFileSync('lib/labor-settle.ts', 'utf8')
    const at = src.indexOf('recordOfficeMemory')
    expect(at).toBeGreaterThan(src.indexOf('issueProofForJobSpec'))
    expect(src.slice(at, at + 300)).toContain('.catch')
  })
  it('hire merges memory into the shared source every role reads', () => {
    const src = readFileSync('lib/office-hire.ts', 'utf8')
    expect(src).toContain('renderedOfficeMemory')
    // Unreadable memory degrades to none — it must never block a hire.
    const at = src.indexOf('renderedOfficeMemory')
    expect(src.slice(at, at + 200)).toContain(".catch(() => '')")
  })
  it('only the paid path writes memory — the server hook requires the office scope', () => {
    const src = readFileSync('lib/office-memory-server.ts', 'utf8')
    expect(src).toContain('if (!spec.officeOwnerId')
  })
})
