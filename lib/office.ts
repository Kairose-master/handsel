/**
 * Office connections — "visit someone else's office with a code."
 *
 * Each account gets one shareable code. Redeeming another account's code
 * connects the two — not a permission grant (the market is already
 * permissionless on-chain; `acceptJob` has no allowlist, and adding one would
 * mean a contract change, the same category of risk as H-03's fix, not
 * something a social feature earns) but a DISCOVERY relationship: which
 * offices show up in each other's "visit" view, and later, which review
 * subtasks get curated toward each other instead of the flat public board.
 *
 * Deliberately NOT a new collusion-discount mechanism. Two connected offices
 * that only ever review each other are exactly the star topology
 * `lib/credit-engine/counterparty-graph.ts` already prices down — that graph
 * is built from real settled trades (JOB_COMPLETED events), not from an
 * explicit "these accounts are linked" table, so it catches this pattern
 * automatically as long as office-connected reviews flow through the same
 * job/event pipeline as any other job. This file adds no new scoring logic
 * on purpose.
 *
 * `OfficeBook` is the pure state machine (fully unit-testable, no randomness,
 * no DB). The exported functions back it with a self-migrating Postgres pair
 * of tables, same shape as `lib/claim-ticket.ts`.
 */
import { pool } from '@/lib/db'
import { nanoid } from 'nanoid'
import { MAX_OFFICE_SLOTS } from '@/lib/office-world-data'

export type ConnectResult = { connected: true; ownerId: string } | { connected: false; reason: 'unknown-code' | 'self' }

/** Pure, in-memory model of office codes and connections. */
export class OfficeBook {
  private codeOwner = new Map<string, string>() // code -> ownerId
  private ownerCode = new Map<string, string>() // ownerId -> current code
  private connections = new Set<string>() // canonical "a|b" pair key, a < b

  private static pairKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }

  /** Register (or replace) an owner's shareable code. Replacing it retires
   *  the old one — a leaked code can be invalidated by regenerating. */
  setCode(ownerId: string, code: string): void {
    const old = this.ownerCode.get(ownerId)
    if (old) this.codeOwner.delete(old)
    this.codeOwner.set(code, ownerId)
    this.ownerCode.set(ownerId, code)
  }

  codeFor(ownerId: string): string | undefined {
    return this.ownerCode.get(ownerId)
  }

  /** Redeem `code` as `visitorId`. Idempotent — visiting twice just confirms
   *  the connection. Visiting your own code is rejected: connecting to
   *  yourself isn't a relationship. */
  connect(code: string, visitorId: string): ConnectResult {
    const ownerId = this.codeOwner.get(code)
    if (!ownerId) return { connected: false, reason: 'unknown-code' }
    if (ownerId === visitorId) return { connected: false, reason: 'self' }
    this.connections.add(OfficeBook.pairKey(ownerId, visitorId))
    return { connected: true, ownerId }
  }

  isConnected(a: string, b: string): boolean {
    return this.connections.has(OfficeBook.pairKey(a, b))
  }
}

async function ensureTables(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS office_codes (
       user_id text PRIMARY KEY,
       code text UNIQUE NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS office_connections (
       user_a text NOT NULL,
       user_b text NOT NULL,
       connected_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (user_a, user_b)
     )`,
  )
}

function pairOrdered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

/** This user's shareable office code, generated on first request and stable
 *  after that (call `regenerateOfficeCode` to invalidate and replace it). */
export async function officeCodeFor(userId: string): Promise<string> {
  await ensureTables()
  const existing = await pool.query<{ code: string }>(`SELECT code FROM office_codes WHERE user_id = $1`, [userId])
  if (existing.rows[0]) return existing.rows[0].code
  const code = nanoid(8)
  // Race-safe: if another request generated one concurrently, keep theirs.
  await pool.query(
    `INSERT INTO office_codes (user_id, code) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [userId, code],
  )
  const after = await pool.query<{ code: string }>(`SELECT code FROM office_codes WHERE user_id = $1`, [userId])
  return after.rows[0]?.code ?? code
}

/** Invalidate the current code and issue a new one — the leaked-code escape
 *  hatch. Existing connections are untouched; only future redemptions of the
 *  OLD code stop working. */
