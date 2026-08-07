import { describe, expect, it } from 'vitest'
import { buildManifest, renderManifestSummary, weakestGraderClass, type ManifestLineInput } from '@/lib/build-manifest'

/**
 * "A build's claim is exactly as strong as its weakest grader class, and the
 * manifest must say so per line rather than laundering an LLM opinion into
 * 'verified'" (docs/build-service.md). These tests are that sentence, pinned:
 * one model-class line downgrades the whole build's claim, a fresh line never
 * inflates it, and the summary text never overstates what happened.
 */

const line = (over: Partial<ManifestLineInput> = {}): ManifestLineInput => ({
  subtaskId: 's1',
  title: 'fix the thing',
  verdict: 'pass',
  amountBaseUnits: '5000000',
  graderClass: 'reproducible',
  proofId: 'proof-1',
  ...over,
})

describe('weakestGraderClass', () => {
  it('is null when nothing has graded', () => {
    expect(weakestGraderClass([line({ verdict: 'pending', graderClass: null })])).toBeNull()
    expect(weakestGraderClass([])).toBeNull()
  })

  it('a single model-class line downgrades the whole build, even alongside reproducible lines', () => {
    const lines = [line({ graderClass: 'reproducible' }), line({ graderClass: 'model' }), line({ graderClass: 'mechanical' })]
    expect(weakestGraderClass(lines)).toBe('model')
  })

  it('all-reproducible stays reproducible', () => {
    expect(weakestGraderClass([line(), line()])).toBe('reproducible')
  })

  it('a pending/refunded line (graderClass null) never weakens a build of otherwise-reproducible lines', () => {
    const lines = [line({ graderClass: 'reproducible' }), line({ verdict: 'refunded', graderClass: null, amountBaseUnits: '0' })]
    expect(weakestGraderClass(lines)).toBe('reproducible')
  })
})

describe('buildManifest', () => {
  it('sums only PASS lines into totalPaidBaseUnits — a refunded or pending line contributes nothing', () => {
    const lines = [
      line({ subtaskId: 's1', verdict: 'pass', amountBaseUnits: '5000000' }),
      line({ subtaskId: 's2', verdict: 'pass', amountBaseUnits: '3000000' }),
      line({ subtaskId: 's3', verdict: 'refunded', amountBaseUnits: '0', graderClass: null }),
      line({ subtaskId: 's4', verdict: 'pending', amountBaseUnits: '0', graderClass: null }),
    ]
    const m = buildManifest({ buildId: 'b1', goal: 'ship it', budgetBaseUnits: '20000000', closed: false, refundedBaseUnits: '2000000', lines })
    expect(m.totalPaidBaseUnits).toBe('8000000')
    expect(m.totalRefundedBaseUnits).toBe('2000000')
  })

  it('status is "open" while the envelope is not closed, regardless of line verdicts', () => {
    const m = buildManifest({ buildId: 'b1', goal: 'g', budgetBaseUnits: '1', closed: false, refundedBaseUnits: '0', lines: [line({ verdict: 'pass' })] })
    expect(m.status).toBe('open')
  })

  it('status is "settled" once closed with at least one graded line', () => {
    const m = buildManifest({ buildId: 'b1', goal: 'g', budgetBaseUnits: '1', closed: true, refundedBaseUnits: '0', lines: [line({ verdict: 'pass' })] })
    expect(m.status).toBe('settled')
  })

  it('status is "expired" when closed with nothing ever graded — every subtask failed before a verdict, or the deadline hit empty', () => {
    const m = buildManifest({
      buildId: 'b1',
      goal: 'g',
      budgetBaseUnits: '1',
      closed: true,
      refundedBaseUnits: '1',
      lines: [line({ verdict: 'pending', graderClass: null, amountBaseUnits: '0' })],
    })
    expect(m.status).toBe('expired')
  })

  it('carries the weakest grader class through from weakestGraderClass', () => {
    const lines = [line({ graderClass: 'model' }), line({ graderClass: 'reproducible' })]
    const m = buildManifest({ buildId: 'b1', goal: 'g', budgetBaseUnits: '1', closed: false, refundedBaseUnits: '0', lines })
    expect(m.weakestGraderClass).toBe('model')
  })
})

describe('renderManifestSummary — never overstates what happened', () => {
  it('reports the pass count and dollar totals', () => {
    const m = buildManifest({
      buildId: 'b1',
      goal: 'g',
      budgetBaseUnits: '10000000',
      closed: true,
      refundedBaseUnits: '2000000',
      lines: [line({ subtaskId: 's1', verdict: 'pass', amountBaseUnits: '8000000' }), line({ subtaskId: 's2', verdict: 'refunded', amountBaseUnits: '0', graderClass: null })],
    })
    const summary = renderManifestSummary(m)
    expect(summary).toContain('1/2 subtasks passed')
    expect(summary).toContain('$8.00 paid')
    expect(summary).toContain('$2.00 refunded')
  })

  it('a build with any model-class line says "OPINION, not a recomputation" in the same sentence as the pass count', () => {
    const m = buildManifest({
      buildId: 'b1',
      goal: 'g',
      budgetBaseUnits: '5000000',
      closed: true,
      refundedBaseUnits: '0',
      lines: [line({ verdict: 'pass', amountBaseUnits: '5000000', graderClass: 'model' })],
    })
    expect(renderManifestSummary(m)).toMatch(/OPINION, not a recomputation/)
  })

  it('an all-reproducible build makes the recomputable claim, not the opinion caveat', () => {
    const m = buildManifest({
      buildId: 'b1',
      goal: 'g',
      budgetBaseUnits: '5000000',
      closed: true,
      refundedBaseUnits: '0',
      lines: [line({ verdict: 'pass', amountBaseUnits: '5000000', graderClass: 'reproducible' })],
    })
    expect(renderManifestSummary(m)).toMatch(/same verdict for anyone/)
    expect(renderManifestSummary(m)).not.toMatch(/OPINION/)
  })

  it('an ungraded build says so plainly rather than a hollow 0/0', () => {
    const m = buildManifest({ buildId: 'b1', goal: 'g', budgetBaseUnits: '1', closed: false, refundedBaseUnits: '0', lines: [] })
    expect(renderManifestSummary(m)).toMatch(/Nothing graded yet/)
  })
})
