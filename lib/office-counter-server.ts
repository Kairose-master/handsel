/**
 * The counter's DB half: the instructions table, and the agent it
 * provisions the first time an owner saves something.
 *
 * "기본으로 두고" (make it the default) is the whole design constraint here:
 * saving an instruction is the ONLY step. There is no separate "hire a
 * counter" action — `setCounterInstructions` creates the agent, puts it in
 * the office roster, and turns its auto-reply on, all in the one call the
 * owner already made by typing into the box.
 *
 * A dedicated `office_counter` table rather than an `agent` column, same
 * reasoning as `agent_auto_reply` (see lib/agent-reply-server.ts's header):
 * a new `agent` column breaks every `select()` on that table from the
 * moment it deploys until a manual admin migration runs, and this repo's
 * deploys are automatic while migrations are not.
 *
 * A dedicated table rather than reusing `office_source`, even though both
 * are "one shared text for the office": `office_source` is a WORK BRIEF,
 * injected at HIRE TIME and deliberately frozen after — "editing it later
 * doesn't rewrite an office already hired, because a brief that changed
 * under a posted job would move the target the worker is graded against."
 * Counter instructions are the opposite: a live policy that must apply to
 * the very next reply, not a snapshot taken once. Conflating the two would
 * either freeze a policy an owner just tried to fix, or let a work brief
 * change out from under a graded job — both wrong, for the same reason.
 */
import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import { db, pool } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { setAgentOfficeSlot } from '@/lib/office'
import { setAutoReplyFlag } from '@/lib/agent-reply-server'
import { MAX_COUNTER_INSTRUCTIONS_CHARS, defaultCounterName, normalizeCounterInstructions } from '@/lib/office-counter'

let tableReady: Promise<void> | null = null
function ensureTable(): Promise<void> {
  tableReady ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS office_counter (
         user_id text NOT NULL,
         slot integer NOT NULL,
         agent_id text,
         instructions text NOT NULL DEFAULT '',
         updated_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, slot)
       )`,
    )
    .then(() => undefined)
    .catch((error) => {
      tableReady = null
      throw error
    })
  return tableReady
}

export type OfficeCounterView = {
  agentId: string | null
  agentName: string | null
  instructions: string
  maxChars: number
  updatedAt: string | null
}

/** What the office page shows: the saved text, the agent carrying it (once
 *  one exists), and the cap the textarea enforces client-side too. */
export async function getOfficeCounter(userId: string, slot: number): Promise<OfficeCounterView> {
  await ensureTable()
  const { rows } = await pool.query<{ agent_id: string | null; instructions: string; updated_at: Date }>(
    `SELECT agent_id, instructions, updated_at FROM office_counter WHERE user_id = $1 AND slot = $2`,
    [userId, slot],
  )
  const row = rows[0]
  let agentName: string | null = null
  if (row?.agent_id) {
    const [a] = await db.select({ name: agent.name }).from(agent).where(eq(agent.id, row.agent_id))
    agentName = a?.name ?? null
  }
  return {
    agentId: row?.agent_id ?? null,
    agentName,
    instructions: row?.instructions ?? '',
    maxChars: MAX_COUNTER_INSTRUCTIONS_CHARS,
    updatedAt: row?.updated_at ? row.updated_at.toISOString() : null,
  }
}

async function uniqueAgentName(userId: string, base: string): Promise<string> {
  for (const candidate of [base, ...Array.from({ length: 48 }, (_, i) => `${base} ${i + 2}`)]) {
    const [dupe] = await db
      .select({ id: agent.id })
      .from(agent)
      .where(and(eq(agent.userId, userId), eq(agent.name, candidate)))
    if (!dupe) return candidate
  }
  return `${base} ${nanoid(4)}`
}

/**
 * The agent that carries this office's instructions — reused if one
 * already exists and is still this owner's, created (and wired: office
 * slot, a per-agent key, auto-reply on) otherwise.
 *
 * No on-chain account is provisioned. A counter never escrows, never
 * claims a job, never moves money — it only talks — so it needs none of
 * what `office-hire.ts`'s role provisioning exists for, and skipping it
 * keeps "save instructions" instant with no chain dependency.
 */
async function ensureCounterAgent(
  userId: string,
  slot: number,
  existingAgentId: string | null,
  officeName: string,
): Promise<{ id: string; name: string }> {
  if (existingAgentId) {
    const [row] = await db
      .select({ id: agent.id, name: agent.name })
      .from(agent)
      .where(and(eq(agent.id, existingAgentId), eq(agent.userId, userId)))
    if (row) return row
  }

  const name = await uniqueAgentName(userId, defaultCounterName(officeName))
  const agentId = nanoid()
  await db.insert(agent).values({
    id: agentId,
    userId,
    name,
    walletAddress: `0x${randomBytes(20).toString('hex')}`,
    description: 'The front counter — first line for customers and other agents asking what this office does.',
    modelVersion: 'claude-sonnet-5',
    creditScore: '0',
    creditRating: 'unrated',
    riskLevel: 'UNKNOWN',
    riskRating: 'unrated',
    totalCreditLine: '0',
    availableCredit: '0',
  })
  await setAgentOfficeSlot(agentId, slot, 'counter')
  await (await import('@/lib/agent-keys')).ensureAgentKey(agentId)
  // The whole point: instructions with nobody answering them are a memo,
  // not a counter. This is what makes it "the default" rather than one
  // more switch the owner has to remember to also flip.
  await setAutoReplyFlag(agentId, true)
  return { id: agentId, name }
}

export type SetCounterResult = { agentId: string; agentName: string; truncated: boolean }

export async function setCounterInstructions(
  userId: string,
  slot: number,
  raw: string,
  officeName: string,
): Promise<SetCounterResult> {
  await ensureTable()
  const { text, truncated } = normalizeCounterInstructions(raw)

  const { rows } = await pool.query<{ agent_id: string | null }>(
    `SELECT agent_id FROM office_counter WHERE user_id = $1 AND slot = $2`,
    [userId, slot],
  )
  const counterAgent = await ensureCounterAgent(userId, slot, rows[0]?.agent_id ?? null, officeName)

  await pool.query(
    `INSERT INTO office_counter (user_id, slot, agent_id, instructions, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, slot) DO UPDATE SET agent_id = EXCLUDED.agent_id, instructions = EXCLUDED.instructions, updated_at = now()`,
    [userId, slot, counterAgent.id, text],
  )
  return { agentId: counterAgent.id, agentName: counterAgent.name, truncated }
}

/** Read-only lookup by (owner, slot) for a consumer that only needs the
 *  text — the Mail Desk, which already knows which storefront (owner+slot)
 *  is serving a given order. Null for "nothing set", not just empty, so a
 *  caller can skip the extra LLM call entirely rather than composing a
 *  greeting from nothing. */
export async function counterInstructionsFor(userId: string, slot: number): Promise<string | null> {
  await ensureTable()
  const { rows } = await pool.query<{ instructions: string }>(
    `SELECT instructions FROM office_counter WHERE user_id = $1 AND slot = $2 AND instructions <> ''`,
    [userId, slot],
  )
  return rows[0]?.instructions ?? null
}

/** Same lookup, keyed by the AGENT instead of the office — what the
 *  auto-reply engine has in hand (a recipient id), not an office slot. */
export async function counterInstructionsForAgent(agentId: string): Promise<string | null> {
  await ensureTable()
  const { rows } = await pool.query<{ instructions: string }>(
    `SELECT instructions FROM office_counter WHERE agent_id = $1 AND instructions <> ''`,
    [agentId],
  )
  return rows[0]?.instructions ?? null
}
