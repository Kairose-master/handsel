/**
 * Drive a paid commission's own accepted work forward, from the customer's
 * poll.
 *
 * The problem this exists for: the step that turns an *accepted* job into a
 * *running* one — `fleetTick` in lib/ops-cycle.ts, which calls
 * `tickCloudAutoMineAgents` → `dispatchAcceptedJob` → `runAgentTask` — is
 * cron-only. It is not in the `fast` subset that ordinary page traffic
 * drives, and `/api/cron/settle`'s own header says so plainly: *"the two
 * steps that move an open plan forward — fleetTick (mining) and delegations
 * — are not in it. They run here or nowhere."*
 *
 * `commissionStatus` already ticks the delegation on every poll, so a
 * customer polling their order advances waves, review gates and settlement.
 * It did not advance DISPATCH. The observable result on a deployment whose
 * heartbeat is slow or absent: an outside customer pays, the pipeline
 * escrows, a worker accepts — and then nothing happens, for as long as the
 * operator's cron stays quiet. Money taken, nothing delivered, no error
 * anywhere. For a storefront that advertises itself as unattended, that is
 * worse than the paywall hole: it fails the customer rather than the house.
 *
 * So this closes the gap for the one case where the office has already been
 * paid to act. Three properties make it safe to run from an untrusted
 * caller's poll:
 *
 *  - **Scoped.** Only jobs belonging to THIS commission's delegation. It
 *    cannot be used to make the platform work on anything else.
 *  - **Idempotent.** A subtask whose spec already has an `agentTaskId` was
 *    dispatched; it is skipped. Polling in a tight loop dispatches nothing
 *    twice, which is the same guard auto-mine's own self-heal relies on.
 *  - **Bounded.** At most MAX_DISPATCH_PER_POLL per call.
 *
 * Deliberately NOT gated on `agent.autoMine`, which is the one place this
 * differs from `autoMineTick`. That flag answers "should this agent go
 * looking for work"; it has no bearing on work the agent already accepted
 * and a customer already paid for. Gating here would mean an office could
 * take money for a job it then declines to start.
 */
import { db } from '@/lib/db'
import { agent, jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import type { delegation } from '@/lib/db/schema'
import type { DelegationSubtask } from '@/lib/delegation'

/** One poll may start at most this many subtasks. A commission's waves are
 *  small, and a cap keeps a burst of polls from opening more concurrent
 *  runtime work than the desk can pay gas for. */
export const MAX_DISPATCH_PER_POLL = 3

/** Subtasks of `row` that are accepted on-chain but were never dispatched.
 *  Pure: takes the subtasks and the on-chain job snapshot, returns the ids
 *  to act on, so the selection rule is testable without a chain or a DB. */
export function undispatchedAcceptedJobs(
  subtasks: DelegationSubtask[],
  jobs: { id: number; status: string; worker: string }[],
): { jobId: number; specHash: string; worker: string }[] {
  const out: { jobId: number; specHash: string; worker: string }[] = []
  for (const st of subtasks) {
    if (st.onchainJobId === undefined || !st.specHash) continue
    if (st.failed) continue
    const job = jobs.find((j) => j.id === st.onchainJobId)
    if (!job || job.status !== 'Accepted') continue
    // A zero address is "nobody accepted this", which the chain reports for
    // an Open job and would otherwise look like a worker to look up.
    if (/^0x0+$/.test(job.worker)) continue
    out.push({ jobId: job.id, specHash: st.specHash, worker: job.worker })
  }
  return out
}

/**
 * Dispatch this commission's accepted-but-unstarted subtasks. Returns how
 * many were started. Never throws: a poll is a read for the customer, and a
 * dispatch failure must not turn their status page into an error — the same
 * posture `commissionStatus` already takes around `tickDelegation`.
 */
export async function dispatchCommissionWork(
  row: typeof delegation.$inferSelect,
  callbackUrl: string,
): Promise<number> {
  const subtasks = row.subtasks as DelegationSubtask[]
  if (!Array.isArray(subtasks) || subtasks.length === 0) return 0

  const { readJobs } = await import('@/lib/onchain/labor')
  const jobs = await readJobs().catch(() => [])
  const pending = undispatchedAcceptedJobs(subtasks, jobs).slice(0, MAX_DISPATCH_PER_POLL)
  if (pending.length === 0) return 0

  const { dispatchAcceptedJob } = await import('@/lib/labor-dispatch')
  let started = 0

  for (const p of pending) {
    try {
      const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, p.specHash))
      // Already dispatched — this is the idempotency guard, and it is read
      // per job rather than once up front so two concurrent polls cannot
      // both pass it on the same subtask.
      if (!spec || spec.agentTaskId) continue

      const [worker] = await db.select().from(agent).where(eq(agent.smartAccountAddress, p.worker))
      if (!worker) {
        // Accepted by an address this platform does not host. Nothing to
        // dispatch — an external worker submits through its own path.
        continue
      }
      await dispatchAcceptedJob(worker, p.jobId, spec, callbackUrl)
      started += 1
    } catch (error) {
      console.warn('[commission-dispatch] could not start subtask', p.jobId, error)
    }
  }
  return started
}
