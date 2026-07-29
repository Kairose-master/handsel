/**
 * Self-healing for columns that ship ahead of their migration.
 *
 * `db.select().from(jobSpec)` expands to SELECT every column schema.ts
 * declares — whether or not the migration adding one has actually run. So a
 * new column in schema.ts takes down EVERY reader of that table the moment it
 * deploys, not just the feature that uses it. This has now bitten twice: once
 * on `user.payoutAddress` (which broke every login — see lib/get-session.ts
 * and lib/db/safe-select.ts) and once on `job_specs.pricing` (which broke the
 * public task feed).
 *
 * `safe-select.ts` fixes it for `user` by pinning an explicit column list.
 * That does not scale to `job_specs`, which has 30+ full-select call sites,
 * so this file takes the codebase's other established approach instead — the
 * additive runtime ALTER that `platform_secrets` and `work_proofs` already
 * use (see CLAUDE.md: "many tables self-migrate on first use").
 *
 * The ALTER only has to succeed ONCE, ever: after that the column exists in
 * the database for every process and every deploy. Calling this from the hot
 * entry points is therefore enough to close the window between a deploy and
 * `pnpm db:migrate`, which is the entire failure being defended against.
 */
import { pool } from '@/lib/db'

/** Columns added to job_specs recently enough that a deployed schema.ts may
 *  reference them before the migration has been run. Keep in sync with
 *  scripts/migrate.mjs — this is a safety net, not the source of truth. */
const JOB_SPEC_ADDITIONS = [
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS repo_full_name text',
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS base_branch text',
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS pr_number integer',
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS ci_status text',
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS pricing jsonb',
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS issue_number integer',
  // Which LaborMarket an onchain_job_id belongs to. Without it a redeploy makes
  // every stored id ambiguous — see the column comment in schema.ts.
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS onchain_contract text',
  // Sealed-brief columns. These reached schema.ts without reaching any CREATE or
  // ALTER, and drizzle names every declared column in its INSERT — so this pair
  // did not break one feature, it broke POSTING A JOB.
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS test_suite_slug text',
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS brief_nonce text',
]

const CREDIT_TX_ADDITIONS = [
  'ALTER TABLE "creditTransaction" ADD COLUMN IF NOT EXISTS "dueAt" timestamptz',
  'ALTER TABLE "creditTransaction" ADD COLUMN IF NOT EXISTS "termDays" integer',
  'ALTER TABLE "creditTransaction" ADD COLUMN IF NOT EXISTS "defaultedAt" timestamptz',
  'ALTER TABLE "creditTransaction" ADD COLUMN IF NOT EXISTS "remindedPhase" text',
]

let inFlight: Promise<void> | null = null
let creditTxInFlight: Promise<void> | null = null

/**
 * Ensure job_specs has every column the running schema declares. Memoized per
 * process and safe to call on any read path; failures are swallowed so this
 * can never itself become the reason a page breaks.
 */
export function ensureJobSpecColumns(): Promise<void> {
  if (!inFlight) {
    inFlight = (async () => {
      for (const statement of JOB_SPEC_ADDITIONS) {
        try {
          await pool.query(statement)
        } catch (error) {
          // A missing table (fresh database) or a permissions issue is the
          // migration's problem, not this read path's.
          console.error('[ensure-columns]', statement, error)
        }
      }
    })()
  }
  return inFlight
}

/** Same defence for creditTransaction — added BEFORE the deploy this time,
 *  not after the outage. */
export function ensureCreditTransactionColumns(): Promise<void> {
  if (!creditTxInFlight) {
    creditTxInFlight = (async () => {
      for (const statement of CREDIT_TX_ADDITIONS) {
        try {
          await pool.query(statement)
        } catch (error) {
          console.error('[ensure-columns]', statement, error)
        }
      }
    })()
  }
  return creditTxInFlight
}
