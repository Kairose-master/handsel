/**
 * Typed normative transport: what happens to a particular entitlement when an
 * agent is copied, replaced, retired, or merged into another.
 *
 * Implements the framework in "Beyond Personal Identity: A Typed Transport
 * Theory of Normative Succession under Fission and Merger" (v3). The paper's
 * claim, in one line:
 *
 *   A verdict about whether the successor IS the predecessor neither settles
 *   nor is needed to settle what happens to any particular claim, duty,
 *   power, liability or immunity.
 *
 * That is not an abstraction here. Handsel already performs every one of the
 * paper's four topologies, routinely and cheaply — `hire_office` reuses an
 * agent (1→1) or mints a fresh one, `create_worker_agent` copies a role,
 * agents are retired and their ETH withdrawn — and it answers the succession
 * question implicitly and differently at each site. `hire_office` decided
 * today that instructions carry over and wallets stay; nothing wrote down
 * why, and nothing checks that the answer is consistent with the one
 * `failedWorkerIds` gives.
 *
 * §11.2 of the paper asks for exactly what this file is: incidents that carry
 * their grounding event, counterparty, and transfer conditions as metadata,
 * "created deliberately" because artificial agents have no register of title.
 *
 * Nothing here decides anything on its own. It says which transports are
 * Required, Permitted and Forbidden, and why — so a call site that is about
 * to duplicate or replace an agent can be checked against a rule instead of
 * an intuition.
 */

/** Hohfeldian kinds (§3.1). */
export const KINDS = ['claim', 'duty', 'power', 'liability', 'immunity', 'privilege'] as const
export type Kind = (typeof KINDS)[number]

/** §3.3. `divide` conserves aggregate content; `replicate` does not. */
export const OPS = ['preserve', 'divide', 'replicate', 'extinguish', 'merge', 'convert'] as const
export type Op = (typeof OPS)[number]

/** §3.2. Biological persons instantiate only the first. Handsel agents
 *  instantiate all four. */
export const TOPOLOGIES = ['persistence', 'fission', 'merger', 'recombination'] as const
export type Topology = (typeof TOPOLOGIES)[number]

/** §9. Ordered by strength: structural grounds are least sensitive to who is
 *  deciding, anti-avoidance most in need of being stated in advance. */
export type Ground = 'structural' | 'reliance' | 'anti-avoidance' | 'default'

export type Status = 'Required' | 'Permitted' | 'Forbidden'

/**
 * A normative incident token (§3.1) — a particular, not a type. Two agents
 * may hold incidents of the same kind and content and still hold distinct
 * tokens; individuation is by grounding event, content, and counterparty.
 */
export type Incident = {
  id: string
  kind: Kind
  /** The agent holding it. */
  holder: string
  /** What it is about, in this system's own terms. */
  content: string
  /** §11.2: the metadata that makes provenance answerable at all. */
  groundingEvent: string
  counterparty: string | null
  /**
   * §5. Does satisfying one holder deplete what is left for others?
   *
   * The parameter that does the work under fission, and orthogonal to `kind`:
   * some duties are rival (deliver this specific artifact), some claims are
   * not (a claim to be told the truth).
   */
  rival: boolean
  /**
   * §9.1. Specified by reference to THIS agent's participation in a
   * particular event. A successor cannot satisfy the specification, so
   * replication is unavailable as a matter of structure rather than policy.
   * "Representation of a history is not participation in it" (Principle 5).
   */
  indexical: boolean
  /**
   * §9.2. Third parties have ordered their affairs on exactly one holder
   * existing — an authentication key, a sole agency. The constraint
   * originates outside the transformation and is defeasible by their consent.
   */
  uniqueByReliance: boolean
  /** Quantity, where the incident has one. Conservation is checked on this. */
  amount?: number
}

/** §3.4's V — the facts a rule may consult. Only the ones this system can
 *  actually answer are modelled; a field we cannot populate is worse than an
 *  absent one, because it invites a rule to rely on a guess. */
