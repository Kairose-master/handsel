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
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS ci_check_signature text',
  'ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS redteam_objective jsonb',
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

/** The CI-bounty policy table, created on first use like the KV tables the
 *  repo already self-migrates (CLAUDE.md). No row = no auto-spend, so the
 *  table simply existing is safe. */
const CI_BOUNTY_ADDITIONS = [
  `CREATE TABLE IF NOT EXISTS ci_bounty_policies (
    repo_full_name text PRIMARY KEY,
    funder_agent_id text NOT NULL,
    bounty_usd numeric(18,2) NOT NULL,
    daily_cap_usd numeric(18,2) NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
]

/** The build-service run table (docs/build-service.md increment 2), created
 *  on first use like the other KV/run tables. No row = no build ever posted,
 *  so the table simply existing is safe. */
const BUILD_RUN_ADDITIONS = [
  `CREATE TABLE IF NOT EXISTS build_runs (
    id text PRIMARY KEY,
    requester_agent_id text NOT NULL,
    goal text NOT NULL,
    repo_full_name text NOT NULL,
    budget_base_units text NOT NULL,
    drawn_base_units text NOT NULL,
    refunded_base_units text NOT NULL,
    closed boolean NOT NULL DEFAULT false,
    status text NOT NULL,
    spec_hash text,
    bounty_usd numeric(18,2),
    fee_usd numeric(18,2),
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
]

/** Origin-control proofs for the red-team lane (lib/redteam.ts). `verified_at`
 *  is nullable because an issued-but-unanswered challenge is a real state, not
 *  a missing row. The unique index is on (target_key, user_id): two accounts may
 *  each hold a challenge for the same origin, but neither gets two. */
const REDTEAM_ADDITIONS = [
  `CREATE TABLE IF NOT EXISTS redteam_origin_proofs (
    target_key text NOT NULL,
    user_id text NOT NULL,
    nonce text NOT NULL,
    verified_at timestamptz,
    issued_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS redteam_origin_proofs_target_user
     ON redteam_origin_proofs (target_key, user_id)`,
]

/** The comparability class of a stored score (lib/credit-engine/version.ts).
 *  Nullable on purpose — rows written before the stamp existed have no honest
 *  value, and null is the honest one. */
const CREDIT_SCORE_ADDITIONS = [
  'ALTER TABLE credit_scores ADD COLUMN IF NOT EXISTS engine_version text',
]

let inFlight: Promise<void> | null = null
let creditTxInFlight: Promise<void> | null = null
let creditScoreInFlight: Promise<void> | null = null
let ciBountyInFlight: Promise<void> | null = null
let redteamInFlight: Promise<void> | null = null
let buildRunInFlight: Promise<void> | null = null

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

/** Same net for `credit_scores`. Called from the credit engine's write path,
 *  which is the only writer. */
export function ensureCreditScoreColumns(): Promise<void> {
  if (!creditScoreInFlight) {
    creditScoreInFlight = (async () => {
      for (const statement of CREDIT_SCORE_ADDITIONS) {
        try {
          await pool.query(statement)
        } catch (error) {
          console.error('[ensure-columns]', statement, error)
        }
      }
    })()
  }
  return creditScoreInFlight
}

/** Create the CI-bounty policy table on first use. Called from the webhook's
 *  CI-failure path and the policy admin API. */
export function ensureCiBountyTable(): Promise<void> {
  if (!ciBountyInFlight) {
    ciBountyInFlight = (async () => {
      for (const statement of CI_BOUNTY_ADDITIONS) {
        try {
          await pool.query(statement)
        } catch (error) {
          console.error('[ensure-columns]', statement.slice(0, 60), error)
        }
      }
    })()
  }
  return ciBountyInFlight
}

/** Create the red-team origin-proof table on first use. Called from the
 *  verification API and from engagement creation. */
export function ensureRedteamTables(): Promise<void> {
  if (!redteamInFlight) {
    redteamInFlight = (async () => {
      for (const statement of REDTEAM_ADDITIONS) {
        try {
          await pool.query(statement)
        } catch (error) {
          console.error('[ensure-columns]', statement.slice(0, 60), error)
        }
      }
    })()
  }
  return redteamInFlight
}

/** Create the build_runs table on first use. Called from POST /api/build
 *  before the first insert. */
export function ensureBuildRunTable(): Promise<void> {
  if (!buildRunInFlight) {
    buildRunInFlight = (async () => {
      for (const statement of BUILD_RUN_ADDITIONS) {
        try {
          await pool.query(statement)
        } catch (error) {
          console.error('[ensure-columns]', statement.slice(0, 60), error)
        }
      }
    })()
  }
  return buildRunInFlight
}
