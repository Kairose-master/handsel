/**
 * The thing that calls the permissionless exits.
 *
 * `lib/deadlines.ts` decides WHICH calls are due; this makes them. The split is
 * deliberate — the decision is a pure function with twenty tests around its
 * boundary conditions, and everything that cannot be tested that way (a chain, a
 * lease, a cap, a try/catch) lives here where it is thin enough to read.
 *
 * ## Why this is its own ops step
 *
 * Registered separately from anything that decides POLICY. These four calls are
 * the backstop the whole dispute design leans on: the answer to "what if nobody
 * acts" is a deadline, and a deadline nobody calls is not an answer. A bug in a
 * policy sweep must not be able to take the backstop down with it, so they do
 * not share a step, a lease, or a failure.
 */
import { acquireOpsLease, releaseOpsLease } from '@/lib/ops-lease'
import { dueDeadlines, MAX_EXITS_PER_PASS } from '@/lib/deadlines'

const LEASE_MS = 4 * 60_000

/**
 * Attempt the exits that are due, oldest first, at most MAX_EXITS_PER_PASS.
 *
 * Every call is individually caught. These are independent jobs with
 * independent counterparties; one that reverts — a race with a requester who
 * approved in the same block, a job someone else already expired — must not
 * stop the others. The whole point of the sweep is that it is the only thing
 * standing between an absent party and stuck money, so it fails soft and
 * retries next pass rather than failing loud and stopping.
 */
export async function sweepDeadlines(): Promise<string> {
  const { isV2Market, readJobsV2, callExit } = await import('@/lib/onchain/labor-v2')
  if (!(await isV2Market())) return 'skipped: not a v2 market'
  if (!(await acquireOpsLease('deadlines', LEASE_MS))) return 'skipped: leased'

  try {
    const jobs = await readJobsV2()
    const nowSec = Math.floor(Date.now() / 1000)
    const due = dueDeadlines(jobs, nowSec)
    if (due.length === 0) return '0 due'

    const batch = due.slice(0, MAX_EXITS_PER_PASS)
    const keeper = await keeperAgentId()
    if (!keeper) return `${due.length} due, no keeper agent configured`

    let done = 0
    const failures: string[] = []
    for (const exit of batch) {
      try {
        await callExit(keeper, exit.fn, exit.jobId)
        done++
      } catch (e) {
        failures.push(`#${exit.jobId} ${exit.fn}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`)
      }
    }
    // Report the DEFERRED count, not just the done count. A pass that settles
    // 3 of 40 looks identical to one that settles 3 of 3 unless the backlog is
    // in the line, and "the queue is not draining" is the thing worth seeing.
    const deferred = due.length - batch.length
    return [
      `${done}/${batch.length} settled`,
      deferred > 0 ? `${deferred} deferred` : '',
      failures.length ? `failed: ${failures.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join(', ')
  } finally {
    await releaseOpsLease('deadlines')
  }
}

/**
 * Which agent sends the calls.
 *
 * Deliberately not the oracle EOA. These exits are permissionless by design, so
 * they should travel on the least privileged sender available — and the oracle
 * key is the one that also satisfies `msg.sender == arbiter`. Putting the most
 * privileged credential in the system on its most routine path is how a key
 * ends up exposed to a path nobody was auditing.
 */
async function keeperAgentId(): Promise<string | null> {
  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { isNotNull } = await import('drizzle-orm')
  const rows = await db
    .select({ id: agent.id })
    .from(agent)
    .where(isNotNull(agent.smartAccountAddress))
    .limit(1)
  return rows[0]?.id ?? null
}
