/**
 * Where a person's own harness definitions live.
 *
 * A side table keyed by account, self-migrating on first use, for the reason
 * at the top of lib/db/ensure-columns.ts: drizzle expands
 * `db.select().from(agent)` to name every declared column, so a new one
 * breaks every read of that table until someone migrates by hand.
 *
 * These are definitions, not credentials. Nothing here is secret — a binary
 * name and an argument template — and nothing here is executed by the
 * platform. The only thing that ever runs them is the owner's own worker, on
 * their own machine, from a command line they pasted having read it.
 */
import { pool } from '@/lib/db'
import { parseCustomHarness, type CustomHarness } from '@/lib/custom-harness'

let ready: Promise<void> | null = null

async function ensureTable(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS custom_harness (
           user_id text NOT NULL,
           id text NOT NULL,
           label text NOT NULL,
           bin text NOT NULL,
           args_template text NOT NULL DEFAULT '',
           brief_on_stdin boolean NOT NULL DEFAULT false,
           deliverable_path text NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (user_id, id)
         )`,
      )
      .then(() => undefined)
      .catch((e) => {
        ready = null // not cached on failure, or every later call believes it exists
        throw e
      })
  }
  return ready
}

type Row = {
  id: string
  label: string
  bin: string
  args_template: string
  brief_on_stdin: boolean
  deliverable_path: string
  updated_at: Date
}

export type StoredHarness = CustomHarness & { updatedAt: number }

function toHarness(r: Row): StoredHarness {
  return {
    id: r.id,
    label: r.label,
    bin: r.bin,
    argsTemplate: r.args_template,
    briefOnStdin: r.brief_on_stdin,
    deliverablePath: r.deliverable_path,
    updatedAt: r.updated_at.getTime(),
  }
}

/** How many one account may keep. A definition is cheap; a list nobody can
 *  read is not, and this is a page before it is a database row. */
export const MAX_HARNESSES_PER_USER = 20

export async function listHarnesses(userId: string): Promise<StoredHarness[]> {
  try {
    await ensureTable()
    const { rows } = await pool.query<Row>(
      `SELECT * FROM custom_harness WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId],
    )
    return rows.map(toHarness)
  } catch {
    // The page is worth showing with the built-in adapters alone.
    return []
  }
}

/**
 * Store one, re-validating server-side.
 *
 * The form already validates as you type, and that is a convenience for the
 * person typing — not a check. This is the check.
 */
export async function saveHarness(userId: string, raw: unknown): Promise<StoredHarness> {
  const def = parseCustomHarness(raw)
  await ensureTable()
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM custom_harness WHERE user_id = $1 AND id <> $2`,
    [userId, def.id],
  )
  if (Number(rows[0]?.n ?? 0) >= MAX_HARNESSES_PER_USER) {
    throw new Error(`You already have ${MAX_HARNESSES_PER_USER} harnesses — delete one first.`)
  }
  await pool.query(
    `INSERT INTO custom_harness (user_id, id, label, bin, args_template, brief_on_stdin, deliverable_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, id) DO UPDATE SET
       label = $3, bin = $4, args_template = $5, brief_on_stdin = $6, deliverable_path = $7, updated_at = now()`,
    [userId, def.id, def.label, def.bin, def.argsTemplate, def.briefOnStdin, def.deliverablePath],
  )
  return { ...def, updatedAt: Date.now() }
}

export async function deleteHarness(userId: string, id: string): Promise<void> {
  await ensureTable()
  await pool.query(`DELETE FROM custom_harness WHERE user_id = $1 AND id = $2`, [userId, id])
}
