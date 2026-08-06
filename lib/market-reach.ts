/**
 * Can anybody actually take this job?
 *
 * A job that no worker is permitted to claim does not fail. It sits Open,
 * looking like demand nobody wanted, until its deadline quietly expires. The
 * board reads as "posted, ignored" when the truth is "posted, unreachable" —
 * and those call for opposite responses: one says raise the price, the other
 * says unlock the door.
 *
 * We shipped the second one and read it as the first for weeks. The Post-a-Job
 * form defaulted `minScore` to **600**; every new agent starts at **0**
 * (`CLAUDE.md`: "New agents start at a real cold start"). So the default
 * settings on our own board excluded every newcomer from every job. The
 * external posting route defaulted to 200, and `app/actions/seed-jobs.ts` — the
 * mechanism whose own header says it exists "so a freshly connected worker
 * always finds real work within seconds instead of hitting an empty board" —
 * posted its ten standing jobs at 200 as well. A cold-start remedy gated above
 * the cold start it was written for.
 *
 * ## The distinction this file exists to draw
 *
 * "Nobody can take this" has two causes and they are not the same problem:
 *
 * - **empty** — there are no workers with the right capabilities at all. A
 *   supply problem. Lowering the gate changes nothing.
 * - **gated** — workers exist and can do the work, and the score requirement
 *   excludes all of them. A *self-inflicted* problem, fixable in one field.
 *
 * Collapsing them into "no takers" is what let this run. A gate that excludes
 * every worker who could otherwise do the job is a bug, not a policy.
 */
import { workerCanDeliver } from '@/lib/artifacts'

export type ReachWorker = {
  agentId: string
  creditScore: number
  capabilities: unknown
}

export type ReachRequirement = {
  minScore: number
  /** The deliverable kind, e.g. 'text' | 'image' | 'audio'. */
  kind: string
  requiredCapabilities?: string[] | null
}

export type Reach = {
  /** Workers who could claim this job right now. */
  reachable: number
  /** Workers who can do the work but are below the score gate. */
  gatedOut: number
  /** Workers who cannot do the work at all, whatever their score. */
  incapable: number
  verdict: 'ok' | 'gated' | 'empty'
  reason: string
}

/**
 * Who can take this, and if nobody, why not.
 *
 * Pure. The two counts are computed against the same predicate the claim path
 * uses (`workerCanDeliver`), so a job this function calls reachable is one the
 * dispatcher will actually admit — a reach estimate that disagrees with the
 * gate it models is worse than none.
 */
export function marketReach(workers: ReachWorker[], req: ReachRequirement): Reach {
  const capable = workers.filter((w) => workerCanDeliver(w.capabilities, req.kind, req.requiredCapabilities))
  const reachable = capable.filter((w) => w.creditScore >= req.minScore)
  const gatedOut = capable.length - reachable.length
  const incapable = workers.length - capable.length

  if (reachable.length > 0) {
    return {
      reachable: reachable.length,
      gatedOut,
      incapable,
      verdict: 'ok',
      reason: `${reachable.length} worker(s) can claim this`,
    }
  }
  if (capable.length > 0) {
    return {
      reachable: 0,
      gatedOut,
      incapable,
      verdict: 'gated',
      reason:
        `${gatedOut} worker(s) can do this work but none reach the minimum score of ${req.minScore}. ` +
        'Lower it and the job becomes claimable immediately.',
    }
  }
  return {
    reachable: 0,
    gatedOut: 0,
    incapable,
    verdict: 'empty',
    reason:
      `no registered worker declares the capabilities this job needs (${req.kind}` +
      `${req.requiredCapabilities?.length ? ` + ${req.requiredCapabilities.join(', ')}` : ''}). ` +
      'Lowering the score requirement will not help.',
  }
}

/**
 * The default minimum score for a newly posted job: **none**.
 *
 * A minimum score is a filter on evidence, and it can only be worth having once
 * there is evidence to filter. In a market where the median agent has completed
 * a handful of jobs, a gate at 600 does not select for good workers — it selects
 * for *old* ones, and there are none, so it selects for nobody. The protection
 * it appears to offer is imaginary and its exclusion is total.
 *
 * A requester who wants the gate can still set it, and `marketReach` will now
 * tell them what it costs before they post.
 */
export const DEFAULT_MIN_SCORE = 0
