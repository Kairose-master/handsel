import { describe, it, expect } from 'vitest'
import {
  CONCENTRATION_THRESHOLD,
  buildCertificationReport,
  renderCertificationReport,
  type GradedJob,
} from '@/lib/certification-report'
import type { GraderClass } from '@/lib/grader-class'

let n = 0
const job = (over: Partial<GradedJob> = {}): GradedJob => ({
  jobId: ++n,
  passed: true,
  graderClass: 'model' as GraderClass,
  requesterAgentId: 'req-a',
  paidUsd: 2,
  attempts: 1,
  at: new Date('2026-09-01T00:00:00Z'),
  ...over,
})

describe('grader classes are never pooled', () => {
  it('reports a rate per class and no overall rate at all', () => {
    // A CI merge and a model's opinion are not the same evidence. One blended
    // "94% pass rate" is the exact overclaim every vendor eval makes, and not
    // making it is the only reason a third party can sell this.
    const r = buildCertificationReport('claude-code', [
      job({ graderClass: 'reproducible', passed: true }),
      job({ graderClass: 'reproducible', passed: false }),
      job({ graderClass: 'model', passed: true }),
    ])
    expect(r.byClass.find((c) => c.graderClass === 'reproducible')!.passRate).toBe(0.5)
    expect(r.byClass.find((c) => c.graderClass === 'model')!.passRate).toBe(1)
    expect(Object.keys(r)).not.toContain('passRate')
  })

  it('says "no evidence" rather than 0% for an unused class', () => {
    // "No jobs graded by CI" and "0% passed under CI" are different sentences
    // and only one of them is true.
    const r = buildCertificationReport('x', [job({ graderClass: 'model' })])
    const ci = r.byClass.find((c) => c.graderClass === 'reproducible')!
    expect(ci.attempted).toBe(0)
    expect(ci.passRate).toBeNull()
  })

  it('names the absence of re-runnable evidence as a limit', () => {
    const r = buildCertificationReport('x', [job({ graderClass: 'model' })])
    expect(r.limits.join(' ')).toMatch(/third party can re-run/)
  })
})

describe('a certificate that cannot be self-dealt', () => {
  it('counts distinct paying counterparties', () => {
    const r = buildCertificationReport('x', [job({ requesterAgentId: 'a' }), job({ requesterAgentId: 'b' }), job({ requesterAgentId: 'a' })])
    expect(r.independentCounterparties).toBe(2)
    expect(r.largestCounterpartyShare).toBeCloseTo(2 / 3, 3)
  })

  it('flags the shape this project found in its own market', () => {
    // The Sybil metric's first finding was that this market is a star centred
    // on its operator. A certificate has to be able to say that about its own
    // subject or it is worthless.
    const single = buildCertificationReport('x', [job({ requesterAgentId: 'a' }), job({ requesterAgentId: 'a' })])
    expect(single.concentrated).toBe(true)
    expect(single.limits[0]).toMatch(/single requester|one requester/)
  })

  it('does not let an unresolved requester inflate independence', () => {
    // Folding unknowns into one bucket would understate concentration;
    // folding them into a known requester would overstate it. Each is its own.
    const r = buildCertificationReport('x', [job({ requesterAgentId: null }), job({ requesterAgentId: null })])
    expect(r.independentCounterparties).toBe(2)
    expect(r.largestCounterpartyShare).toBeLessThan(CONCENTRATION_THRESHOLD)
  })
})

describe('an unsourced figure is absent, never zero', () => {
  it('reports no payment total when no settlement was known', () => {
    const r = buildCertificationReport('x', [job({ paidUsd: null }), job({ paidUsd: null })])
    expect(r.paidUsd).toBeNull()
  })

  it('reports no mean attempts for jobs that predate the retry loop', () => {
    expect(buildCertificationReport('x', [job({ attempts: null })]).meanAttempts).toBeNull()
    expect(buildCertificationReport('x', [job({ attempts: 1 }), job({ attempts: 3 })]).meanAttempts).toBe(2)
  })

  it('establishes nothing, and says so, with no jobs', () => {
    const r = buildCertificationReport('x', [])
    expect(r.totalJobs).toBe(0)
    expect(r.paidUsd).toBeNull()
    expect(r.largestCounterpartyShare).toBeNull()
    expect(r.limits[0]).toMatch(/establishes nothing/)
  })

  it('warns when the sample is too small for any rate to mean anything', () => {
    expect(buildCertificationReport('x', [job(), job()]).limits.join(' ')).toMatch(/Too few/)
  })
})

describe('the artifact that leaves the building', () => {
  const md = renderCertificationReport(
    buildCertificationReport('claude-code', [
      job({ graderClass: 'reproducible', passed: true, requesterAgentId: 'a' }),
      job({ graderClass: 'model', passed: false, requesterAgentId: 'b' }),
    ]),
  )

  it('leads with independence, before any rate', () => {
    // A pass rate read before the concentration behind it is a pass rate that
    // has already done its damage.
    expect(md.indexOf('## Independence')).toBeLessThan(md.indexOf('## Outcomes'))
  })

  it('carries the limits section and explains the dash', () => {
    expect(md).toContain('## What this does not establish')
    expect(md).toMatch(/A dash means the figure could not be sourced\. It never means zero\./)
  })

  it('prints a dash rather than 0 for a class with no evidence', () => {
    expect(md).toMatch(/\| attested \| — \| — \| — \|/)
  })
})
