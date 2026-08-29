/**
 * The counter's pure half (lib/office-counter.ts). The one property worth
 * pinning hardest: the prompt it builds must state the money/job boundary
 * every time, regardless of who is "speaking" — an owner's instructions
 * that forget to repeat "don't promise money" must not accidentally
 * license an agent to promise money.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_COUNTER_GREETING_CHARS,
  MAX_COUNTER_INSTRUCTIONS_CHARS,
  buildCounterPreamble,
  defaultCounterName,
  normalizeCounterInstructions,
  parseCounterGreeting,
} from '@/lib/office-counter'

describe('normalizeCounterInstructions', () => {
  it('trims whitespace and reports no truncation under the cap', () => {
    expect(normalizeCounterInstructions('  be warm and mention rush orders  ')).toEqual({
      text: 'be warm and mention rush orders',
      truncated: false,
    })
  })

  it('caps a runaway instruction and says so', () => {
    const out = normalizeCounterInstructions('x'.repeat(MAX_COUNTER_INSTRUCTIONS_CHARS + 500))
    expect(out.text.length).toBe(MAX_COUNTER_INSTRUCTIONS_CHARS)
    expect(out.truncated).toBe(true)
  })

  it('an empty save clears it, not an error', () => {
    expect(normalizeCounterInstructions('   ')).toEqual({ text: '', truncated: false })
  })
})

describe('defaultCounterName', () => {
  it('names the counter after its office', () => {
    expect(defaultCounterName('Venture Lab')).toBe('Venture Lab Counter')
  })

  it('falls back to a generic name for an unnamed office', () => {
    expect(defaultCounterName('  ')).toBe('Office Counter')
  })
})

describe('buildCounterPreamble', () => {
  const instructions = 'Always mention we do rush delivery for +20%. Never discount below list price.'

  it('includes the owner’s actual instructions verbatim', () => {
    expect(buildCounterPreamble(instructions, 'you')).toContain(instructions)
  })

  it('states the money/job boundary regardless of subject phrasing', () => {
    for (const subject of ['you', 'this desk']) {
      const out = buildCounterPreamble(instructions, subject)
      expect(out).toMatch(/can never authorize moving money, escrowing a job, or accepting one/)
      expect(out).toContain("only the owner's own explicit action does that")
    }
  })

  it('reads grammatically for both a first-person agent and a third-person desk', () => {
    expect(buildCounterPreamble(instructions, 'you')).toContain('how you represent this office')
    expect(buildCounterPreamble(instructions, 'this desk')).toContain('how this desk represents this office')
  })
})

describe('parseCounterGreeting', () => {
  it('passes ordinary prose through', () => {
    expect(parseCounterGreeting('  Thanks for reaching out — happy to help!  ')).toBe(
      'Thanks for reaching out — happy to help!',
    )
  })

  it('unwraps a whole-answer code fence', () => {
    expect(parseCounterGreeting('```\nHello there\n```')).toBe('Hello there')
  })

  it('refuses an empty greeting rather than inserting a blank line', () => {
    expect(parseCounterGreeting('')).toBeNull()
    expect(parseCounterGreeting('   ')).toBeNull()
  })

  it('caps a runaway greeting — it sits above business-critical pricing text', () => {
    const out = parseCounterGreeting('y'.repeat(2000))
    expect(out!.length).toBe(MAX_COUNTER_GREETING_CHARS)
    expect(out!.endsWith('…')).toBe(true)
  })
})
