/**
 * The Mail Desk's pure parts (lib/mail-desk.ts). The cents-tag arithmetic
 * is the one that touches money attribution — a wrong match sends a
 * stranger's payment to the wrong order — so it gets the adversarial cases.
 */
import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  extractOrderToken,
  normalizeInboundMail,
  quoteWithUniqueCents,
  resendReceivedEmailId,
  usdToUnits,
  verifyResendWebhookSignature,
} from '@/lib/mail-desk'

describe('quoteWithUniqueCents', () => {
  it('adds a cents tag between 1 and 99 to the base price', () => {
    const q = quoteWithUniqueCents(6, [])
    expect(q).not.toBeNull()
    const cents = Math.round(q! * 100) % 100
    expect(cents).toBeGreaterThanOrEqual(1)
    expect(cents).toBeLessThanOrEqual(99)
    expect(Math.floor(q!)).toBe(6)
  })

  it('never reuses a taken tag', () => {
    const taken = Array.from({ length: 98 }, (_, i) => i + 1) // only 99 free
    const q = quoteWithUniqueCents(6, taken)
    expect(Math.round(q! * 100) % 100).toBe(99)
  })

  it('returns null when all 99 tags are taken — misattribution is never an option', () => {
    const taken = Array.from({ length: 99 }, (_, i) => i + 1)
    expect(quoteWithUniqueCents(6, taken)).toBeNull()
  })

  it('is exact in cents — no float drift', () => {
    const q = quoteWithUniqueCents(11.99, [], () => 0) // picks the first free tag (1)
    expect(q).toBe(12.0)
    expect(usdToUnits(q!)).toBe(12_000_000n)
  })
})

describe('usdToUnits', () => {
  it('converts whole cents to 6-decimal units exactly', () => {
    expect(usdToUnits(6.37)).toBe(6_370_000n)
    expect(usdToUnits(0.01)).toBe(10_000n)
  })

  it('survives the classic float trap (0.1 + 0.2)', () => {
    expect(usdToUnits(0.1 + 0.2)).toBe(300_000n)
  })
})

describe('extractOrderToken', () => {
  it('finds the token in a subject', () => {
    expect(extractOrderToken('Re: Your quote · HS-abc123XYZ_-99', '')).toBe('abc123XYZ_-99')
  })

  it('finds the token in the body when the subject was mangled', () => {
    expect(extractOrderToken('(no subject)', 'my order was HS-abcdefghij123456 thanks')).toBe('abcdefghij123456')
  })

  it('ignores short lookalikes', () => {
    expect(extractOrderToken('HS-abc', 'HS-tooShort1')).toBeNull()
  })
})

describe('normalizeInboundMail', () => {
  it('reads the generic shape', () => {
    expect(normalizeInboundMail({ from: 'Buyer <a@b.co>', subject: 'hi', text: 'body' })).toEqual({
      from: 'a@b.co',
      subject: 'hi',
      text: 'body',
    })
  })

  it('reads the Postmark shape', () => {
    expect(normalizeInboundMail({ From: 'a@b.co', Subject: 's', TextBody: 't' })).toEqual({
      from: 'a@b.co',
      subject: 's',
      text: 't',
    })
  })

  it('lowercases and trims the sender', () => {
    expect(normalizeInboundMail({ from: ' A@B.CO ', subject: '', text: '' })?.from).toBe('a@b.co')
  })

  it('drops payloads with no usable sender', () => {
    expect(normalizeInboundMail({ subject: 'x', text: 'y' })).toBeNull()
    expect(normalizeInboundMail({ from: 'not-an-email', subject: '', text: '' })).toBeNull()
    expect(normalizeInboundMail(null)).toBeNull()
    expect(normalizeInboundMail('string')).toBeNull()
  })

  it('caps runaway subject and body lengths', () => {
    const m = normalizeInboundMail({ from: 'a@b.co', subject: 'x'.repeat(1000), text: 'y'.repeat(100_000) })
    expect(m!.subject.length).toBe(300)
    expect(m!.text.length).toBe(8000)
  })
})

