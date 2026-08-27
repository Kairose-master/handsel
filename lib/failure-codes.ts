/**
 * The failure code table: why a judgment did not happen, as distinct from
 * what the judgment said.
 *
 * The rule this file exists to enforce, from the design study:
 *
 *   **"It failed" and "it scored low" must never be the same state.**
 *
 * Handsel has been one flag away from that mistake all along. `testResult`
 * carries `passed: boolean | null` plus `refusedBrief` and `workerIncapable`,
 * which is a partial version of the right idea — the two extra flags exist
 * precisely because a refused brief and a failed grade are recorded against
 * different parties. But everything else that can go wrong still lands in the
 * same `passed: false`, including things that are not about the worker at all:
 * a grader timing out, an ambiguous rubric, two evaluators disagreeing, a
 * poisoned input, a replayed settlement.
 *
 * When those collapse into a low score, a system fault becomes the worker's
 * penalty. The worker loses the bounty and takes the credit hit for an outage.
 *
 * ## Two axes, not one
 *
 * A verdict is a pair, and the pair is the point:
 *
 *   Task outcome: FAIL       · Evaluation execution: SUCCESS
 *     — the work was judged and found wanting. The worker's problem.
 *
 *   Task outcome: UNKNOWN    · Evaluation execution: FAILURE
 *     — nothing was judged. NOT the worker's problem, and paying or
 *       penalising on it is the defect.
 *
 * These have completely different economic meaning and a single FAILED state
 * cannot express either.
 *
 * ## A code names a cause, or admits it cannot
 *
 * The study's example is the 2026 .de DNSSEC incident: the real cause was an
 * invalid DNSSEC signature, and the resolver reported a generic "no reachable
 * authority", which hid it. So `ERROR`, `INVALID`, `FAILED`, `UNKNOWN`,
 * `BAD_RESULT` and `GRADING_FAILED` are refused by `assertNotGeneric` — they
 * are the shape of a diagnosis that cannot be acted on.
 *
 * And where the cause is genuinely undetermined, that is recorded as such
 * (`cause_status: 'UNCONFIRMED'` with candidates) rather than by picking one.
 * A wrong confident code is worse than an honest uncertain one.
 */

/** Severity, and what it means for money. S2 and above must not settle. */
export const SEVERITIES = ['S0', 'S1', 'S2', 'S3', 'S4'] as const
export type Severity = (typeof SEVERITIES)[number]

export const SEVERITY_MEANING: Record<Severity, { meaning: string; consequence: string }> = {
  S0: { meaning: 'informational', consequence: 'record only' },
  S1: { meaning: 'transient, recoverable', consequence: 'bounded retry' },
  S2: { meaning: 'degraded quality or uncertain', consequence: 'PROVISIONAL — no economic action' },
  S3: { meaning: 'material risk to the judgment', consequence: 'HOLD evaluation and settlement, human review' },
  S4: {
    meaning: 'security, privacy, funds or legal incident',
    consequence: 'freeze scope, block credentials and tools, escalate immediately',
  },
}

/**
 * The families. These are the stable part of the vocabulary — a code may be
 * added to a family without renegotiating what the family means.
 *
 * `defaultSeverity` is a policy starting point, not a fact. Real incidents
 * escalate on amount, user harm, personal data, and whether an attacker was
 * involved — see `escalate`.
 */