export async function regenerateOfficeCode(userId: string): Promise<string> {
  await ensureTables()
  const code = nanoid(8)
  await pool.query(
    `INSERT INTO office_codes (user_id, code) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code, created_at = now()`,
    [userId, code],
  )
  return code
}

export type RedeemResult = { connected: true; ownerId: string } | { connected: false; reason: 'unknown-code' | 'self' }

/** Redeem a code as `visitorId` — connects both offices. Idempotent. */
export async function redeemOfficeCode(code: string, visitorId: string): Promise<RedeemResult> {
  await ensureTables()
  const { rows } = await pool.query<{ user_id: string }>(`SELECT user_id FROM office_codes WHERE code = $1`, [code])
  const ownerId = rows[0]?.user_id
  if (!ownerId) return { connected: false, reason: 'unknown-code' }
  if (ownerId === visitorId) return { connected: false, reason: 'self' }
  const [a, b] = pairOrdered(ownerId, visitorId)
  await pool.query(`INSERT INTO office_connections (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [a, b])
  return { connected: true, ownerId }
}

export async function isOfficeConnected(a: string, b: string): Promise<boolean> {
  if (a === b) return true // one's own office is always "visitable"
  await ensureTables()
  const [x, y] = pairOrdered(a, b)
  const { rows } = await pool.query(`SELECT 1 FROM office_connections WHERE user_a = $1 AND user_b = $2`, [x, y])
  return rows.length > 0
}

/** Every account connected to `userId`, most recent first. */
export async function connectedOfficesOf(userId: string): Promise<string[]> {
  await ensureTables()
  const { rows } = await pool.query<{ other: string }>(
    `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS other
     FROM office_connections WHERE user_a = $1 OR user_b = $1
     ORDER BY connected_at DESC`,
    [userId],
  )
  return rows.map((r) => r.other)
}

/**
 * Whether a job scoped to `officeOwnerId` (null = public, unrestricted)
 * should be shown to `viewerUserId` (null = anonymous caller, e.g. GET
 * /api/tasks — which can never be "connected" to anyone). Pure: takes the
 * connection fact as an argument so the decision table is testable without a
 * database. `canSeeOfficeOnlyJob` below is the thin DB-backed wrapper.
 */
export function officeJobVisible(officeOwnerId: string | null, viewerUserId: string | null, connected: boolean): boolean {
  if (!officeOwnerId) return true // not office-scoped — unchanged public behavior
  if (!viewerUserId) return false // anonymous can never see a scoped job
  if (viewerUserId === officeOwnerId) return true // owners always see their own
  return connected
}

/** DB-backed: resolves the connection fact and applies `officeJobVisible`. */
export async function canSeeOfficeOnlyJob(officeOwnerId: string | null, viewerUserId: string | null): Promise<boolean> {
  if (!officeOwnerId || !viewerUserId || viewerUserId === officeOwnerId) {
    return officeJobVisible(officeOwnerId, viewerUserId, false)
  }
  return officeJobVisible(officeOwnerId, viewerUserId, await isOfficeConnected(officeOwnerId, viewerUserId))
}

/**
 * Multiple offices per account, cap `MAX_OFFICE_SLOTS`. One account, one
 * office — the only mode before this — is just the one-slot case: an
 * account with zero office_slots rows still has a real slot 1, named
 * lazily on first read so a fresh account never needs a migration-time
 * backfill, and an agent with no agent_office_slot row is slot 1 too.
 *
 * Which slot an agent belongs to lives in its OWN table
 * (`agent_office_slot`), not a column on `agent` — `agent` is selected via
 * `db.select().from(agent)` (no explicit column list) at dozens of call
 * sites across the app, and drizzle expands that to name every column
 * schema.ts declares. A new column there breaks every one of those call
 * sites the moment this deploys, until someone runs `pnpm db:migrate` —
 * exactly the incident class documented at the top of
 * lib/db/ensure-columns.ts. A brand-new table nothing selects from yet has
 * no such window: self-migration alone (like office_codes/
 * office_connections above) is safe.
 *
 * Deliberately NOT extended to `visitOffice`/connections: a connection
 * still resolves to one owner, and viewing that owner's OTHER slots isn't
 * wired here — see app/actions/office.ts's header for the current scope.
 */
const DEFAULT_SLOT_NAME = 'Main Office'

async function ensureOfficeSlotsTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS office_slots (
       user_id text NOT NULL,
       slot integer NOT NULL,
       name text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (user_id, slot)
     )`,
  )
}

