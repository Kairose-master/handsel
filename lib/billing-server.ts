/**
 * Where a pilot order lands once Lemon Squeezy tells us about it.
 *
 * A side table, self-migrating like its siblings — `lib/job-lane-server.ts`'s
 * header explains why: a bare `select()` breaks the moment an unmigrated
 * column is added to an existing table, and deploys here are automatic while
 * migrations are not, so a new fact gets a new table instead.
 *
 * Recording the lead is the whole job here — there is no entitlement to flip
 * yet. Onboarding a paid pilot is still a person reading this table and
 * reaching out by hand (`docs/billing.md`), which is the "still owed" the
 * positioning decision (`docs/positioning.md` §8) named on purpose:
 * automating onboarding before there is a second customer to prove it
 * against would be guessing at what that flow should even do.
 */
import { pool } from '@/lib/db'
import type { PilotOrder } from '@/lib/billing'

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
