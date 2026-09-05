/**
 * Where a pilot order or an office subscription lands once Lemon Squeezy
 * tells us about it — `pilot_lead` for the one-time $500 pilot,
 * `office_subscription` for the recurring `OFFICE_SUBSCRIPTION_TIERS` plans
 * (`lib/billing.ts`).
 *
 * Side tables, self-migrating like their siblings — `lib/job-lane-server.ts`'s
 * header explains why: a bare `select()` breaks the moment an unmigrated
 * column is added to an existing table, and deploys here are automatic while
 * migrations are not, so a new fact gets a new table instead.
 *
 * Recording the event is the whole job here — there is no entitlement to
 * flip yet. Onboarding a paid pilot or subscriber is still a person reading
 * these tables and reaching out by hand (`docs/billing.md`); wiring a plan's
 * `repoLimit`/`maxPerWave` to an actual account needs an email→userId link
 * this platform doesn't have yet (`repoCareWithinTierLimits` in
 * `lib/billing.ts` is kept pure and ready for when it does).
 */
import { pool } from '@/lib/db'
import { tierIdForVariantName, type PilotOrder, type SubscriptionEvent } from '@/lib/billing'

let ensured: Promise<void> | null = null

function ensureTable(): Promise<void> {
  ensured ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS pilot_lead (
         order_id   text PRIMARY KEY,
         email      text NOT NULL,
         name       text,
         total_usd  numeric NOT NULL,
         test_mode  boolean NOT NULL DEFAULT false,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined)
    .catch((e) => {
      // Never cache a failure: a transient error at boot would otherwise
      // make every later call skip the create and fail on a missing table.
      ensured = null
      throw e
    })
  return ensured
}

/** Idempotent: the same order id twice (a webhook retry) changes nothing. */
export async function recordPilotLead(order: PilotOrder): Promise<void> {
  await ensureTable()
  await pool.query(
    `INSERT INTO pilot_lead (order_id, email, name, total_usd, test_mode, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (order_id) DO NOTHING`,
    [order.orderId, order.email, order.name, order.totalUsd, order.testMode, order.createdAt],
  )
}

let ensuredSubscription: Promise<void> | null = null

function ensureSubscriptionTable(): Promise<void> {
  ensuredSubscription ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS office_subscription (
         subscription_id text PRIMARY KEY,
         email           text NOT NULL,
         tier_id         text,
         status          text NOT NULL,
         variant_name    text,
         renews_at       timestamptz,
         ends_at         timestamptz,
         test_mode       boolean NOT NULL DEFAULT false,
         updated_at      timestamptz NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined)
    .catch((e) => {
      ensuredSubscription = null
      throw e
    })
  return ensuredSubscription
}

/**
 * Idempotent on the subscription id, but unlike `recordPilotLead` this is an
 * UPDATE on conflict, not DO NOTHING — a subscription has a lifecycle
 * (`on_trial` → `active` → `cancelled`/`past_due`/…), so the same id arrives
 * again with a genuinely different status and the row must move with it.
 */
export async function recordSubscriptionEvent(event: SubscriptionEvent): Promise<void> {
  await ensureSubscriptionTable()
  const tierId = tierIdForVariantName(event.variantName)
  await pool.query(
    `INSERT INTO office_subscription (subscription_id, email, tier_id, status, variant_name, renews_at, ends_at, test_mode, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (subscription_id) DO UPDATE SET
       email = EXCLUDED.email, tier_id = EXCLUDED.tier_id, status = EXCLUDED.status,
       variant_name = EXCLUDED.variant_name, renews_at = EXCLUDED.renews_at, ends_at = EXCLUDED.ends_at,
       test_mode = EXCLUDED.test_mode, updated_at = now()`,
    [event.subscriptionId, event.email, tierId, event.status, event.variantName, event.renewsAt, event.endsAt, event.testMode],
  )
}

export type OfficeSubscriptionRow = {
  subscriptionId: string
  email: string
  tierId: string | null
  status: string
  variantName: string | null
  renewsAt: number | null
  endsAt: number | null
  testMode: boolean
  updatedAt: number
}

/** For the operator's own eyes only (`app/(dashboard)/admin/pilots`), same as `listPilotLeads`. */
export async function listOfficeSubscriptions(limit = 50): Promise<OfficeSubscriptionRow[]> {
  await ensureSubscriptionTable()
  const { rows } = await pool.query<{
    subscription_id: string
    email: string
    tier_id: string | null
    status: string
    variant_name: string | null
    renews_at: Date | null
    ends_at: Date | null
    test_mode: boolean
    updated_at: Date
  }>(`SELECT subscription_id, email, tier_id, status, variant_name, renews_at, ends_at, test_mode, updated_at FROM office_subscription ORDER BY updated_at DESC LIMIT $1`, [limit])
  return rows.map((r) => ({
    subscriptionId: r.subscription_id,
    email: r.email,
    tierId: r.tier_id,
    status: r.status,
    variantName: r.variant_name,
    renewsAt: r.renews_at ? r.renews_at.getTime() : null,
    endsAt: r.ends_at ? r.ends_at.getTime() : null,
    testMode: r.test_mode,
    updatedAt: r.updated_at.getTime(),
  }))
}

export type PilotLeadRow = {
  orderId: string
  email: string
  name: string | null
  totalUsd: number
  testMode: boolean
  createdAt: number
}

/** For the operator's own eyes only (`app/(dashboard)/admin/pilots`) — an
 *  email and a name are personal data, never surfaced on a public page. */
export async function listPilotLeads(limit = 50): Promise<PilotLeadRow[]> {
  await ensureTable()
  const { rows } = await pool.query<{ order_id: string; email: string; name: string | null; total_usd: string; test_mode: boolean; created_at: Date }>(
    `SELECT order_id, email, name, total_usd, test_mode, created_at FROM pilot_lead ORDER BY created_at DESC LIMIT $1`,
    [limit],
  )
  return rows.map((r) => ({
    orderId: r.order_id,
    email: r.email,
    name: r.name,
    totalUsd: Number(r.total_usd),
    testMode: r.test_mode,
    createdAt: r.created_at.getTime(),
  }))
}
