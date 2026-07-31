import { describe, expect, it } from 'vitest'
import { gradeForDisplay, submissionLanded } from '@/lib/job-grade'

/**
 * The board said FAILED about a submission the chain never received.
 *
 * Base mainnet job #3: status `Accepted`, `resultHash` zero, and a red
 * "Acceptance tests FAILED" on the card. Both facts were true — the runtime
 * produced a refusal and the grader failed it — and together they told a reader
 * something false: that a deliverable had arrived and lost.
 */

const ZERO = `0x${'0'.repeat(64)}`
const REAL = '0x94e18991000000000000000000000000000000000000000000000000000000ab'
const GRADE = { passed: false, output: 'refusal', gradedAt: '2026-07-31T08:20:00Z' }

describe('did a submission land', () => {
  it('says no for the untouched slot, which is what Accepted jobs hold', () => {
    expect(submissionLanded(ZERO)).toBe(false)
  })

  it("says no for V1's '0x' placeholder and for absence", () => {
    expect(submissionLanded('0x')).toBe(false)
    expect(submissionLanded(null)).toBe(false)
    expect(submissionLanded(undefined)).toBe(false)
    expect(submissionLanded('')).toBe(false)
  })

  it('says yes for a real hash, in either case, with or without 0x', () => {
    expect(submissionLanded(REAL)).toBe(true)
    expect(submissionLanded(REAL.toUpperCase())).toBe(true)
    expect(submissionLanded(REAL.slice(2))).toBe(true)
  })

  it('does not mistake a hash that merely STARTS with zeros for an empty one', () => {
    // The naive check — trimming zeros, or comparing a prefix — would call this
    // untouched. keccak output beginning with a zero byte is ordinary.
    expect(submissionLanded(`0x${'0'.repeat(60)}beef`)).toBe(true)
  })
})

describe('the grade a job card may show', () => {
  it('withholds the verdict while the chain has no submission — mainnet job #3', () => {
    expect(gradeForDisplay(ZERO, GRADE)).toBeNull()
  })

  it('shows it once the submission actually landed', () => {
    expect(gradeForDisplay(REAL, GRADE)).toEqual(GRADE)
  })

  it('stays null when there is no grade either way', () => {
    expect(gradeForDisplay(REAL, null)).toBeNull()
    expect(gradeForDisplay(ZERO, null)).toBeNull()
  })
})