export const FAMILIES = {
  AUTH: { name: 'authorisation', defaultSeverity: 'S3', of: 'principal, scope, credential or ownership not permitted' },
  SEC: { name: 'attack', defaultSeverity: 'S4', of: 'prompt or tool injection, sandbox escape, poisoning, secret exfiltration' },
  DAT: { name: 'data integrity', defaultSeverity: 'S3', of: 'corrupt, stale, partial or mis-associated evidence' },
  RAT: { name: 'quota and rate', defaultSeverity: 'S1', of: 'provider or platform quota and concurrency exceeded' },
  PRV: { name: 'privacy', defaultSeverity: 'S4', of: 'unauthorised access to, exposure of, or retention of personal data' },
  DET: { name: 'non-determinism', defaultSeverity: 'S2', of: 'the same input did not produce the same judgment' },
  VER: { name: 'verification mismatch', defaultSeverity: 'S3', of: 'evaluators disagree, or a check could not be reconciled' },
  RPL: { name: 'replay', defaultSeverity: 'S3', of: 'a request, signature, webhook or settlement reused' },
  IDN: { name: 'identity', defaultSeverity: 'S3', of: 'Sybil, impersonation, or a controller that cannot be established' },
  ORC: { name: 'oracle', defaultSeverity: 'S3', of: 'external price or fact data manipulated, stale or biased' },
  ECO: { name: 'economic', defaultSeverity: 'S3', of: 'settlement, escrow or accounting inconsistency' },
  LEG: { name: 'legal', defaultSeverity: 'S3', of: 'consent, explanation, review or jurisdictional requirement unmet' },
  SPC: { name: 'specification', defaultSeverity: 'S2', of: 'rubric or acceptance criteria ambiguous, contradictory or missing' },
  MOD: { name: 'model judgment', defaultSeverity: 'S2', of: 'the evaluator hallucinated, misread, or judged outside its competence' },
  TIM: { name: 'time', defaultSeverity: 'S1', of: 'timeout, latency, or an ordering assumption violated' },
  DEP: { name: 'dependency', defaultSeverity: 'S1', of: 'an external service this judgment needed was unavailable' },
} as const satisfies Record<string, { name: string; defaultSeverity: Severity; of: string }>

export type Family = keyof typeof FAMILIES

/**
 * Codes sourced exactly from the study.
 *
 * Deliberately NOT the full 80. The study defines five per family, and this
 * table carries only the labels that were read verbatim — inventing the rest
 * would be the same false confidence the whole design refuses. A family with
 * no code yet is still usable: `FAM-000` reads as "this family, cause not yet
 * codified", which is an honest statement and an actionable one.
 */
export const CODES: Record<string, { family: Family; label: string; severity: Severity; disposition: string }> = {
  'AUTH-001': { family: 'AUTH', label: 'SCOPE_MISSING', severity: 'S2', disposition: 'refuse the call' },
  'AUTH-002': { family: 'AUTH', label: 'CREDENTIAL_EXPIRED', severity: 'S1', disposition: 'refresh safely, then retry' },
  'AUTH-003': { family: 'AUTH', label: 'PRIVILEGE_ESCALATION', severity: 'S4', disposition: 'block immediately, revoke credential' },
  'VER-003': { family: 'VER', label: 'JUDGE_DISAGREEMENT', severity: 'S3', disposition: 'hold, do not settle on either verdict' },
  'MOD-001': { family: 'MOD', label: 'HALLUCINATED_EVIDENCE', severity: 'S3', disposition: 'invalidate the judgment' },
  'TIM-002': { family: 'TIM', label: 'EXEC_TIMEOUT', severity: 'S1', disposition: 'retry within budget' },
  'DEP-001': { family: 'DEP', label: 'SERVICE_UNAVAILABLE', severity: 'S1', disposition: 'retry with backoff' },
}

/** Codes that name nothing. Refused because a diagnosis that cannot be acted
 *  on is worse than no diagnosis — it looks like one. */
export const GENERIC_CODES = ['ERROR', 'INVALID', 'FAILED', 'UNKNOWN', 'BAD_RESULT', 'GRADING_FAILED'] as const

export function isGenericCode(code: string): boolean {
  return (GENERIC_CODES as readonly string[]).includes(code.trim().toUpperCase())
}

const CODE_SHAPE = /^[A-Z]{3,4}-\d{3}$/

export type CodeVerdict = { ok: true } | { ok: false; why: string }

/** Is this a usable failure code? */
export function validateCode(code: string): CodeVerdict {
  const trimmed = code.trim()
  if (isGenericCode(trimmed)) {
    return {
      ok: false,
      why: `"${trimmed}" names no cause. Use a family code (e.g. DEP-001 SERVICE_UNAVAILABLE) so the reader can act on it.`,
    }
  }
  if (!CODE_SHAPE.test(trimmed)) return { ok: false, why: `"${trimmed}" is not of the form FAM-000.` }
  const family = trimmed.split('-')[0] as Family
  if (!(family in FAMILIES)) return { ok: false, why: `"${family}" is not a known failure family.` }
  return { ok: true }
}

