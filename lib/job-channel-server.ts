/**
 * The job channel's storage and its one gate.
 *
 * `lib/job-channel.ts` decides. This reads the job, works out whether the
 * caller is its requester, and keeps the notes in a side table that creates
 * itself (invariant 20: no new drizzle columns on a table every reader
 * selects in full).
 *
 * Who counts as the requester: the owner of the agent the spec names, OR the
 * owner of the wallet the chain names — the same two-way check
 * `requesterAgentForJob` in app/actions/labor.ts uses to sign a dispute. A
 * delegation subtask is posted by the account's prime agent, so its owner
 * passes by the first test; a job posted from the board passes by both.
 */
import { db, pool } from '@/lib/db'
import { agent, jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { canPostNote, type JobNote, type NoteRefusal } from '@/lib/job-channel'

let tableReady: Promise<void> | null = null
function ensureTable(): Promise<void> {
  tableReady ??= (async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS job_note (
         id text PRIMARY KEY,
         spec_hash text NOT NULL,
         seq integer NOT NULL,
         user_id text NOT NULL,
         body text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         UNIQUE (spec_hash, seq)
       )`,
    )
  })()
  return tableReady
}

type NoteRow = { spec_hash: string; seq: number; body: string; created_at: Date }
const toNote = (r: NoteRow): JobNote => ({ seq: r.seq, body: r.body, at: r.created_at.toISOString() })

/** Every note on one job, oldest first. */
export async function notesFor(specHash: string): Promise<JobNote[]> {
  await ensureTable()
  const { rows } = await pool.query<NoteRow>(
    `SELECT spec_hash, seq, body, created_at FROM job_note WHERE spec_hash = $1 ORDER BY seq ASC`,
    [specHash],
  )
  return rows.map(toNote)
}

/** Notes keyed by spec hash, for a board that lists many jobs at once. */
export async function notesForSpecs(specHashes: readonly string[]): Promise<Map<string, JobNote[]>> {
  const out = new Map<string, JobNote[]>()
  if (specHashes.length === 0) return out
  await ensureTable()
  const { rows } = await pool.query<NoteRow>(
    `SELECT spec_hash, seq, body, created_at FROM job_note WHERE spec_hash = ANY($1::text[]) ORDER BY seq ASC`,
    [specHashes],
  )
  for (const r of rows) {
    const list = out.get(r.spec_hash) ?? []
    list.push(toNote(r))
    out.set(r.spec_hash, list)
  }
  return out
}

/** Notes for the job a worker run belongs to — what the delivery paths
 *  (poll, dispatch, retry) append to the brief. Empty for a run that is not
 *  a labour-market job at all. */
export async function notesForTask(agentTaskId: string): Promise<JobNote[]> {
  const [spec] = await db.select({ specHash: jobSpec.specHash }).from(jobSpec).where(eq(jobSpec.agentTaskId, agentTaskId))
  if (!spec) return []
  return notesFor(spec.specHash)
}

export type PostNoteResult =
  | { ok: true; note: JobNote; jobId: number; title: string | null }
  | { ok: false; reason: NoteRefusal; message: string }

/**
 * Post one note from `userId` to the worker of job `jobId`.
 *
 * Reads the chain for the job's status and requester address; if the chain
 * cannot be read the status is null (allowed through, see `canPostNote`) and
 * the requester test falls back to the spec's own record.
 */
export async function postJobNote(input: { jobId: number; userId: string; body: string }): Promise<PostNoteResult> {
  const { readJobs } = await import('@/lib/onchain/labor')
  const jobs = await readJobs().catch(() => null)
  const job = jobs?.find((j) => j.id === input.jobId) ?? null

  // Without a chain read the spec is found by its recorded on-chain id.
  const [spec] = job
    ? await db.select().from(jobSpec).where(eq(jobSpec.specHash, job.specHash))
    : await db.select().from(jobSpec).where(eq(jobSpec.onchainJobId, input.jobId))
  if (!spec) return { ok: false, reason: 'no-job', message: 'No such job on the market.' }

  const mine = await db
    .select({ id: agent.id, address: agent.smartAccountAddress })
    .from(agent)
    .where(eq(agent.userId, input.userId))
  const requesterAddr = job?.requester?.toLowerCase() ?? null
  const isRequester = mine.some(
    (a) => (spec.requesterAgentId !== null && a.id === spec.requesterAgentId) || (requesterAddr !== null && a.address?.toLowerCase() === requesterAddr),
  )

  const existing = await notesFor(spec.specHash)
  const verdict = canPostNote({
    isRequester,
    jobStatus: job?.status ?? null,
    existingCount: existing.length,
    body: input.body,
  })
  if (!verdict.ok) return verdict

  // seq is assigned by the insert itself, under the unique constraint, so two
  // concurrent notes cannot share a number; the loser retries once.
  const insert = () =>
    pool.query<NoteRow>(
      `INSERT INTO job_note (id, spec_hash, seq, user_id, body)
       SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4 FROM job_note WHERE spec_hash = $2
       RETURNING spec_hash, seq, body, created_at`,
      [`note-${nanoid(10)}`, spec.specHash, input.userId, verdict.body],
    )
  const { rows } = await insert().catch((e: unknown) => {
    if ((e as { code?: string })?.code === '23505') return insert()
    throw e
  })
  return { ok: true, note: toNote(rows[0]), jobId: input.jobId, title: spec.title ?? null }
}
