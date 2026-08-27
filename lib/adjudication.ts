/**
 * The case file: what was observed, what it was diagnosed as, and who it is
 * attributed to — kept as three separate things that are never collapsed.
 *
 * `lib/failure-codes.ts` split a verdict into two axes: what the judgment
 * found, and whether there was one. That was right and it was not enough.
 * Three things still shared one field:
 *
 *   what was OBSERVED · why it happened · who is RESPONSIBLE
 *
 * When they share a code, "no permission", "network down", "evidence lost",
 * "verifier misbehaved", "prompt injection" and "the worker did the job badly"
 * all reduce to FAIL. gRPC already refuses that reduction for its own
 * vocabulary: `DEADLINE_EXCEEDED` does not mean the work failed — a
 * state-changing call may have SUCCEEDED with only the response arriving late.
 * An observation is not an outcome.
 *
 * ## Observation is not overwritten by attribution
 *
 * `OBS.DEADLINE_EXCEEDED` stays on the record even after it is diagnosed as
 * `INF.UNAVAILABLE`, or `POL.PERMISSION_DENIED`, or `WRK.REQUIREMENT_NOT_MET`.
 * Each is appended; the latest disposition governs the money. That is the
 * shape W3C PROV uses — entity, activity, agent, and responsibility as
 * distinct relations — and it is why an appeal here is a compensating event
 * rather than a deletion. A record you can rewrite is not a record.
 *
 * ## Only WRK.* means the worker
 *
 * `POL.*` is a policy decision made before the work. `INF.*` is somebody
 * else's outage. `EVD.*` is a problem with the proof, not the performance.
 * `VRF.*` is the judge, not the judged. `SEC.*` is a suspicion about an
 * attacker who may not be either party. None of them is a statement about
 * whether the worker did its job, and `impliesWorkerFault` refuses to treat
 * them as one.
 *
 * The distributed-systems reading is the same. Sybil says redundancy across
 * identities proves nothing if one entity can mint them; FLP says a consensus
 * that will not converge is not evidence of malice. Compressing DISAGREEMENT,
 * TIMEOUT, COMPROMISE and COLLUSION into a worker's FAIL is wrong as
 * engineering before it is wrong as fairness.
 */

/** The layer a code speaks at. Carried in the code itself, so a reader cannot
 *  mistake an observation for a finding. */
export const LAYERS = {
  OBS: 'observation — what was seen, before anyone knows why',
  POL: 'policy — a decision taken before the work, about what was permitted',
  INF: 'infrastructure — a service this depended on',
  EVD: 'evidence — the proof, not the performance',
  VRF: 'verifier — the judge, not the judged',
  SEC: 'security — a suspicion, possibly about neither party',
  ECO: 'settlement — the payment rail, after the judgment is already made',
  WRK: 'worker — the only layer that speaks about whether the job was done',
} as const
export type Layer = keyof typeof LAYERS

/**
 * What to do about it, kept separate from what it is.
 *
 * `RECONCILE_FIRST` is the one that matters most: after a timeout the
 * state-changing call may already have landed, so re-running a non-idempotent
 * job is how one payment becomes two. Reconcile against an execution id
 * before retrying, never instead of it.
 */
export const RETRY_CLASSES = [
  'SAFE_BACKOFF',
  'RECONCILE_FIRST',
  'FIX_PRECONDITION',
  'HIGHER_LEVEL_RETRY',
  'NEW_VERIFIER',
  'NO_RETRY_ESCALATE',
] as const
export type RetryClass = (typeof RETRY_CLASSES)[number]

/** Where a case can come to rest. Two independent columns: is the worker at
 *  fault, and does money move. Neither is derivable from the other. */
export const CASE_STATES = [
  'PROVISIONAL_PASS',
  'SETTLED_PASS',
  'ATTRIBUTED_FAIL',
  'NO_FAULT_CANCELLED',
  'INCONCLUSIVE',
  'SECURITY_HOLD',
  'SETTLEMENT_BLOCKED',
  'POLICY_BLOCKED',
] as const
export type CaseState = (typeof CASE_STATES)[number]

export const CASE_STATE_MEANING: Record<
  CaseState,
  { meaning: string; workerAtFault: boolean | 'undetermined'; moneyMoves: 'no' | 'held' | 'pays' | 'refunds' }
> = {
  PROVISIONAL_PASS: { meaning: 'passes under the current ruleset, challenge window open', workerAtFault: false, moneyMoves: 'held' },
  SETTLED_PASS: { meaning: 'pass, final', workerAtFault: false, moneyMoves: 'pays' },
  ATTRIBUTED_FAIL: { meaning: 'failure established against the worker', workerAtFault: true, moneyMoves: 'refunds' },
  NO_FAULT_CANCELLED: { meaning: 'ended for infrastructure or policy reasons, no fault', workerAtFault: false, moneyMoves: 'refunds' },
  INCONCLUSIVE: { meaning: 'the evidence or the verifier could not decide', workerAtFault: 'undetermined', moneyMoves: 'held' },
  SECURITY_HOLD: { meaning: 'attack or compromise suspected', workerAtFault: 'undetermined', moneyMoves: 'held' },
  SETTLEMENT_BLOCKED: { meaning: 'judged, but the payment rail refused', workerAtFault: false, moneyMoves: 'held' },
  POLICY_BLOCKED: { meaning: 'not permitted before it began', workerAtFault: false, moneyMoves: 'no' },
}

