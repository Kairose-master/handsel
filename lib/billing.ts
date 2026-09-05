/**
 * The Repo Care offers — pilot and subscription — and reading what Lemon
 * Squeezy tells us about them.
 *
 * Stripe does not onboard a Korea-domiciled seller directly. Lemon Squeezy is
 * the merchant of record instead — it is the one that legally "sells" to the
 * customer, handles the card and the tax, and pays out to a bank account it
 * itself supports (docs/billing.md has the account-setup runbook, which is
 * the operator's job, not a code change). What this module does is verify a
 * webhook came from Lemon Squeezy and read the one fact this platform needs
 * out of it — nothing here calls Lemon Squeezy's API, and nothing here holds
 * a card number.
 *
 * **2026-09-05 — the owner's call, overriding this file's own prior note:**
 * this used to say "not a subscription ladder nobody has bought yet — add
 * tiers once a real pilot sells." The owner decided not to wait: the funnel
 * is free sandbox → one-time pilot → recurring office subscription, and the
 * subscription rung is built now rather than after the pilot converts. The
 * `OFFICE_SUBSCRIPTION_TIERS` prices below are an initial anchor, the same
 * way `PILOT_OFFER.priceUsd` was — the $299 Starter figure carries over from
 * what `/repo-care` was already showing before this had a webhook behind it;
 * Growth/Studio scale from it, not from any real subscriber yet. Revise once
 * a real subscriber's willingness to pay says otherwise.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const PILOT_OFFER = {
  name: 'Repo Care pilot',
  priceUsd: 500,
  days: 14,
  summary:
    'One repository, 14 nights. The office reads your backlog, works the tests, docs and low-risk bugs it can verify, and opens pull requests you review in the morning.',
} as const

export type OfficeSubscriptionTier = {
  id: string
  name: string
  priceUsdPerMonth: number
  /** How many repositories a Repo Care session may cover under this plan. */
  repoLimit: number
  /** The `maxPerWave` ceiling (`lib/repo-care.ts`) each of those repos gets, per night. */
  maxPerWave: number
  summary: string
}

/**
 * The recurring rung of the funnel, after the free sandbox and the one-time
 * pilot. Ordered cheapest first — `/repo-care` shows them in this order.
 */
export const OFFICE_SUBSCRIPTION_TIERS: readonly OfficeSubscriptionTier[] = [
  {
    id: 'starter',
    name: 'Starter',
    priceUsdPerMonth: 299,
    repoLimit: 1,
    maxPerWave: 3,
    summary: '저장소 1개, 매일 밤 최대 3개 작업. 파일럿을 계속 이어가는 요금제.',
  },
  {
    id: 'growth',
    name: 'Growth',
    priceUsdPerMonth: 699,
    repoLimit: 3,
    maxPerWave: 5,
    summary: '저장소 최대 3개, 저장소당 매일 밤 최대 5개 작업. 여러 프로젝트를 동시에 돌보는 팀.',
  },
  {
    id: 'studio',
    name: 'Studio',
    priceUsdPerMonth: 1499,
    repoLimit: 10,
    maxPerWave: 8,
    summary: '저장소 최대 10개, 저장소당 매일 밤 최대 8개 작업. 여러 클라이언트를 관리하는 에이전시.',
  },
] as const

/** Case-insensitive match on a Lemon Squeezy variant name → our tier id, so
 *  the operator names the LS variant after the tier (`Starter`, `Growth`,
 *  `Studio`) and the webhook links itself up with no extra config. */
export function tierIdForVariantName(variantName: string | null): string | null {
  if (!variantName) return null
  const norm = variantName.trim().toLowerCase()
  return OFFICE_SUBSCRIPTION_TIERS.find((t) => t.name.toLowerCase() === norm)?.id ?? null
}

/**
 * Lemon Squeezy signs every webhook body with HMAC-SHA256 over the raw
 * bytes, hex-encoded, in the `X-Signature` header — no `sha256=` prefix,
 * unlike GitHub's. Digest-then-compare, the same shape as
 * `lib/social/instagram/dm.ts`'s `verifyWebhookSignature` and
 * `lib/github-app.ts`'s `verifyGithubSignature`: a length mismatch is
 * rejected before it reaches `timingSafeEqual`, which throws on one.
 */
