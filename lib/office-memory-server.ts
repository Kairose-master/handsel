/**
 * Storage and the settle hook for office memory (lib/office-memory.ts).
 *
 * Table follows office_source's pattern (lib/office.ts): self-migrating,
 * keyed (user_id, slot). Entries are stored as JSON — the render is a
 * projection, never the storage, so the caps and the format can change
 * without a migration or a parser.
 */
import { pool } from '@/lib/db'
import {
  foldMemory,
  digestDeliverable,
  renderOfficeMemory,
  type OfficeMemoryEntry,
} from '@/lib/office-memory'

async function ensureOfficeMemoryTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS office_memory (
       user_id text NOT NULL,
       slot integer NOT NULL,
       entries jsonb NOT NULL DEFAULT '[]',
       updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (user_id, slot)
     )`,
  )
}

export async function getOfficeMemory(userId: string, slot: number): Promise<OfficeMemoryEntry[]> {
  await ensureOfficeMemoryTable()
  const { rows } = await pool.query<{ entries: OfficeMemoryEntry[] }>(
    `SELECT entries FROM office_memory WHERE user_id = $1 AND slot = $2`,
    [userId, slot],
  )
  return Array.isArray(rows[0]?.entries) ? rows[0].entries : []
}

/** The memory as brief text, '' when the office has none. */
export async function renderedOfficeMemory(userId: string, slot: number): Promise<string> {
  return renderOfficeMemory(await getOfficeMemory(userId, slot))
}

/**
 * The settle hook: fold one PAID office-scoped job into its office's
 * memory. Called from the payout path, best-effort — a memory failure must
 * never affect an already-settled payout, so every early return here is
 * silent and every throw is the caller's `.catch` to log.
 *
 * The office is resolved from the WORKER: the paid deliverable belongs to
 * the desk whose hired agent produced it, and the worker's office slot is
 * already recorded at hire (setAgentOfficeSlot).
 */
export async function recordOfficeMemory(spec: {
  officeOwnerId?: string | null
  onchainJobId?: number | null
  workerAgentId?: string | null
  agentTaskId?: string | null
  title: string
}, paidUsd: number): Promise<void> {
  if (!spec.officeOwnerId || !spec.onchainJobId || !spec.workerAgentId || !spec.agentTaskId) return

  const { officeSlotsByAgentId } = await import('@/lib/office')
  const slot = (await officeSlotsByAgentId([spec.workerAgentId])).get(spec.workerAgentId)
  if (slot === undefined) return

  const { db } = await import('@/lib/db')
  const { agentTask } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const [task] = await db.select({ output: agentTask.output }).from(agentTask).where(eq(agentTask.id, spec.agentTaskId))
  if (!task?.output?.trim()) return

  const entries = await getOfficeMemory(spec.officeOwnerId, slot)
  const folded = foldMemory(entries, {
    at: new Date().toISOString(),
    jobRef: `#${spec.onchainJobId}`,
    title: spec.title,
    paidUsd,
    digest: digestDeliverable(task.output),
  })
  await ensureOfficeMemoryTable()
  await pool.query(
    `INSERT INTO office_memory (user_id, slot, entries)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (user_id, slot) DO UPDATE SET entries = $3::jsonb, updated_at = now()`,
    [spec.officeOwnerId, slot, JSON.stringify(folded)],
  )
}
