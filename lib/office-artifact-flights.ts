/**
 * Artifact flights — the last piece of the office redesign brief: artifact
 * objects traveling between rooms independent of agent movement.
 *
 * "REALITY BEFORE ANIMATION" (the brief's own principle) is the hard
 * constraint here, more than anywhere else in the redesign. A flight is
 * shown ONLY when every fact behind it is real and currently known:
 *
 *  - the upstream subtask has a real delivered output (`output` set, not
 *    failed) — nothing travels before it exists;
 *  - the downstream subtask hasn't consumed it yet (no `output` of its own,
 *    not failed) — once it has, the handoff is done, not in flight;
 *  - BOTH the upstream and downstream workers resolve to a real agent IN
 *    THIS OFFICE with a real current department (`deptOf` — the same
 *    departmentFor() result the roster already renders). A subtask worked
 *    by some other account's agent, or not yet claimed by anyone, has no
 *    known room to draw a line to — it is left out rather than guessed at
 *    (Strategy Room, the nearest "coordinating" room, would be a plausible
 *    guess and is exactly the kind of plausible-but-invented fact this
 *    principle exists to rule out).
 *
 * Three kinds mirror the three real handoff primitives docs/collaboration.md
 * already describes — this file adds no new primitive, it visualizes the
 * ones that exist: `reviewOf` (review), `synthesizes` (synthesis), and any
 * other `dependsOn` (handoff).
 */

export type ArtifactFlightKind = 'handoff' | 'review' | 'synthesis'

export type ArtifactFlight = {
  id: string
  kind: ArtifactFlightKind
  fromDeptId: string | null // null = lounge (idle bullpen) — still a real, known location
  toDeptId: string | null
  /** The REAL worker agents on each end — the same ids `deptOf` was keyed
   *  by, carried through so a renderer can draw the flight between the two
   *  agents' live positions instead of between room centers. Always set
   *  (a flight without both known workers is never emitted — see the
   *  header); a renderer falls back to room centers only when an id isn't
   *  in its current roster frame. */
  fromAgentId: string
  toAgentId: string
  label: string
}

export type FlightSubtask = {
  title: string
  output?: string | null
  failed?: boolean
  dependsOn?: string[]
  reviewOf?: string
  synthesizes?: string[]
  /** Resolved externally (assignedAgentId, or jobSpec.workerAgentId by
   *  specHash) — this module never touches the database, so the caller
   *  hands over the one fact it needs: who the real worker is, if known. */
  workerAgentId?: string | null
}

/** Every subtask this office's agents worked, whose delivered output some
 *  OTHER known subtask now depends on and hasn't yet consumed — the current
 *  set of "real, still-live" artifact handoffs for one delegation. */
export function artifactFlightsFor(
  delegationId: string,
  subtasks: readonly FlightSubtask[],
  deptOf: ReadonlyMap<string, string | null>,
): ArtifactFlight[] {
  const byTitle = new Map(subtasks.map((s) => [s.title, s]))
  const flights: ArtifactFlight[] = []
  const seen = new Set<string>() // a title can appear in both reviewOf and dependsOn (reviewOf folds into dependsOn upstream) — one flight per (from,to) pair, not two

  for (const downstream of subtasks) {
    const upstreamTitles = new Set(downstream.dependsOn ?? [])
    if (downstream.reviewOf) upstreamTitles.add(downstream.reviewOf)
    for (const title of downstream.synthesizes ?? []) upstreamTitles.add(title)
    if (upstreamTitles.size === 0) continue

    // Already delivered its own output, or terminally failed — whatever it
    // depended on has already been consumed (or never will be); nothing is
    // still traveling toward it.
    if (downstream.output != null || downstream.failed) continue

    const toAgent = downstream.workerAgentId
    if (!toAgent || !deptOf.has(toAgent)) continue
    const toDeptId = deptOf.get(toAgent) ?? null

    for (const title of upstreamTitles) {
      const upstream = byTitle.get(title)
      if (!upstream) continue
      // The real deliverable this flight carries: it has to exist and be
      // genuine (not a failed/refunded attempt) before anything can travel.
      if (upstream.output == null || upstream.failed) continue

      const fromAgent = upstream.workerAgentId
      if (!fromAgent || !deptOf.has(fromAgent)) continue
      const fromDeptId = deptOf.get(fromAgent) ?? null

      if (fromDeptId === toDeptId) continue // already in the same room — nothing visibly moves

      const pairKey = `${title}::${downstream.title}`
      if (seen.has(pairKey)) continue
      seen.add(pairKey)

      const kind: ArtifactFlightKind =
        downstream.reviewOf === title ? 'review' : (downstream.synthesizes ?? []).includes(title) ? 'synthesis' : 'handoff'

      flights.push({
        id: `${delegationId}:${pairKey}`,
        kind,
        fromDeptId,
        toDeptId,
        fromAgentId: fromAgent,
        toAgentId: toAgent,
        label: `${title} → ${downstream.title}`,
      })
    }
  }

  return flights
}