describe('resendReceivedEmailId', () => {
  it('pulls the id out of Resend\'s metadata-only email.received envelope', () => {
    expect(resendReceivedEmailId({ type: 'email.received', data: { email_id: 'abc-123', from: 'a@b.co' } })).toBe(
      'abc-123',
    )
  })

  it('ignores other Resend event types — the desk only subscribes to received', () => {
    expect(resendReceivedEmailId({ type: 'email.delivered', data: { email_id: 'abc-123' } })).toBeNull()
    expect(resendReceivedEmailId({ type: 'email.bounced', data: { email_id: 'abc-123' } })).toBeNull()
  })

  it('returns null for a generic inline-body payload so it falls through to normalizeInboundMail', () => {
    expect(resendReceivedEmailId({ from: 'a@b.co', subject: 's', text: 't' })).toBeNull()
    expect(resendReceivedEmailId({ type: 'email.received', data: {} })).toBeNull()
    expect(resendReceivedEmailId({ type: 'email.received' })).toBeNull()
    expect(resendReceivedEmailId(null)).toBeNull()
    expect(resendReceivedEmailId('string')).toBeNull()
  })
})

describe('verifyResendWebhookSignature', () => {
  const secret = `whsec_${Buffer.from('a-signing-key-of-some-length').toString('base64')}`
  const id = 'msg_2abc'
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'e1' } })
  const nowMs = 1_770_000_000_000
  const timestamp = String(Math.floor(nowMs / 1000))

  const sign = (signedId: string, signedTs: string, signedBody: string, key = secret) =>
    createHmac('sha256', Buffer.from(key.slice('whsec_'.length), 'base64'))
      .update(`${signedId}.${signedTs}.${signedBody}`)
      .digest('base64')

  const headers = (over: Partial<{ id: string; timestamp: string; signature: string }> = {}) => ({
    id,
    timestamp,
    signature: `v1,${sign(id, timestamp, body)}`,
    ...over,
  })

  it('accepts a correctly signed payload', () => {
    expect(verifyResendWebhookSignature(body, headers(), secret, nowMs)).toBe(true)
  })

  it('accepts when one of several rotation signatures matches', () => {
    const stale = sign(id, timestamp, body, `whsec_${Buffer.from('an-older-key').toString('base64')}`)
    const sig = `v1,${stale} v1,${sign(id, timestamp, body)}`
    expect(verifyResendWebhookSignature(body, headers({ signature: sig }), secret, nowMs)).toBe(true)
  })

  it('rejects a tampered body — the whole point of signing', () => {
    expect(verifyResendWebhookSignature(`${body} `, headers(), secret, nowMs)).toBe(false)
  })

  it('rejects a signature bound to a different id or timestamp (replay across messages)', () => {
    expect(verifyResendWebhookSignature(body, headers({ id: 'msg_other' }), secret, nowMs)).toBe(false)
    expect(verifyResendWebhookSignature(body, headers({ timestamp: String(Number(timestamp) - 1) }), secret, nowMs)).toBe(
      false,
    )
  })

  it('rejects a timestamp outside the 5-minute tolerance, in both directions', () => {
    expect(verifyResendWebhookSignature(body, headers(), secret, nowMs + 6 * 60_000)).toBe(false)
    expect(verifyResendWebhookSignature(body, headers(), secret, nowMs - 6 * 60_000)).toBe(false)
    expect(verifyResendWebhookSignature(body, headers(), secret, nowMs + 4 * 60_000)).toBe(true)
  })

  it('rejects the wrong signing key', () => {
    const other = `whsec_${Buffer.from('a-different-signing-key').toString('base64')}`
    expect(verifyResendWebhookSignature(body, headers(), other, nowMs)).toBe(false)
  })

  it('rejects missing headers, junk versions, and malformed secrets', () => {
    expect(verifyResendWebhookSignature(body, headers({ signature: undefined as never }), secret, nowMs)).toBe(false)
    expect(verifyResendWebhookSignature(body, { id: null, timestamp, signature: 'v1,x' }, secret, nowMs)).toBe(false)
    expect(verifyResendWebhookSignature(body, headers({ timestamp: 'not-a-number' }), secret, nowMs)).toBe(false)
    expect(verifyResendWebhookSignature(body, headers({ signature: sign(id, timestamp, body) }), secret, nowMs)).toBe(
      false,
    )
    expect(verifyResendWebhookSignature(body, headers({ signature: `v2,${sign(id, timestamp, body)}` }), secret, nowMs)).toBe(
      false,
    )
    expect(verifyResendWebhookSignature(body, headers(), 'no-whsec-prefix', nowMs)).toBe(false)
  })

  it('rejects a shorter signature that is a prefix of the real one', () => {
    const real = sign(id, timestamp, body)
    const truncated = Buffer.from(Buffer.from(real, 'base64').subarray(0, 16)).toString('base64')
    expect(verifyResendWebhookSignature(body, headers({ signature: `v1,${truncated}` }), secret, nowMs)).toBe(false)
  })
})