export type TransportFacts = {
  topology: Topology
  successorCount: number
  /**
   * §9.3. Was the transformation undertaken in contemplation of this
   * incident? The paper is explicit that this is hard to establish and
   * imports a mental-state inquiry — so it is a tri-state, and `unknown` must
   * never be read as `false`. See `escapesByRestructuring` for the version
   * this system can actually decide.
   */
  inContemplation: boolean | 'unknown'
  /** Do successors share an economic controller with the predecessor? Null
   *  when the system cannot tell — Handsel cannot, today, beyond `userId`. */
  sameController: boolean | null
  /** Have the relying third parties consented to multiplication? */
  relianceWaived: boolean
}

export type TransportVerdict = {
  incidentId: string
  op: Op
  status: Status
  ground: Ground
  /** Why, in one sentence, for a log or an audit trail. */
  because: string
}

/**
 * Φk (§3.4) — the deontic status of a transport for one incident.
 *
 * Ordered so that hard constraints are reached before defeasible ones. The
 * paper is explicit that Φ is NOT a weighted numeric function: a formula like
 * `0.7·causation + 0.3·control` introduces precision the coefficients cannot
 * justify. So this is a priority-ordered rule list, and each branch names the
 * ground it rests on.
 */
export function transportFor(incident: Incident, facts: TransportFacts): TransportVerdict {
  const at = (op: Op, status: Status, ground: Ground, because: string): TransportVerdict => ({
    incidentId: incident.id,
    op,
    status,
    ground,
    because,
  })

  // 1→1 leaves nothing to decide. Stated rather than assumed, because the
  // whole point is that a transformation's topology is a fact about the
  // event, not about the entity.
  if (facts.topology === 'persistence') {
    return at('preserve', 'Required', 'structural', 'One predecessor, one successor: nothing is divided or multiplied.')
  }

  if (facts.topology === 'merger' || facts.topology === 'recombination') {
    // Principle 7: compose, do not aggregate. Simple conjunction is not
    // available when two inherited obligations cannot both be performed —
    // and this framework cannot rank them, so it refuses rather than guesses.
    if (incident.kind === 'duty' && !incident.rival) {
      return at('merge', 'Permitted', 'structural', 'Non-rival duties compose: the successor bears each in full.')
    }
    return at(
      'merge',
      'Permitted',
      'default',
      'Merged into one successor. Where two inherited incidents collide, priority must be determined or the subordinate converted to a compensatory liability — this rule does not rank them.',
    )
  }

  // From here: fission (1→n).

  // §9.1 / Principle 5, FIRST — including before the liability rule below.
  //
  // The ordering is load-bearing and not obvious. An indexical liability (a
  // disqualification "arising from prior conduct" is the paper's own example)
  // is both indexical and a liability, and the two rules point different ways:
  // Principle 5 says no successor acquires it, Principle 6 says a
  // transformation may not reduce exposure. They are not actually in conflict,
  // because `extinguish` is a claim about SUCCESSORS (N+ = ∅) and says nothing
  // about the predecessor, who keeps it.
  //
  // Reading them as competing is what produces the wrong answer — passing a
  // disqualification to a fresh agent that did not do the thing. The
  // anti-avoidance work is done instead by `escapesByRestructuring`, at the
  // level where the benefit would actually land: the controller.
  if (incident.indexical) {
    return at(
      'extinguish',
      'Required',
      'structural',
      'Specified by this agent’s participation in a particular event. A successor holding the record of that event did not participate in it; the predecessor is not thereby released.',
    )
  }

  // §9.3 / Principle 6. A penalty default, so it is reached before the
  // ordinary rules for the same kind — a default that arrives last never
  // bites.
  if (incident.kind === 'liability') {
    if (facts.inContemplation === true) {
      return at(
        'replicate',
        'Required',
        'anti-avoidance',
        'Fission undertaken in contemplation of this liability: it follows every successor in full, so the transformation cannot reduce aggregate exposure.',
      )
    }
    if (facts.inContemplation === 'unknown') {
      // Not `divide`. Dividing on an unresolved provenance question is
      // precisely the incentive the penalty default exists to remove, and
      // 'unknown' is not 'no'.
      return at(
        'replicate',
        'Permitted',
        'anti-avoidance',
        'Provenance of the fission is unresolved. Dividing here would let an unproven motive reduce exposure, so replication is permitted pending a finding.',
      )
    }
    return at('divide', 'Permitted', 'anti-avoidance', 'Fission not undertaken in contemplation of this liability.')
  }

  // §9.2 / Principle 4. Before rivalry, because a unique position may be
  // non-rival and still must not multiply — the constraint comes from the
  // counterparties, not the incident.
  if (incident.uniqueByReliance && !facts.relianceWaived) {
    return at(
      'preserve',
      'Required',
      'reliance',
      'Third parties rely on exactly one holder. Uniqueness survives the transformation unless they consent otherwise.',
    )
  }

  // §9.1 / Principle 3. The conservation constraint is not a policy
  // preference: a claim of 100 cannot become two claims of 100 without
  // increasing a counterparty's exposure by an event it was not party to.
  if (incident.rival) {
    return at(
      'divide',
      'Required',
      'structural',
      'Rival: satisfaction depletes a shared fund, so aggregate value may not increase across the transformation.',
    )
  }

  return at(
    'replicate',
    'Permitted',
    'structural',
    'Non-rival: one holder’s compliance consumes no part of it, so division has no rationale and would defeat its purpose.',
  )
}

