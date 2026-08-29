/**
 * The Mail Desk's pure parts (lib/mail-desk.ts). The cents-tag arithmetic
 * is the one that touches money attribution — a wrong match sends a
 * stranger's payment to the wrong order — so it gets the adversarial cases.
 */
import { describe, expect, it } from 'vitest'
import {
  extractOrderToken,
  normalizeInboundMail,
  quoteWithUniqueCents,
  usdToUnits,
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
