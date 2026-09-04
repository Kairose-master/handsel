/**
 * The Repo Care pilot offer, and reading what Lemon Squeezy tells us about it.
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
 * Scoped to exactly the offer docs/positioning.md §8 asks for: one $500,
 * one-time, 14-day pilot — not a subscription ladder nobody has bought yet.
 * Building tiers before the first pilot sells is the mistake that section
 * warns against; add them once a real customer has paid once.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const PILOT_OFFER = {
  name: 'Repo Care pilot',
  priceUsd: 500,
  days: 14,
  summary:
    'One repository, 14 nights. The office reads your backlog, works the tests, docs and low-risk bugs it can verify, and opens pull requests you review in the morning.',
} as const

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
