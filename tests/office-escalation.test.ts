/**
 * Escalation's pure half (lib/office-escalation.ts). The property worth
 * pinning: a junk or empty reason must never produce a notification that
 * says nothing — that teaches an owner to ignore the next real one.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_ESCALATION_REASON_CHARS,
  buildCustomerNeedEmail,
  buildSystemFailureEmail,
  normalizeEscalationReason,
} from '@/lib/office-escalation'

describe('normalizeEscalationReason', () => {
  it('trims a real reason', () => {
    expect(normalizeEscalationReason('  wants a refund, says the logo is wrong  ')).toBe(
      'wants a refund, says the logo is wrong',
    )
  })

  it('rejects everything that is not real content — never notify with nothing to say', () => {
    expect(normalizeEscalationReason('')).toBeNull()
    expect(normalizeEscalationReason('   ')).toBeNull()
    expect(normalizeEscalationReason(undefined)).toBeNull()
    expect(normalizeEscalationReason(null)).toBeNull()
    expect(normalizeEscalationReason(42)).toBeNull()
    expect(normalizeEscalationReason(true)).toBeNull()
  })

  it('caps a runaway reason — this is a flag, not a case file', () => {
    const out = normalizeEscalationReason('x'.repeat(1000))
    expect(out!.length).toBe(MAX_ESCALATION_REASON_CHARS)
    expect(out!.endsWith('…')).toBe(true)
  })
})

describe('buildSystemFailureEmail', () => {
  it('names the order, the template, and the real error', () => {
    const email = buildSystemFailureEmail({ orderId: 'abc123', templateId: 'venture-lab', error: 'RPC timeout' })
    expect(email.subject).toContain('HS-abc123')
    expect(email.bodyLines.join(' ')).toContain('venture-lab')
    expect(email.bodyLines.join(' ')).toContain('RPC timeout')
  })

  it('tells the owner this is the promise made to the customer', () => {
    const email = buildSystemFailureEmail({ orderId: 'x', templateId: 't', error: 'e' })
    expect(email.bodyLines.join(' ')).toMatch(/you can see this and will make it right/)
  })
})

describe('buildCustomerNeedEmail', () => {
  it('leads with the classifier’s reason, not the raw email', () => {
    const email = buildCustomerNeedEmail({
      fromEmail: 'a@b.co',
      subject: 'this is unacceptable',
      reason: 'Says the delivered work does not match spec and wants a refund.',
    })
    expect(email.bodyLines).toContain('Says the delivered work does not match spec and wants a refund.')
    expect(email.bodyLines.join(' ')).toContain('a@b.co')
  })

  it('makes explicit that the customer already got the normal reply', () => {
    const email = buildCustomerNeedEmail({ fromEmail: 'a@b.co', subject: 's', reason: 'r' })
    expect(email.bodyLines.join(' ')).toMatch(/in addition to it, not instead of it/)
  })

  it('caps a long subject in its own subject line rather than overflowing it', () => {
    const email = buildCustomerNeedEmail({ fromEmail: 'a@b.co', subject: 'x'.repeat(200), reason: 'r' })
    expect(email.subject.length).toBeLessThan(120)
  })
})
