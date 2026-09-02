import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  MIN_APPROVAL_CHARS,
  addressesCriterion,
  approvalFormatInstructions,
  approvalSupport,
  criteriaLines,
} from '@/lib/review-support'

const DELIVERABLE = `# Regional migration note

Egress fell 40% after the cutover, per the 2026 transit report (Cloudflare).
Coverage spans us-east, eu-west and ap-south with no gaps.
p95 latency held at 180ms throughout.
`

const CRITERIA = `- Every figure carries a source.
- Covers all three regions.
- Reports p95 latency.`

const support = (approvalText: string, criteria = CRITERIA) =>
  approvalSupport({ approvalText, deliverable: DELIVERABLE, acceptanceCriteria: criteria })

describe('a rubber stamp does not earn the review fee', () => {
  it('refuses LGTM', () => {
    // The canonical zero-cost approval, and the reason this file exists: after
    // the evidence rule and the verdict stake, approving instantly became the
    // cheapest AND safest strategy available to a reviewer.
    const r = support('LGTM')
    expect(r.supported).toBe(false)
    expect(r.shortfall).toMatch(/what was checked/)
  })

  it('refuses a long approval that still points at nothing', () => {
    // Length is not evidence. A model can produce a paragraph of warm prose
    // about work it never opened.
    const r = support('APPROVE. This is a thorough and well-structured piece of work that meets the bar comfortably.')
    expect(r.supported).toBe(false)
    expect(r.shortfall).toMatch(/quotes nothing/)
  })

  it('refuses an approval whose quotes are not in the deliverable', () => {
    const r = support('APPROVE\nEvery figure is sourced: "egress fell 65% per the 2025 report" — cited.')
    expect(r.supported).toBe(false)
    expect(r.shortfall).toMatch(/not in the deliverable/)
    expect(r.unverifiedQuotes).toHaveLength(1)
  })

  it('accepts an approval that quotes the work and walks the criteria', () => {
    const r = support(
      [
        'APPROVE',
        'Every figure carries a source: "per the 2026 transit report (Cloudflare)" — cited inline.',
        'Covers all three regions: "us-east, eu-west and ap-south" — all present.',
        'Reports p95 latency: "p95 latency held at 180ms" — stated.',
      ].join('\n'),
    )
    expect(r.supported).toBe(true)
    expect(r.verifiedQuotes).toHaveLength(3)
    expect(r.criteriaAddressed).toBe(3)
  })

  it('accepts a partial walk — this is a floor, not a rubric', () => {
    // Demanding every criterion be quoted would turn review into form-filling
    // and give a reviewer a reason to pad. One real citation of one real
    // criterion is already more than a rubber stamp offers.
    const r = support('APPROVE — every figure carries a source, e.g. "the 2026 transit report (Cloudflare)".')
    expect(r.supported).toBe(true)
    expect(r.criteriaAddressed).toBeGreaterThanOrEqual(1)
  })
})

describe('the check never touches the worker', () => {
  it('reports only on the approval, and says nothing about releasing', () => {
    // The whole hazard of this feature: making the worker's escrow depend on a
    // reviewer's paperwork would re-introduce, through a new door, exactly the
    // non-termination this repo just spent a day removing. The shape of the
    // return value is the guarantee — there is no disposition in it.
    const r = support('LGTM')
    expect(Object.keys(r).sort()).toEqual(
      ['criteriaAddressed', 'criteriaTotal', 'shortfall', 'supported', 'unverifiedQuotes', 'verifiedQuotes'].sort(),
    )
  })

  it('is tolerant when the job stated no criteria at all', () => {
    // No criteria means nothing to walk; a quote of the work is the whole bar.
    const r = support('APPROVE — the figure "p95 latency held at 180ms" checks out against the source data.', '')
    expect(r.supported).toBe(true)
    expect(r.criteriaTotal).toBe(0)
  })
})

describe('reading the criteria', () => {
  it('splits a bulleted block into criteria', () => {
    expect(criteriaLines(CRITERIA)).toEqual([
      'Every figure carries a source.',
      'Covers all three regions.',
      'Reports p95 latency.',
    ])
  })

  it('ignores noise lines that are not criteria', () => {
    expect(criteriaLines('Acceptance:\n\n- Ships a diff.\n\n  \n- ok')).toEqual(['Acceptance:', 'Ships a diff.'])
  })

  it('matches a criterion on its own content words, not on filler', () => {
    // "the work must be provided for each task" shares only stopwords with
    // anything; matching on those would pass every approval ever written.
    expect(addressesCriterion('I checked that every figure carries a source', 'Every figure carries a source.')).toBe(true)
    expect(addressesCriterion('Looks good to me, all of the criteria are met', 'Every figure carries a source.')).toBe(false)
  })
})

describe('the rule is published, not sprung', () => {
  it('tells the reviewer the format and what it costs', () => {
    const help = approvalFormatInstructions()
    expect(help).toMatch(/quote the text/i)
    expect(help).toMatch(/checked against the deliverable/i)
    // And says plainly that the worker is not the one who pays for it.
    expect(help).toMatch(/still releases the worker/i)
    expect(help).toMatch(/does not earn the review fee/i)
  })

  it('states the minimum it enforces', () => {
    expect(support('APPROVE').shortfall).toContain(String('APPROVE'.length))
    expect(MIN_APPROVAL_CHARS).toBeGreaterThan('LGTM'.length)
  })
})

describe('the wiring: the reviewer pays, the worker does not', () => {
  const src = readFileSync('lib/delegation.ts', 'utf8')
  const branch = src.slice(src.indexOf("if (decision === 'release')"), src.indexOf("} else if (decision === 'revise')"))

  it('checks the approval only AFTER the escrow has already been released', () => {
    // Order is the guarantee. A check that ran first could gate the release,
    // and gating a worker's money on a third party's paperwork is the
    // non-termination this repo spent the day removing, arriving through a
    // new door.
    expect(branch.indexOf('approveJob(')).toBeLessThan(branch.indexOf('approvalSupport'))
    expect(branch.indexOf("target.output = target.submittedOutput")).toBeLessThan(branch.indexOf('approvalSupport'))
  })

  it('fails the REVIEWER subtask, never the target', () => {
    const check = branch.slice(branch.indexOf('approvalSupport'))
    expect(check).toContain('reviewer.failed = true')
    expect(check).not.toContain('target.failed = true')
  })

  it('does not run on a discarded self-review', () => {
    // A verdict that was never acted on cannot be accountable — the same rule
    // the verdict stake uses.
    expect(branch).toMatch(/if \(!samePerson && approve\)/)
  })

  it('publishes the rule to the reviewer in both briefs', () => {
    // A gate the reviewer is not told about is a trap, and a trap teaches
    // nobody anything.
    expect(src.match(/approvalFormatInstructions\(\)/g)?.length).toBe(2)
  })
})
