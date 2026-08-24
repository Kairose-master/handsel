'use server'

/**
 * Office connections — server actions for "visit another account's office
 * with a code." See lib/office.ts for what a connection actually means (a
 * discovery relationship, not an access grant — the market stays open).
 */
import { getSession } from '@/lib/get-session'
import { officeCodeFor, regenerateOfficeCode, redeemOfficeCode, connectedOfficesOf } from '@/lib/office'
import { buildOfficeSnapshot } from '@/lib/office-world-server'
import type { OfficeSnapshot } from '@/lib/office-world-data'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session
}

/** My shareable code — generated on first call, stable after that. */
export async function myOfficeCode(): Promise<string> {
  const session = await requireUser()
  return officeCodeFor(session.user.id)
}

/** Invalidate my current code and issue a new one. */
export async function newOfficeCode(): Promise<string> {
  const session = await requireUser()
  return regenerateOfficeCode(session.user.id)
}

export type VisitResult =
  | { connected: true; ownerName: string }
  | { connected: false; reason: 'unknown-code' | 'self' }

/** Redeem someone else's code — connects our two offices. */
export async function visitOffice(code: string): Promise<VisitResult> {
  const session = await requireUser()
  const trimmed = code.trim()
  if (!trimmed) return { connected: false, reason: 'unknown-code' }
  const result = await redeemOfficeCode(trimmed, session.user.id)
  if (!result.connected) return result
  const [owner] = await db.select({ name: user.name }).from(user).where(inArray(user.id, [result.ownerId]))
  return { connected: true, ownerName: owner?.name ?? 'a connected office' }
}

export type ConnectedOffice = { userId: string; name: string }

/** Every office connected to mine, for the visit list. */
export async function myConnectedOffices(): Promise<ConnectedOffice[]> {
  const session = await requireUser()
  const ids = await connectedOfficesOf(session.user.id)
  if (ids.length === 0) return []
  const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))
  const byId = new Map(rows.map((r) => [r.id, r.name]))
  // Preserve connectedOfficesOf's most-recent-first order even though the
  // IN-clause read doesn't.
  return ids.map((id) => ({ userId: id, name: byId.get(id) ?? 'Unnamed office' }))
}

/** The live pixel-office snapshot for my own account — real agent roster,
 *  real state (lib/office-world-data.ts). Polled by the /office page. */
export async function myOfficeWorld(): Promise<OfficeSnapshot> {
  const session = await requireUser()
  return buildOfficeSnapshot(session.user.id, session.user.name ?? 'Owner')
}
