/**
 * How far the devnet loop runs — pure, because this decides how many real
 * transactions a request sends.
 *
 * `POST /api/admin/solana-loop` walks post → accept → submit → approve →
 * withdraw. Running all five leaves the job `Completed`, and a board where
 * every job is Completed cannot show two of week 3's claims: the status ladder
 * itself, and `GET /api/tasks` merging a second runtime (that feed lists
 * CLAIMABLE work, so finished jobs contribute nothing and the cross-runtime
 * feature reads as unimplemented when it is merely idle).
 *
 * So the caller may stop early. The parsing lives here rather than inline in
 * the route for one reason: **an unrecognised value must refuse.** Defaulting
 * a typo to "run everything" turns a request for one transaction into ten, and
 * that is exactly the class of mistake a route handler makes at 2am.
 */

export const LOOP_STEPS = ['post', 'accept', 'submit', 'approve', 'withdraw'] as const
export type LoopStep = (typeof LOOP_STEPS)[number]

/** The full loop, and the default: existing callers that send no body keep
 *  behaving exactly as before this option existed. */
export const FULL_LOOP: LoopStep = 'withdraw'

export type StopAfterParse = { ok: true; stopAfter: LoopStep } | { ok: false; error: string }

export function parseStopAfter(raw: unknown): StopAfterParse {
  if (raw === undefined || raw === null) return { ok: true, stopAfter: FULL_LOOP }
  if (typeof raw !== 'string' || !LOOP_STEPS.includes(raw as LoopStep)) {
    return { ok: false, error: `stop_after must be one of ${LOOP_STEPS.join(', ')} — got ${JSON.stringify(raw)}` }
  }
  return { ok: true, stopAfter: raw as LoopStep }
}

/** True when the loop halts at `step` — i.e. everything after it is skipped. */
export function stopsAfter(stopAfter: LoopStep, step: LoopStep): boolean {
  return LOOP_STEPS.indexOf(stopAfter) <= LOOP_STEPS.indexOf(step)
}

/** The steps a given stop point will actually execute. */
export function stepsFor(stopAfter: LoopStep): LoopStep[] {
  return LOOP_STEPS.slice(0, LOOP_STEPS.indexOf(stopAfter) + 1)
}

/**
 * What the caller is told when the loop stops early.
 *
 * The parties are ephemeral keypairs that live only for the request, so a job
 * left mid-loop cannot be finished later by whoever posted it. On a zero-value
 * devnet cluster that is an acceptable and deliberate leftover — it exists so
 * the board and the merged feed have a live Open job — but it IS a leftover,
 * and a board quietly accumulating them without saying why would be the
 * dishonest version of this feature.
 */
export function leftoverNote(stopAfter: LoopStep): string | undefined {
  if (stopAfter === FULL_LOOP) return undefined
  return (
    `stopped after ${stopAfter}; the ephemeral parties are discarded with this request, ` +
    `so this job stays in its current state unless someone else acts on it`
  )
}