/**
 * The starting codex. Eighteen, not hundreds — the layer prefix and the
 * separate `retryClass` and `state` fields do the work a long list of codes
 * would otherwise be asked to do.
 */
export const CODEX: Record<
  string,
  { layer: Layer; means: string; retry: RetryClass; state: CaseState }
> = {
  'POL.UNAUTHENTICATED': { layer: 'POL', means: 'no valid agent or operator credential', retry: 'FIX_PRECONDITION', state: 'POLICY_BLOCKED' },
  'POL.PERMISSION_DENIED': { layer: 'POL', means: 'credential present, this tool or resource not permitted', retry: 'FIX_PRECONDITION', state: 'POLICY_BLOCKED' },
  'OBS.DEADLINE_EXCEEDED': { layer: 'OBS', means: 'no definite answer before the deadline', retry: 'RECONCILE_FIRST', state: 'INCONCLUSIVE' },
  'INF.UNAVAILABLE': { layer: 'INF', means: 'a verifier, MCP server or API was temporarily unreachable', retry: 'SAFE_BACKOFF', state: 'NO_FAULT_CANCELLED' },
  'INF.RESOURCE_EXHAUSTED': { layer: 'INF', means: 'quota, storage or compute ran out', retry: 'FIX_PRECONDITION', state: 'NO_FAULT_CANCELLED' },
  'EVD.MISSING': { layer: 'EVD', means: 'a required artifact, log or attestation is absent', retry: 'FIX_PRECONDITION', state: 'INCONCLUSIVE' },
  'EVD.AUTHENTICITY_FAILED': { layer: 'EVD', means: 'the claimed source or identity could not be authenticated', retry: 'FIX_PRECONDITION', state: 'INCONCLUSIVE' },
  'EVD.INTEGRITY_FAILED': { layer: 'EVD', means: 'hash or signature mismatch — the artifact was altered', retry: 'NO_RETRY_ESCALATE', state: 'SECURITY_HOLD' },
  'EVD.RULESET_MISMATCH': { layer: 'EVD', means: 'evidence or verdict refers to a different ruleset version', retry: 'HIGHER_LEVEL_RETRY', state: 'INCONCLUSIVE' },
  'VRF.INCONCLUSIVE': { layer: 'VRF', means: 'admissible evidence still did not settle it', retry: 'NEW_VERIFIER', state: 'INCONCLUSIVE' },
  'VRF.DISAGREEMENT': { layer: 'VRF', means: 'independent verifiers returned conflicting verdicts', retry: 'NEW_VERIFIER', state: 'INCONCLUSIVE' },
  'VRF.COMPROMISED': { layer: 'VRF', means: 'a verifier key, implementation or operator is compromised', retry: 'NO_RETRY_ESCALATE', state: 'SECURITY_HOLD' },
  'SEC.PROMPT_INJECTION': { layer: 'SEC', means: 'adversarial instructions found in an agent or verifier context', retry: 'NO_RETRY_ESCALATE', state: 'SECURITY_HOLD' },
  'SEC.SYBIL_SUSPECTED': { layer: 'SEC', means: 'several identities appear to be one entity', retry: 'NO_RETRY_ESCALATE', state: 'SECURITY_HOLD' },
  'SEC.COLLUSION_SUSPECTED': { layer: 'SEC', means: 'parties that should be independent appear coordinated', retry: 'NO_RETRY_ESCALATE', state: 'SECURITY_HOLD' },
  'WRK.REQUIREMENT_NOT_MET': { layer: 'WRK', means: 'the delivered work does not meet the stated acceptance criteria', retry: 'NO_RETRY_ESCALATE', state: 'ATTRIBUTED_FAIL' },
  'WRK.MALICIOUS_BEHAVIOR': { layer: 'WRK', means: 'the worker acted against the terms deliberately', retry: 'NO_RETRY_ESCALATE', state: 'SECURITY_HOLD' },
  'ECO.SETTLEMENT_FAILED': { layer: 'ECO', means: 'the judgment stands but the payment rail refused it', retry: 'SAFE_BACKOFF', state: 'SETTLEMENT_BLOCKED' },
}

export function layerOf(code: string): Layer | null {
  const prefix = code.trim().split('.')[0] as Layer
  return prefix in LAYERS ? prefix : null
}

/**
 * Does this code say the WORKER is at fault?
 *
 * Only `WRK.*` does. Everything else is a statement about policy,
 * infrastructure, evidence, a judge, or an attacker — and charging any of
 * them to the worker is how an outage becomes someone's penalty.
 */
