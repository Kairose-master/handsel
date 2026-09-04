/**
 * Repo Care pilot billing: the Lemon Squeezy webhook signature, reading an
 * order out of it, and the wiring pins the pure functions can't cover —
 * the route verifies before it parses, and a payment page never ships a
 * dead button.
 */
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PILOT_OFFER, parsePilotOrder, verifyLemonSqueezySignature } from '@/lib/billing'

const read = (p: string) => readFileSync(p, 'utf8')

describe('the offer', () => {
  it('is the one docs/positioning.md and docs/billing.md both describe', () => {
    expect(PILOT_OFFER.priceUsd).toBe(500)
    expect(PILOT_OFFER.days).toBe(14)
  })
})

describe('verifyLemonSqueezySignature', () => {
  const secret = 'a-test-webhook-signing-secret'
  const raw = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } })
  const sign = (body: string, key: string) => createHmac('sha256', key).update(body, 'utf8').digest('hex')

  it('accepts the real signature and rejects everything else', () => {
    const sig = sign(raw, secret)
    expect(verifyLemonSqueezySignature(raw, sig, secret)).toBe(true)
    expect(verifyLemonSqueezySignature(raw + ' ', sig, secret)).toBe(false) // tampered body
    expect(verifyLemonSqueezySignature(raw, sig, 'wrong-secret')).toBe(false)
    expect(verifyLemonSqueezySignature(raw, 'deadbeef', secret)).toBe(false) // wrong length, never reaches timingSafeEqual
    expect(verifyLemonSqueezySignature(raw, null, secret)).toBe(false)
    expect(verifyLemonSqueezySignature(raw, sig, '')).toBe(false)
    // no sha256= prefix, unlike GitHub's — a prefixed header must fail
    expect(verifyLemonSqueezySignature(raw, `sha256=${sig}`, secret)).toBe(false)
  })

  it('never throws on a header that is not hex', () => {
    expect(verifyLemonSqueezySignature(raw, 'not-hex-at-all!!', secret)).toBe(false)
  })
})

describe('parsePilotOrder', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    meta: { event_name: 'order_created' },
    data: { id: 'ord_1', attributes: { user_email: 'Buyer@Example.com', user_name: 'Jane Buyer', total: 50000, test_mode: false, created_at: '2026-09-04T00:00:00Z', ...over } },
  })

  it('reads a real order', () => {
    expect(parsePilotOrder(order())).toEqual({
      orderId: 'ord_1',
      email: 'buyer@example.com',
      name: 'Jane Buyer',
      totalUsd: 500,
      testMode: false,
      createdAt: '2026-09-04T00:00:00Z',
    })
  })

  it('marks a Lemon Squeezy test-mode order, never hides it', () => {
    expect(parsePilotOrder(order({ test_mode: true }))?.testMode).toBe(true)
  })

  it('is null for anything that is not a usable order_created', () => {
    expect(parsePilotOrder(null)).toBeNull()
    expect(parsePilotOrder('a string')).toBeNull()
    expect(parsePilotOrder({})).toBeNull()
    expect(parsePilotOrder({ meta: { event_name: 'subscription_created' }, data: { id: '1', attributes: { user_email: 'a@b.com', total: 100 } } })).toBeNull()
    expect(parsePilotOrder({ meta: { event_name: 'order_created' }, data: { attributes: { user_email: 'a@b.com', total: 100 } } })).toBeNull() // no id
    expect(parsePilotOrder({ meta: { event_name: 'order_created' }, data: { id: '1', attributes: { total: 100 } } })).toBeNull() // no email
    expect(parsePilotOrder({ meta: { event_name: 'order_created' }, data: { id: '1', attributes: { user_email: 'not-an-email' } } })).toBeNull()
    expect(parsePilotOrder({ meta: { event_name: 'order_created' }, data: { id: '1', attributes: { user_email: 'a@b.com', total: 'not-a-number' } } })).toBeNull()
  })

  it('has no name when Lemon Squeezy sent none, and defaults created_at rather than throwing', () => {
    const r = parsePilotOrder({ meta: { event_name: 'order_created' }, data: { id: 2, attributes: { user_email: 'x@y.com', total: 50000 } } })
    expect(r?.name).toBeNull()
    expect(r?.orderId).toBe('2')
    expect(typeof r?.createdAt).toBe('string')
  })
})

describe('wiring: signature before parsing, and no dead button', () => {
  it('the webhook route verifies before it reads the body, and always answers', () => {
    const src = read('app/api/webhooks/lemonsqueezy/route.ts')
    const secretCheck = src.indexOf('LEMONSQUEEZY_WEBHOOK_SECRET')
    const verify = src.indexOf('verifyLemonSqueezySignature(')
    const jsonParse = src.indexOf('JSON.parse(raw)')
    expect(secretCheck).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(secretCheck)
    expect(jsonParse).toBeGreaterThan(verify)
    expect(src).toContain("status: 503")
    expect(src).toContain("status: 401")
    // never calls Lemon Squeezy's own API — no fetch to a lemonsqueezy.com endpoint
    expect(src).not.toMatch(/fetch\(['"`]https:\/\/[^'"`]*lemonsqueezy/i)
  })

  it('the record is idempotent on the order id, so a retried delivery cannot double-count', () => {
    expect(read('lib/billing-server.ts')).toContain('ON CONFLICT (order_id) DO NOTHING')
  })

  it('/repo-care never renders a checkout link with nothing behind it', () => {
    const page = read('app/repo-care/page.tsx')
    expect(page).toContain('LEMONSQUEEZY_PILOT_CHECKOUT_URL')
    expect(page).toContain('<PublicShell')
    expect(page).toContain('<RepoCarePricing checkoutUrl={checkoutUrl} />')
    const pricing = read('components/repo-care-pricing.tsx')
    expect(pricing).toMatch(/checkoutUrl \?/)
    expect(pricing).toContain('mailto:')
  })

  it('the pricing section sells exactly the real offer — no fake tiers, no billing toggle', () => {
    // docs/positioning.md §8: no subscription ladder before the first rung
    // has sold once. A monthly/yearly toggle or an invented fourth tier
    // would be exactly that ladder, dressed up as a UI component.
    const pricing = read('components/repo-care-pricing.tsx')
    expect(pricing).toContain('PILOT_OFFER.priceUsd')
    expect(pricing).toContain('PILOT_OFFER.days')
    expect(pricing).not.toMatch(/useState.*billing|billingCycle|toggle.*yearly/i)
  })

  it('/admin/pilots is gated on the billing permission, not just a session', () => {
    expect(read('app/actions/pilots.ts')).toContain("requirePermission('billing')")
    expect(read('lib/admin.ts')).toContain("'billing'")
  })
})
