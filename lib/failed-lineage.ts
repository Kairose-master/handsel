/**
 * Who a reposted job is closed to.
 *
 * When work fails its acceptance tests the job is reposted with the failed
 * worker recorded, and every accept path refuses that worker: "the repost is
 * reserved for a different worker."
 *
 * The record is a list of AGENT IDS, and that is the hole. A new agent gets a
 * new id. `create_worker_agent` mints one; `hire_office` with `freshAgents`
 * mints a whole desk of them. So an owner whose agent failed a lineage could
 * take the repost with a second agent of their own, in one call, and the gate
 * would see an id it had never heard of.
 *
 * The disqualification is a normative incident of a particular type, and its
 * type says what may happen to it (lib/normative-transport.ts):
 *
 *  - It is **indexical** — it arises from THIS agent's participation in THIS
 *    grading event. So a successor does not inherit it. "Representation of a
 *    history is not participation in it." Passing it to a fresh agent that
 *    did not do the thing would be the opposite error, and equally wrong.
 *  - But a transformation **may not improve a normative position**. If the
 *    same controller ends up free of a burden it was under a moment ago, the
 *    transformation is not effective to that extent — the fraudulent-transfer
 *    rule, applied to entitlements rather than assets.
 *
 * Those two are not in tension: the fresh agent never acquires the
 * disqualification, and the ACCOUNT still cannot take the repost. The block
 * lives where the benefit would have landed.
 *
 * Deliberately narrow. It closes the same lineage to the same controller, and
 * nothing else: a different owner taking reposted work is the market working,
 * and this must never become "one failure blocks an account from the board".
 */

export type FailedLineageVerdict =
  | { blocked: false }
  | { blocked: true; reason: 'same-agent' | 'same-controller' }

/**
 * May this worker take this repost?
 *
 * Pure. `failedControllers` is resolved by the caller because it needs a
 * lookup, and a rule that silently did its own database access could not be
 * tested against the case that matters.
 */
export function failedLineageVerdict(input: {
  workerAgentId: string
  workerController: string | null
  failedWorkerIds: readonly string[] | null | undefined
  /** Controllers of those failed agents. Omit or leave empty when they could
   *  not be resolved — an unresolved controller must not block anyone, and
   *  must not be read as clearing them either. */
  failedControllers?: readonly (string | null)[] | null
}): FailedLineageVerdict {
  const failed = input.failedWorkerIds ?? []
  if (failed.includes(input.workerAgentId)) return { blocked: true, reason: 'same-agent' }

  if (input.workerController === null) return { blocked: false }
  const controllers = (input.failedControllers ?? []).filter((c): c is string => typeof c === 'string')
  if (controllers.includes(input.workerController)) return { blocked: true, reason: 'same-controller' }

  return { blocked: false }
}

/** The message a blocked worker gets. Different text per reason, because the
 *  two are different facts and a worker told the wrong one will do the wrong
 *  thing about it — the first is "try another job", the second is "this
 *  account is done with this lineage". */
export function failedLineageMessage(reason: 'same-agent' | 'same-controller'): string {
  return reason === 'same-agent'
    ? "This agent already failed this job's acceptance tests — the repost is reserved for a different worker."
    : "Another agent on this account already failed this job's acceptance tests. The repost is reserved for a different worker, and creating a new agent does not make one — a transformation cannot lift a disqualification the account is already under."
}

/**
 * Controllers of the agents that failed this lineage.
 *
 * Returns nulls for ids that no longer resolve rather than dropping them: a
 * deleted agent is not a cleared one, and a caller that cannot tell should
 * see that it cannot tell.
 */
export async function controllersOfFailed(failedWorkerIds: readonly string[] | null | undefined): Promise<(string | null)[]> {
  const ids = (failedWorkerIds ?? []).filter(Boolean)
  if (ids.length === 0) return []
  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { inArray } = await import('drizzle-orm')
  const rows = await db
    .select({ id: agent.id, userId: agent.userId })
    .from(agent)
    .where(inArray(agent.id, [...ids]))
  const byId = new Map(rows.map((r) => [r.id, r.userId]))
  return ids.map((id) => byId.get(id) ?? null)
}
