/**
 * Repo Care pilot billing: the Lemon Squeezy webhook signature, reading an
 * order out of it, and the wiring pins the pure functions can't cover —
 * the route verifies before it parses, and a payment page never ships a
 * dead button.
 */
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  OFFICE_SUBSCRIPTION_TIERS,
  PILOT_OFFER,
  parsePilotOrder,
  parseSubscriptionEvent,
  repoCareWithinTierLimits,
  tierIdForVariantName,
  verifyLemonSqueezySignature,
} from '@/lib/billing'

const read = (p: string) => readFileSync(p, 'utf8')

describe('the offer', () => {
  it('is the one docs/positioning.md and docs/billing.md both describe', () => {
    expect(PILOT_OFFER.priceUsd).toBe(500)
    expect(PILOT_OFFER.days).toBe(14)
  })
})

describe('OFFICE_SUBSCRIPTION_TIERS', () => {
  it('is three ordered, distinct plans that scale repo limit with price', () => {
    expect(OFFICE_SUBSCRIPTION_TIERS.map((t) => t.id)).toEqual(['starter', 'growth', 'studio'])
    for (let i = 1; i < OFFICE_SUBSCRIPTION_TIERS.length; i++) {
      expect(OFFICE_SUBSCRIPTION_TIERS[i].priceUsdPerMonth).toBeGreaterThan(OFFICE_SUBSCRIPTION_TIERS[i - 1].priceUsdPerMonth)
      expect(OFFICE_SUBSCRIPTION_TIERS[i].repoLimit).toBeGreaterThan(OFFICE_SUBSCRIPTION_TIERS[i - 1].repoLimit)
    }
  })
})

describe('tierIdForVariantName', () => {
  it('matches a Lemon Squeezy variant name to a tier id, case-insensitively', () => {
    expect(tierIdForVariantName('Starter')).toBe('starter')
    expect(tierIdForVariantName('growth')).toBe('growth')
    expect(tierIdForVariantName('  Studio  ')).toBe('studio')
  })

  it('is null for anything unmatched or absent', () => {
    expect(tierIdForVariantName(null)).toBeNull()
    expect(tierIdForVariantName('Enterprise')).toBeNull()
    expect(tierIdForVariantName('')).toBeNull()
  })
})

describe('repoCareWithinTierLimits', () => {
  const starter = OFFICE_SUBSCRIPTION_TIERS[0]
  it('allows a repo under the cap with a wave within the plan ceiling', () => {
    expect(repoCareWithinTierLimits(starter, 0, 3)).toBe(true)
  })
  it('refuses at or over the repo cap, or a wave above the plan ceiling', () => {
    expect(repoCareWithinTierLimits(starter, 1, 3)).toBe(false)
    expect(repoCareWithinTierLimits(starter, 0, 4)).toBe(false)
  })
})

