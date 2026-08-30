/**
 * Where a job's lane is stored.
 *
 * A side table, not a column on `job_specs`, for the reason
 * docs/failure-modes.md invariant 20 records and `agent_auto_reply`,
 * `office_counter` and `agent_office_slot` all follow: drizzle's `select()`
 * names every column of a table, so adding one breaks every read of that
 * table from the moment the code deploys until a manual `/api/admin/migrate`
 * runs — and deploys here are automatic while migrations are not. `job_specs`
 * is read with a bare `db.select().from(jobSpec)` in the mining path, which
 * is exactly the read that would break, on the path that moves money.
 *
 * Self-migrating on first use, same as its siblings.
 */
import { pool } from '@/lib/db'
import { normalizeLane, type JobLane } from '@/lib/job-lane'

let ensured: Promise<void> | null = null

function ensureTable(): Promise<void> {
  ensured ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS job_spec_lane (
         spec_hash text PRIMARY KEY,
         lane      text NOT NULL,
         set_at    timestamptz NOT NULL DEFAULT now()
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

/** Lanes for a batch of specs. Absent rows are `any`, which is what every
 *  job posted before this existed must keep meaning. */
export async function lanesFor(specHashes: string[]): Promise<Map<string, JobLane>> {
  const out = new Map<string, JobLane>()
  if (specHashes.length === 0) return out
  await ensureTable()
  const { rows } = await pool.query<{ spec_hash: string; lane: string }>(
    `SELECT spec_hash, lane FROM job_spec_lane WHERE spec_hash = ANY($1)`,
    [specHashes],
  )
  for (const r of rows) out.set(r.spec_hash, normalizeLane(r.lane))
  return out
}

/** Declare which machine a job runs on. Idempotent. */
export async function setJobLane(specHash: string, lane: JobLane): Promise<void> {
  await ensureTable()
  await pool.query(
    `INSERT INTO job_spec_lane (spec_hash, lane) VALUES ($1, $2)
     ON CONFLICT (spec_hash) DO UPDATE SET lane = $2, set_at = now()`,
    [specHash, normalizeLane(lane)],
  )
}