/** The two axes. Orthogonal on purpose — every combination is meaningful. */
export const TASK_OUTCOMES = ['PASS', 'FAIL', 'REFUSED_BRIEF', 'CANNOT_DO', 'UNKNOWN'] as const
export type TaskOutcome = (typeof TASK_OUTCOMES)[number]

export const EXECUTION_STATES = ['SUCCESS', 'FAILURE', 'PARTIAL'] as const
export type EvaluationExecution = (typeof EXECUTION_STATES)[number]

/** Where a judgment stands. Separate from the failure code, because a code
 *  says what went wrong and this says what may now happen. */
export const JUDGMENT_STATES = [
  'RECEIVED',
  'VALIDATING',
  'EVALUATING',
  'VERIFYING',
  'FINAL',
  'PROVISIONAL',
  'HELD',
  'INVALIDATED',
  'ESCALATED',
  'REVIEWED',
  'REVERSED',
  'REMEDIATION_REQUIRED',
] as const
export type JudgmentState = (typeof JUDGMENT_STATES)[number]

/**
 * A diagnosis. `causeStatus` is the field that keeps this honest: an
 * undetermined cause is recorded as undetermined, with candidates, instead of
 * being resolved by picking the most likely one.
 */
export type Diagnosis = {
  primaryCode: string
  causeStatus: 'CONFIRMED' | 'UNCONFIRMED'
  suspectedCauses?: string[]
  severity: Severity
  taskOutcome: TaskOutcome
  execution: EvaluationExecution
}

/**
 * Severity for a code in context.
 *
 * The same code is not the same incident. The study's example: TIM-002
 * EXEC_TIMEOUT is S1 for a test that ran long, and S3–S4 when the response
 * lost was a payment transaction's — because then whether money moved is
 * unknown, which is a different fact about the world.
 *
 * Escalation only. A context can raise a severity and never lower one: the
 * table's value is a floor, and anything that could reduce it is an argument
 * to be made by a person, not by a default.
 */
export function severityFor(
  code: string,
  context?: {
    /** The lost response might have moved money. */
    fundsAtRisk?: boolean
    /** Personal data was in scope. */
    personalData?: boolean
    /** An attacker is suspected. */
    adversarial?: boolean
  },
): Severity {
  const known = CODES[code.trim()]
  const family = code.trim().split('-')[0] as Family
  const base: Severity = known?.severity ?? (family in FAMILIES ? FAMILIES[family].defaultSeverity : 'S3')
  if (!context) return base
  let raised = base
  const at = (s: Severity) => {
    if (SEVERITIES.indexOf(s) > SEVERITIES.indexOf(raised)) raised = s
  }
  if (context.fundsAtRisk) at('S3')
  if (context.personalData) at('S4')
  if (context.adversarial) at('S4')
  return raised
}

/** May this diagnosis settle money? S2 and above may not — a judgment that is
 *  merely uncertain is still not one to pay on. */
export function maySettle(d: Pick<Diagnosis, 'severity' | 'execution' | 'taskOutcome'>): boolean {
  if (SEVERITIES.indexOf(d.severity) >= SEVERITIES.indexOf('S2')) return false
  if (d.execution !== 'SUCCESS') return false
  return d.taskOutcome === 'PASS' || d.taskOutcome === 'FAIL'
}

/**
 * Is this failure the worker's responsibility?
 *
 * The question the two axes exist to answer, and the one a single FAILED
 * state cannot. An evaluation that did not complete says nothing about the
 * worker — charging a credit hit for an outage is how a system fault becomes
 * someone's penalty.
 */
export function attributableToWorker(d: Pick<Diagnosis, 'taskOutcome' | 'execution'>): boolean {
  if (d.execution !== 'SUCCESS') return false
  return d.taskOutcome === 'FAIL'
}

/** Where a diagnosis leaves the judgment. */
export function stateFor(d: Pick<Diagnosis, 'severity' | 'execution' | 'taskOutcome' | 'causeStatus'>): JudgmentState {
  if (d.severity === 'S4') return 'ESCALATED'
  if (d.severity === 'S3') return 'HELD'
  if (d.execution === 'FAILURE') return 'HELD'
  if (d.severity === 'S2' || d.execution === 'PARTIAL' || d.causeStatus === 'UNCONFIRMED') return 'PROVISIONAL'
  return 'FINAL'
}