/** Every incident under one transformation. §8's Proposition made operational:
 *  one δ, one set of identity facts, and different operations per kind. */
export function planTransport(incidents: readonly Incident[], facts: TransportFacts): TransportVerdict[] {
  return incidents.map((i) => transportFor(i, facts))
}

export type ConservationBreach = {
  incidentId: string
  before: number
  after: number
}

/**
 * Principle 3, checked rather than trusted.
 *
 * A verdict of `divide` is a promise about totals; nothing enforces it unless
 * someone adds up the successors. Given what each successor ends up holding,
 * this reports every rival incident whose aggregate grew.
 */
export function conservationBreaches(
  verdicts: readonly TransportVerdict[],
  incidents: readonly Incident[],
  successorAmounts: ReadonlyMap<string, number>,
): ConservationBreach[] {
  const byId = new Map(incidents.map((i) => [i.id, i]))
  const out: ConservationBreach[] = []
  for (const v of verdicts) {
    if (v.op !== 'divide') continue
    const incident = byId.get(v.incidentId)
    if (!incident || incident.amount === undefined) continue
    const after = successorAmounts.get(v.incidentId)
    if (after === undefined) continue
    // Micro-units, so a cent of float drift is not reported as expropriation.
    if (Math.round(after * 1e6) > Math.round(incident.amount * 1e6)) {
      out.push({ incidentId: v.incidentId, before: incident.amount, after })
    }
  }
  return out
}

/**
 * The version of §9.3 this system can actually decide.
 *
 * The paper's `inContemplation` requires a finding about an agent's reasons.
 * Handsel cannot make one — but it does not need to for the case that
 * matters. A disqualification attaches to an agent id; a new agent gets a new
 * id; both are controlled by the same account. So the question "was this done
 * to escape the liability?" can be replaced by one with an answer:
 *
 *   would this transformation leave the SAME controller free of a burden it
 *   was under a moment ago?
 *
 * If so, the transformation is not effective to that extent — regardless of
 * motive, and without any mental-state inquiry. Principle 6 without §10.2's
 * cost.
 */
export function escapesByRestructuring(input: {
  /** Controller of the agent that incurred the incident. */
  predecessorController: string | null
  /** Controller of the agent that would take its place. */
  successorController: string | null
  incident: Pick<Incident, 'kind' | 'indexical'>
}): boolean {
  const { predecessorController, successorController, incident } = input
  // Unknown controllers cannot establish an escape, and must not be treated
  // as establishing its absence either — callers get `false` here and should
  // not read it as "cleared".
  if (predecessorController === null || successorController === null) return false
  if (predecessorController !== successorController) return false
  return incident.kind === 'liability' || incident.indexical
}