/** Whether a new slot can be created given how many the account already has —
 *  pure so the cap is unit-testable without a database. */
export function canCreateOfficeSlot(existingSlotCount: number): boolean {
  return existingSlotCount < MAX_OFFICE_SLOTS
}

export type OfficeSlot = { slot: number; name: string }

/** Every office this account has, slot-ascending. Slot 1 always exists —
 *  created here, named DEFAULT_SLOT_NAME, the first time anyone asks. */
export async function listOfficeSlots(userId: string): Promise<OfficeSlot[]> {
  await ensureOfficeSlotsTable()
  await pool.query(
    `INSERT INTO office_slots (user_id, slot, name) VALUES ($1, 1, $2) ON CONFLICT (user_id, slot) DO NOTHING`,
    [userId, DEFAULT_SLOT_NAME],
  )
  const { rows } = await pool.query<{ slot: number; name: string }>(
    `SELECT slot, name FROM office_slots WHERE user_id = $1 ORDER BY slot ASC`,
    [userId],
  )
  return rows
}

export type CreateSlotResult = { slot: number } | { error: string }

/** Add a new office, up to MAX_OFFICE_SLOTS. */
export async function createOfficeSlot(userId: string, name: string): Promise<CreateSlotResult> {
  const trimmed = name.trim()
  if (!trimmed) return { error: 'Name required' }
  const existing = await listOfficeSlots(userId)
  if (!canCreateOfficeSlot(existing.length)) return { error: `You can have at most ${MAX_OFFICE_SLOTS} offices` }
  const nextSlot = Math.max(...existing.map((s) => s.slot)) + 1
  await pool.query(`INSERT INTO office_slots (user_id, slot, name) VALUES ($1, $2, $3)`, [userId, nextSlot, trimmed])
  return { slot: nextSlot }
}

/** Rename an existing office. Slot 1 can be renamed too — "Main Office" is
 *  just its default, not a fixed identity. */
export async function renameOfficeSlot(userId: string, slot: number, name: string): Promise<{ ok: true } | { error: string }> {
  const trimmed = name.trim()
  if (!trimmed) return { error: 'Name required' }
  await ensureOfficeSlotsTable()
  const { rowCount } = await pool.query(`UPDATE office_slots SET name = $3 WHERE user_id = $1 AND slot = $2`, [userId, slot, trimmed])
  if (!rowCount) return { error: 'No such office' }
  return { ok: true }
}

async function ensureAgentOfficeSlotTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS agent_office_slot (
       agent_id text PRIMARY KEY,
       slot integer NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
}

/** Record which office a newly hired agent belongs to. Only worth a row
 *  when it isn't slot 1 — an agent absent from this table simply reads as
 *  slot 1 everywhere below, so the common (one-office) case never writes
 *  here at all. */
export async function setAgentOfficeSlot(agentId: string, slot: number): Promise<void> {
  if (slot === 1) return
  await ensureAgentOfficeSlotTable()
  await pool.query(
    `INSERT INTO agent_office_slot (agent_id, slot) VALUES ($1, $2)
     ON CONFLICT (agent_id) DO UPDATE SET slot = $2, updated_at = now()`,
    [agentId, slot],
  )
}

/** Every given agent's office slot, defaulting to 1 for any id absent from
 *  the table (never hired into a non-default office). */
export async function officeSlotsByAgentId(agentIds: string[]): Promise<Map<string, number>> {
  const result = new Map(agentIds.map((id) => [id, 1]))
  if (agentIds.length === 0) return result
  await ensureAgentOfficeSlotTable()
  const { rows } = await pool.query<{ agent_id: string; slot: number }>(
    `SELECT agent_id, slot FROM agent_office_slot WHERE agent_id = ANY($1)`,
    [agentIds],
  )
  for (const row of rows) result.set(row.agent_id, row.slot)
  return result
}