export function impliesWorkerFault(code: string): boolean {
  return layerOf(code) === 'WRK'
}

/** Has the cause been established, or only observed? Never inferred from the
 *  presence of a code — an observation always has one. */
export type AttributionStatus = 'UNDETERMINED' | 'ESTABLISHED' | 'DISPUTED'

export type CaseEvent = {
  at: string
  /** What this event records. `observed` is the raw signal; `diagnosed`
   *  proposes a cause; `attributed` assigns responsibility; `compensated` is
   *  how an appeal is expressed. */
  kind: 'observed' | 'diagnosed' | 'attributed' | 'compensated'
  code: string
  note?: string
  /** Content-addressed references, never inline copies. */
  evidenceRefs?: string[]
  /** Which ruleset judged this. A verdict without it cannot be re-checked,
   *  because nobody can say what it was checked against. */
  rulesetVersion?: string
}

export type CaseFile = {
  caseId: string
  /** The first thing seen. Never rewritten. */
  observedCode: string
  attributionStatus: AttributionStatus
  /** Null until responsibility is established. Null is not "no fault" — it is
   *  "not yet decided", and the two must not read the same. */
  attributedCode: string | null
  events: CaseEvent[]
}

export function openCase(input: { caseId: string; observedCode: string; at: string; evidenceRefs?: string[] }): CaseFile {
  return {
    caseId: input.caseId,
    observedCode: input.observedCode,
    attributionStatus: 'UNDETERMINED',
    attributedCode: null,
    events: [{ at: input.at, kind: 'observed', code: input.observedCode, evidenceRefs: input.evidenceRefs }],
  }
}

/**
 * Append a finding.
 *
 * Returns a NEW case file. `observedCode` is copied forward untouched — the
 * one field this function may never change, because the whole model rests on
 * the raw signal surviving every later interpretation of it.
 */
export function appendFinding(file: CaseFile, event: CaseEvent): CaseFile {
  const next: CaseFile = {
    ...file,
    observedCode: file.observedCode,
    events: [...file.events, event],
  }
  if (event.kind === 'attributed') {
    next.attributedCode = event.code
    next.attributionStatus = 'ESTABLISHED'
  }
  if (event.kind === 'compensated') {
    // An appeal does not delete the original finding. It adds one that
    // supersedes it, so the fact that something was overturned stays
    // readable — a verdict whose history you cannot see is indistinguishable
    // from one nobody questioned.
    next.attributedCode = event.code
    next.attributionStatus = 'ESTABLISHED'
  }
  return next
}

/** The code that governs right now: the attribution if there is one, the
 *  observation otherwise. */
export function governingCode(file: CaseFile): string {
  return file.attributedCode ?? file.observedCode
}

/** Where the case stands. Unattributed cases are never resolved as failures:
 *  an observation with no established cause is INCONCLUSIVE, whatever it
 *  looked like. */
export function caseState(file: CaseFile): CaseState {
  const governing = governingCode(file)
  const entry = CODEX[governing]
  if (!entry) return 'INCONCLUSIVE'
  if (file.attributionStatus !== 'ESTABLISHED' && entry.layer !== 'POL' && entry.layer !== 'SEC') {
    return 'INCONCLUSIVE'
  }
  return entry.state
}

/** May this case move money, and which way? */
export function disposition(file: CaseFile): { moneyMoves: 'no' | 'held' | 'pays' | 'refunds'; workerAtFault: boolean | 'undetermined' } {
  const state = caseState(file)
  const { moneyMoves, workerAtFault } = CASE_STATE_MEANING[state]
  return { moneyMoves, workerAtFault }
}

/** What to do next about a code, independent of what it means. */
export function retryClassFor(code: string): RetryClass {
  return CODEX[code.trim()]?.retry ?? 'NO_RETRY_ESCALATE'
}

/**
 * Evidence carries three separate judgments, and a hash settles only the
 * first.
 *
 * Authenticating an electronic record by hash establishes that the file is
 * the file — not who wrote it, and not whether what it says is true. Handsel
 * has been treating a passing `binding: 'sealed'` as if it answered more than
 * it does; this names the gap rather than closing it by assertion.
 */
export type EvidenceAssessment = {
  /** Is this the artifact it claims to be? A hash can answer this. */
  authenticity: 'verified' | 'failed' | 'unchecked'
  /** May this ruleset use it at all? A policy question, not a cryptographic one. */
  admissibility: 'admissible' | 'excluded' | 'undetermined'
  /** If usable, how much does it settle? Never derivable from the other two. */
  weight: 'strong' | 'weak' | 'undetermined'
}

/** Authenticity alone never establishes responsibility. The one inference
 *  this model exists to refuse. */
export function establishesResponsibility(e: EvidenceAssessment): boolean {
  return e.authenticity === 'verified' && e.admissibility === 'admissible' && e.weight === 'strong'
}