export function verifyLemonSqueezySignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  if (signatureHeader.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(signatureHeader, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

export type PilotOrder = {
  orderId: string
  email: string
  name: string | null
  totalUsd: number
  /** A Lemon Squeezy test-mode transaction — a real card was never charged. */
  testMode: boolean
  createdAt: string
}

/**
 * Lift an `order_created` webhook body into the one thing this platform
 * keeps: who paid, how much, and whether Lemon Squeezy was in test mode.
 * Every other event name (`subscription_*`, `order_refunded`, …) and every
 * malformed body reads as "not an order" — there is no second product yet
 * for those to mean anything about, and a route that can't parse a body
 * must not throw on it.
 */
export function parsePilotOrder(body: unknown): PilotOrder | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const meta = b.meta as Record<string, unknown> | undefined
  if (meta?.event_name !== 'order_created') return null
  const data = b.data as Record<string, unknown> | undefined
  const attrs = data?.attributes as Record<string, unknown> | undefined
  if (!attrs) return null
  const id = data?.id
  if (typeof id !== 'string' && typeof id !== 'number') return null
  const email = attrs.user_email
  if (typeof email !== 'string' || !email.includes('@')) return null
  const totalCents = attrs.total
  if (typeof totalCents !== 'number' || !Number.isFinite(totalCents)) return null
  return {
    orderId: String(id),
    email: email.trim().toLowerCase().slice(0, 200),
    name: typeof attrs.user_name === 'string' && attrs.user_name.trim() ? attrs.user_name.trim().slice(0, 200) : null,
    totalUsd: Math.round(totalCents) / 100,
    testMode: attrs.test_mode === true,
    createdAt: typeof attrs.created_at === 'string' ? attrs.created_at : new Date().toISOString(),
  }
}

const SUBSCRIPTION_EVENT_NAMES = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
  'subscription_payment_success',
  'subscription_payment_failed',
])

const SUBSCRIPTION_STATUSES = ['active', 'on_trial', 'paused', 'past_due', 'unpaid', 'cancelled', 'expired'] as const

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export type SubscriptionEvent = {
  subscriptionId: string
  email: string
  status: SubscriptionStatus
  /** The Lemon Squeezy variant name, e.g. "Starter" — matched to a tier id via `tierIdForVariantName`. */
  variantName: string | null
  renewsAt: string | null
  endsAt: string | null
  testMode: boolean
  eventName: string
}

/**
 * Lift any `subscription_*` webhook body into the one thing this platform
 * keeps: who, which plan, what state it's in. Every other event name and
 * every malformed body reads as "not a subscription event" — this route
 * must not throw on a body it doesn't recognise.
 */
export function parseSubscriptionEvent(body: unknown): SubscriptionEvent | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const meta = b.meta as Record<string, unknown> | undefined
  const eventName = meta?.event_name
  if (typeof eventName !== 'string' || !SUBSCRIPTION_EVENT_NAMES.has(eventName)) return null
  const data = b.data as Record<string, unknown> | undefined
  const attrs = data?.attributes as Record<string, unknown> | undefined
  if (!attrs) return null
  const id = data?.id
  if (typeof id !== 'string' && typeof id !== 'number') return null
  const email = attrs.user_email
  if (typeof email !== 'string' || !email.includes('@')) return null
  const status = attrs.status
  return {
    subscriptionId: String(id),
    email: email.trim().toLowerCase().slice(0, 200),
    status: (SUBSCRIPTION_STATUSES as readonly string[]).includes(status as string) ? (status as SubscriptionStatus) : 'active',
    variantName: typeof attrs.variant_name === 'string' && attrs.variant_name.trim() ? attrs.variant_name.trim().slice(0, 200) : null,
    renewsAt: typeof attrs.renews_at === 'string' ? attrs.renews_at : null,
    endsAt: typeof attrs.ends_at === 'string' ? attrs.ends_at : null,
    testMode: attrs.test_mode === true,
    eventName,
  }
}

/**
 * Pure gate for a plan's limits — not wired to `startRepoCareSession` yet.
 * Wiring it needs an email→userId link this platform doesn't have: a paid
 * subscription today lands in `office_subscription` by email, but no route
 * connects that email back to the account that would run the session.
 * Building that link by guessing would be exactly what this file warned
 * against before 2026-09-05 — kept pure and tested so it's ready the moment
 * a real linkage exists.
 */
export function repoCareWithinTierLimits(tier: OfficeSubscriptionTier, currentRepoCount: number, requestedMaxPerWave: number): boolean {
  return currentRepoCount < tier.repoLimit && requestedMaxPerWave <= tier.maxPerWave
}
