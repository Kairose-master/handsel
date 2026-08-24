import { jobSpec, user } from '@/lib/db/schema'

/**
 * A fixed, safe column set for `user` — never every schema-declared column.
 *
 * `db.select().from(user)` (no column list) and `db.query.user.findFirst()`
 * both expand to SELECT every column schema.ts declares, regardless of
 * whether the database migration adding a new one has actually run. That
 * mismatch already took production login down once (a new `payoutAddress`
 * column shipped ahead of its migration broke every session check) — see
 * lib/get-session.ts. This constant is the fix applied at the query layer
 * instead of by hand at each call site: extend it only when a real caller
 * needs the extra column, not defensively, and every `db.select(...)`
 * against `user` should pass it (or an explicit narrower subset) rather
 * than an empty column list.
 */
export const SAFE_USER_COLUMNS = {
  id: user.id,
  name: user.name,
  email: user.email,
  password: user.password,
} as const

/**
 * A fixed, safe column set for `job_specs` — the same defence as
 * SAFE_USER_COLUMNS above, applied to the table it has since bitten.
 *
 * `db.select().from(jobSpec)` expands to every column schema.ts declares, so a
 * column that ships ahead of its migration breaks EVERY reader of the table
 * rather than only the feature that introduced it. That is not hypothetical
 * here either: a new `pricing` column took down the public task feed and the
 * guest board exactly this way.
 *
 * This set is what `publicJobs()` (app/actions/guest.ts) actually reads.
 * Extend it only when a real caller needs the extra column — the value of the
 * list is precisely that it is smaller than the schema.
 */
export const SAFE_JOB_SPEC_COLUMNS = {
  specHash: jobSpec.specHash,
  title: jobSpec.title,
  description: jobSpec.description,
  acceptanceCriteria: jobSpec.acceptanceCriteria,
  requesterAgentId: jobSpec.requesterAgentId,
  workerAgentId: jobSpec.workerAgentId,
  agentTaskId: jobSpec.agentTaskId,
  disputeNote: jobSpec.disputeNote,
  attachmentUrl: jobSpec.attachmentUrl,
  attachmentName: jobSpec.attachmentName,
  testResult: jobSpec.testResult,
  testCode: jobSpec.testCode,
  repoFullName: jobSpec.repoFullName,
  baseBranch: jobSpec.baseBranch,
  deliverableKind: jobSpec.deliverableKind,
  requiredCapabilities: jobSpec.requiredCapabilities,
  officeOwnerId: jobSpec.officeOwnerId,
} as const
