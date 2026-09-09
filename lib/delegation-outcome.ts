/** Delivery status is distinct from the delegation row's terminal status. */
export type OutcomeStep = {
  isIntegration?: boolean
  failed?: boolean
  output?: string | null
}

/** An unavailable grader leaves the check pending rather than manufacturing a verdict. */
export function integrationGradeUpdate(grade: { passed: boolean | null; output: string }): { output: string } | { failed: true; failReason: string } {
  if (grade.passed === true) return { output: `Integration tests PASSED.\n${grade.output.slice(0, 500)}` }
  if (grade.passed === false) return { failed: true, failReason: `integration tests FAILED — the pieces don't work together:\n${grade.output.slice(0, 500)}` }
  throw new Error(`Integration grader unavailable: ${grade.output.slice(0, 200)}`)
}

export function integrationOutcome(step: OutcomeStep): 'passed' | 'failed' | 'unverified' {
  if (step.failed) return 'failed'
  // Legacy rows also contain explanatory output when the grader was down.
  // Only the success marker written by the integration runner proves a pass.
  return step.output?.startsWith('Integration tests PASSED.') ? 'passed' : 'unverified'
}

export function commissionOutcome(status: string, steps: readonly OutcomeStep[]): 'running' | 'completed' | 'failed' {
  if (status === 'failed' || status === 'cancelled' || status === 'expired') return 'failed'
  if (status !== 'completed') return 'running'
  const work = steps.filter((step) => !step.isIntegration)
  if (!work.length || work.some((step) => step.failed || !step.output?.trim())) return 'failed'
  if (steps.some((step) => step.isIntegration && integrationOutcome(step) !== 'passed')) return 'failed'
  return 'completed'
}