describe('parseSubscriptionEvent', () => {
  const evt = (over: Record<string, unknown> = {}) => ({
    meta: { event_name: 'subscription_created' },
    data: { id: 'sub_1', attributes: { user_email: 'Buyer@Example.com', status: 'active', variant_name: 'Growth', renews_at: '2026-10-05T00:00:00Z', test_mode: false, ...over } },
  })

  it('reads a real subscription event', () => {
    expect(parseSubscriptionEvent(evt())).toEqual({
      subscriptionId: 'sub_1',
      email: 'buyer@example.com',
      status: 'active',
      variantName: 'Growth',
      renewsAt: '2026-10-05T00:00:00Z',
      endsAt: null,
      testMode: false,
      eventName: 'subscription_created',
    })
  })

  it('accepts every subscription lifecycle event name', () => {
    for (const name of ['subscription_updated', 'subscription_cancelled', 'subscription_expired', 'subscription_paused', 'subscription_payment_success']) {
      const e = evt()
      ;(e.meta as { event_name: string }).event_name = name
      expect(parseSubscriptionEvent(e)?.eventName).toBe(name)
    }
  })

  it('falls back to active for an unrecognised status rather than throwing', () => {
    expect(parseSubscriptionEvent(evt({ status: 'weird' }))?.status).toBe('active')
  })

  it('is null for anything that is not a usable subscription event', () => {
    expect(parseSubscriptionEvent(null)).toBeNull()
    expect(parseSubscriptionEvent('a string')).toBeNull()
    expect(parseSubscriptionEvent({})).toBeNull()
    expect(parseSubscriptionEvent({ meta: { event_name: 'order_created' }, data: { id: '1', attributes: { user_email: 'a@b.com' } } })).toBeNull()
    expect(parseSubscriptionEvent({ meta: { event_name: 'subscription_created' }, data: { attributes: { user_email: 'a@b.com' } } })).toBeNull() // no id
    expect(parseSubscriptionEvent({ meta: { event_name: 'subscription_created' }, data: { id: '1', attributes: {} } })).toBeNull() // no email
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

  it('a subscription event updates the row in place — its status is a lifecycle, not a one-shot fact', () => {
    const server = read('lib/billing-server.ts')
    expect(server).toContain('CREATE TABLE IF NOT EXISTS office_subscription')
    expect(server).toContain('ON CONFLICT (subscription_id) DO UPDATE SET')
  })

  it('the webhook route also records subscription lifecycle events', () => {
    const route = read('app/api/webhooks/lemonsqueezy/route.ts')
    expect(route).toContain('parseSubscriptionEvent(body)')
    expect(route).toContain('recordSubscriptionEvent(subscription)')
  })

  it('/admin/pilots also shows office subscriptions, gated the same way', () => {
    expect(read('app/actions/pilots.ts')).toContain('export async function getOfficeSubscriptions')
    expect(read('app/(dashboard)/admin/pilots/page.tsx')).toContain('getOfficeSubscriptions')
  })

  it('/repo-care never renders a checkout link with nothing behind it', () => {
    const page = read('app/repo-care/page.tsx')
    expect(page).toContain('LEMONSQUEEZY_PILOT_CHECKOUT_URL')
    expect(page).toContain('<PublicShell')
    expect(page).toContain('<RepoCarePricing checkoutUrl={checkoutUrl} subscriptionCheckoutUrls={subscriptionCheckoutUrls} />')
    const pricing = read('components/repo-care-pricing.tsx')
    expect(pricing).toMatch(/checkoutUrl \?/)
    expect(pricing).toContain('mailto:')
  })

  it('the pricing section sells the real pilot and the real subscription tiers — no invented toggle', () => {
    // The owner explicitly overrode the earlier "no subscription ladder"
    // rule (lib/billing.ts, 2026-09-05) — OFFICE_SUBSCRIPTION_TIERS are real,
    // anchored prices with real checkout links, not a fourth invented tier.
    // What is still refused: a monthly/yearly toggle dressed up as a plan.
    const pricing = read('components/repo-care-pricing.tsx')
    expect(pricing).toContain('PILOT_OFFER.priceUsd')
    expect(pricing).toContain('PILOT_OFFER.days')
    expect(pricing).toContain('OFFICE_SUBSCRIPTION_TIERS')
    expect(pricing).not.toMatch(/useState.*billing|billingCycle|toggle.*yearly/i)
  })

  it('every subscription checkout link falls back to a mailto, never a dead link', () => {
    const pricing = read('components/repo-care-pricing.tsx')
    const subs = pricing.slice(pricing.indexOf('subscriptionCheckoutUrls'))
    expect(subs).toContain('mailto:hello@handsel.dev')
  })

  it('/admin/pilots is gated on the billing permission, not just a session', () => {
    expect(read('app/actions/pilots.ts')).toContain("requirePermission('billing')")
    expect(read('lib/admin.ts')).toContain("'billing'")
  })
})
