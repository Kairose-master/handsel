// Idempotent schema migration for the Neon PostgreSQL database.
// Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs  (or `pnpm db:migrate`)
//
// `sql` is exported so app/api/admin/migrate/route.ts can run the exact same
// statements against the app's own DB connection — eliminates any ambiguity
// about which DATABASE_URL a locally-run migration actually targeted.
import pg from 'pg'

export const sql = /* sql */ `
-- ── Better Auth tables ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user" (
  id            text PRIMARY KEY,
  name          text,
  email         text NOT NULL UNIQUE,
  emailverified boolean NOT NULL DEFAULT false,
  image         text,
  password      text,
  createdat     timestamptz NOT NULL DEFAULT now(),
  updatedat     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "payoutaddress" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "walletmaxtxusd" numeric(12,2);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "walletdailycapusd" numeric(12,2);

CREATE TABLE IF NOT EXISTS "delegations" (
  id             text PRIMARY KEY,
  user_id        text NOT NULL,
  prime_agent_id text NOT NULL,
  task           text NOT NULL,
  budget_usd     numeric(12,2) NOT NULL,
  status         text NOT NULL DEFAULT 'planned',
  subtasks       jsonb NOT NULL DEFAULT '[]',
  auto_verify    boolean NOT NULL DEFAULT true,
  final_output   text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session" (
  id        text PRIMARY KEY,
  userid    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token     text NOT NULL,
  expiresat timestamptz NOT NULL,
  ipaddress text,
  useragent text,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "account" (
  id                text PRIMARY KEY,
  userid            text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accountid         text NOT NULL,
  provider          text NOT NULL,
  provideraccountid text NOT NULL,
  refreshtoken      text,
  accesstoken       text,
  expiresat         timestamptz,
  createdat         timestamptz NOT NULL DEFAULT now(),
  updatedat         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "verification" (
  id         text PRIMARY KEY,
  identifier text NOT NULL,
  value      text NOT NULL,
  expiresat  timestamptz NOT NULL,
  createdat  timestamptz DEFAULT now(),
  updatedat  timestamptz DEFAULT now()
);

-- ── Legacy repair ──────────────────────────────────────────────────
-- Early versions of this database were created with all-lowercase
-- column names (userid, creditscore, ...) that don't match the quoted
-- camelCase identifiers the app uses. Drop such tables when they are
-- empty so they are recreated correctly below; refuse when they hold
-- data, since that needs a manual migration.
DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent','creditLine','creditTransaction','creditAssessment','riskMetric','insurancePolicy'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = t)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = t AND column_name = 'userId')
    THEN
      EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
      IF n = 0 THEN
        EXECUTE format('DROP TABLE %I', t);
        RAISE NOTICE 'Dropped legacy lowercase-column table: %', t;
      ELSE
        RAISE EXCEPTION 'Legacy table % has % rows; migrate its data manually before rerunning', t, n;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ── Direct messages ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dm_threads (
  id          text PRIMARY KEY,
  user_a_id   text NOT NULL,
  user_b_id   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dm_threads_user_a_idx ON dm_threads (user_a_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS dm_threads_user_b_idx ON dm_threads (user_b_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dm_messages (
  id         text PRIMARY KEY,
  thread_id  text NOT NULL,
  sender_id  text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dm_messages_thread_idx ON dm_messages (thread_id, created_at ASC);

-- ── Platform-wide activity feed ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_events (
  id         text PRIMARY KEY,
  kind       text NOT NULL,
  summary    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_events_created_idx ON platform_events (created_at DESC);

-- ── Live per-task progress feed (cosmetic; agent_events stays authoritative) ──
CREATE TABLE IF NOT EXISTS task_progress (
  id         text PRIMARY KEY,
  task_id    text NOT NULL,
  event_type text NOT NULL,
  detail     jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_progress_task_idx ON task_progress (task_id, created_at);

-- ── Access control matrix ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_grants (
  user_id     text NOT NULL,
  permission  text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  text
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_grants_unique ON admin_grants (user_id, permission);

CREATE TABLE IF NOT EXISTS credit_rating_rules (
  id         text PRIMARY KEY,
  kind       text NOT NULL,
  min_score  integer NOT NULL,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
CREATE INDEX IF NOT EXISTS credit_rating_rules_kind_idx ON credit_rating_rules (kind, min_score DESC);

-- ── BYOK user API keys (encrypted at rest) ──────────────────────────
CREATE TABLE IF NOT EXISTS user_api_keys (
  user_id           text PRIMARY KEY,
  anthropic_key_enc text,
  key_hint          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_api_keys ALTER COLUMN anthropic_key_enc DROP NOT NULL;
ALTER TABLE user_api_keys ALTER COLUMN key_hint DROP NOT NULL;
ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS openai_base_url text;
ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS openai_key_enc text;
ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS openai_model text;
ALTER TABLE user_api_keys ADD COLUMN IF NOT EXISTS openai_hint text;

-- ── Agent identity ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "agent" (
  id                   text PRIMARY KEY,
  "userId"             text NOT NULL,
  name                 text NOT NULL,
  description          text,
  "walletAddress"      text NOT NULL UNIQUE,
  "modelVersion"       text DEFAULT 'claude-sonnet-5',
  "creditScore"        numeric(6,2) NOT NULL DEFAULT 0,
  "creditRating"       text DEFAULT 'unrated',
  "riskLevel"          text DEFAULT 'UNKNOWN',
  "riskRating"         text DEFAULT 'unrated',
  "totalCreditLine"    numeric(18,2) DEFAULT 0,
  "availableCredit"    numeric(18,2) DEFAULT 0,
  attestations         jsonb DEFAULT '[]',
  "performanceMetrics" jsonb DEFAULT '{}',
  "createdAt"          timestamptz NOT NULL DEFAULT now(),
  "updatedAt"          timestamptz NOT NULL DEFAULT now()
);

-- Columns added after the initial release (no-ops on fresh databases).
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "modelVersion" text DEFAULT 'claude-sonnet-5';
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "creditRating" text DEFAULT 'unrated';
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "riskLevel" text DEFAULT 'UNKNOWN';
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "smartAccountAddress" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "customInstructions" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "runtimeType" text DEFAULT 'platform';
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "webhookUrl" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "webhookSecretEnc" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "lastPollAt" timestamptz;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "erc8004Id" integer;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "autoMine" boolean NOT NULL DEFAULT false;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "cloudBaseUrl" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "cloudModel" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "cloudApiKeyEnc" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "mcpServerUrl" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "mcpToolName" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "mcpAuthHeaderEnc" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "messagingSuspended" boolean NOT NULL DEFAULT false;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "messagingSuspendedReason" text;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "autoVote" boolean NOT NULL DEFAULT false;
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "votePolicy" text;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'agent' AND column_name = 'creditScore') THEN
    ALTER TABLE "agent" ALTER COLUMN "creditScore" TYPE numeric(6,2);
  END IF;
END $$;

-- ── Behavioral event ledger ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_events (
  id             text PRIMARY KEY,
  agent_id       text NOT NULL,
  task_id        text NOT NULL,
  event_type     text NOT NULL,
  success        boolean NOT NULL DEFAULT true,
  execution_time integer NOT NULL DEFAULT 0,
  token_cost     integer NOT NULL DEFAULT 0,
  quality_score  numeric(4,3),
  detail         jsonb DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_events_agent_id_idx ON agent_events (agent_id, created_at DESC);

-- ── Credit score history (append-only) ─────────────────────────────
CREATE TABLE IF NOT EXISTS credit_scores (
  id                 text PRIMARY KEY,
  agent_id           text NOT NULL,
  score              integer NOT NULL,
  rating             text NOT NULL,
  credit_limit       numeric(18,2) NOT NULL,
  risk_level         text NOT NULL,
  calculation_reason text NOT NULL,
  breakdown          jsonb DEFAULT '{}',
  registry_tx_hash    text,
  attestation_tx_hash text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_scores_agent_id_idx ON credit_scores (agent_id, created_at DESC);
ALTER TABLE credit_scores ADD COLUMN IF NOT EXISTS registry_tx_hash text;
ALTER TABLE credit_scores ADD COLUMN IF NOT EXISTS attestation_tx_hash text;

-- ── Agent template marketplace (publish a recipe, buyers spawn clones) ──
CREATE TABLE IF NOT EXISTS agent_templates (
  id                  text PRIMARY KEY,
  creator_user_id     text NOT NULL,
  exemplar_agent_id   text NOT NULL,
  name                text NOT NULL,
  description         text,
  custom_instructions text NOT NULL,
  price_usd           numeric(18,2) NOT NULL DEFAULT 0,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_template_purchases (
  id             text PRIMARY KEY,
  template_id    text NOT NULL,
  buyer_user_id  text NOT NULL,
  buyer_agent_id text NOT NULL,
  price_usd      numeric(18,2) NOT NULL,
  tx_hash        text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── Labor market job metadata (on-chain spec is just a hash) ────────
CREATE TABLE IF NOT EXISTS job_specs (
  spec_hash          text PRIMARY KEY,
  title              text NOT NULL,
  description        text,
  requester_agent_id text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS acceptance_criteria text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS worker_agent_id text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS onchain_job_id integer;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS agent_task_id text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS dispute_note text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS attachment_url text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS attachment_name text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS test_code text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS test_result jsonb;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS repost_count integer NOT NULL DEFAULT 0;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS failed_worker_ids jsonb;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS claimed_by_agent_id text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS external_poster text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS auto_approve boolean NOT NULL DEFAULT true;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS parent_spec_hash text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS repo_full_name text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS base_branch text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS pr_number integer;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS ci_status text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS pricing jsonb;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS issue_number integer;
-- Which LaborMarket an onchain_job_id belongs to. Every deployment restarts the
-- jobId counter at 1, so without this the id alone is not an identifier.
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS onchain_contract text;
-- The two columns the sealed-brief work added to schema.ts and to no CREATE or
-- ALTER anywhere. drizzle names every declared column in its INSERT, so posting
-- a job failed on: column "test_suite_slug" of relation "job_specs" does not
-- exist — with the reason stripped to a digest by production Next.js. The
-- table-level parity guard passed the whole time: job_specs existed.
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS test_suite_slug text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS brief_nonce text;
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS split_spec jsonb;
-- The "creditTransaction" ALTERs used to sit here, ~80 lines ABOVE the CREATE
-- TABLE that makes it. ADD COLUMN IF NOT EXISTS skips a column that exists; it
-- does not skip a TABLE that does not, so on a fresh database this raised
-- relation "creditTransaction" does not exist.
--
-- And that error was fatal to the entire file: main() sends this whole string
-- through one pool.query, which Postgres runs as a single implicit
-- transaction — so one failed statement rolled back all 44 CREATE TABLEs. This
-- migration had never once completed against a new database, and could not
-- have. It only ever appeared to work because every database it was run on
-- already had the table.
--
-- They now live immediately after that CREATE. See the comment there.

-- ── Verified tasks (ground-truth graded, escrow-settled) ────────────
CREATE TABLE IF NOT EXISTS verifiable_tasks (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL,
  solver_agent_id    text NOT NULL,
  requester_agent_id text NOT NULL,
  difficulty         integer NOT NULL,
  problem            text NOT NULL,
  answer             text NOT NULL,
  salt               text NOT NULL,
  bounty_usd         numeric(18,2) NOT NULL,
  onchain_id         integer,
  agent_task_id      text,
  status             text NOT NULL DEFAULT 'posting',
  submitted_answer   text,
  post_tx_hash       text,
  settle_tx_hash     text,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verifiable_tasks_user_idx ON verifiable_tasks (user_id, created_at DESC);

-- ── Async task lifecycle ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_tasks (
  id         text PRIMARY KEY,
  user_id    text NOT NULL,
  agent_id   text NOT NULL,
  task       text NOT NULL,
  status     text NOT NULL DEFAULT 'running',
  output     text,
  result     jsonb,
  credit     jsonb,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_tasks_agent_id_idx ON agent_tasks (agent_id, created_at DESC);

-- ── Agent-to-agent negotiation (structured, separate from dm_messages) ──
CREATE TABLE IF NOT EXISTS agent_messages (
  id            text PRIMARY KEY,
  from_agent_id text NOT NULL,
  to_agent_id   text NOT NULL,
  type          text NOT NULL,
  body          text NOT NULL,
  payload       jsonb DEFAULT '{}',
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_messages_to_idx ON agent_messages (to_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_messages_from_idx ON agent_messages (from_agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_blocks (
  blocker_agent_id text NOT NULL,
  blocked_agent_id text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_blocks_unique ON agent_blocks (blocker_agent_id, blocked_agent_id);

-- ── Existing dashboard tables ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "creditLine" (
  id             text PRIMARY KEY,
  "userId"       text NOT NULL,
  "agentId"      text NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  "totalLimit"   numeric(18,2) NOT NULL,
  used           numeric(18,2) NOT NULL DEFAULT 0,
  available      numeric(18,2) NOT NULL,
  "interestRate" numeric(5,2) NOT NULL DEFAULT 8.5,
  "createdAt"    timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "creditTransaction" (
  id            text PRIMARY KEY,
  "userId"      text NOT NULL,
  "fromAgentId" text NOT NULL,
  "toAgentId"   text,
  status        text NOT NULL DEFAULT 'pending',
  amount        numeric(18,2) NOT NULL,
  type          text NOT NULL,
  description   text,
  "approvedAt"  timestamptz,
  "rejectedAt"  timestamptz,
  "settledAt"   timestamptz,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz NOT NULL DEFAULT now()
);

-- Moved here from ~80 lines earlier, where they ran BEFORE this table existed
-- and aborted the whole migration on any fresh database. ADD COLUMN IF NOT
-- EXISTS tolerates a missing column, never a missing table.
ALTER TABLE "creditTransaction" ADD COLUMN IF NOT EXISTS "dueAt" timestamptz;
ALTER TABLE "creditTransaction" ADD COLUMN IF NOT EXISTS "termDays" integer;
ALTER TABLE "creditTransaction" ADD COLUMN IF NOT EXISTS "defaultedAt" timestamptz;
ALTER TABLE "creditTransaction" ADD COLUMN IF NOT EXISTS "remindedPhase" text;

CREATE TABLE IF NOT EXISTS "creditAssessment" (
  id                   text PRIMARY KEY,
  "userId"             text NOT NULL,
  "agentId"            text NOT NULL,
  "onChainActivity"    numeric(5,2) NOT NULL DEFAULT 50,
  "transactionHistory" numeric(5,2) NOT NULL DEFAULT 60,
  "collateralScore"    numeric(5,2) NOT NULL DEFAULT 45,
  "attestationScore"   numeric(5,2) NOT NULL DEFAULT 55,
  "overallScore"       numeric(5,2) NOT NULL DEFAULT 0,
  weights              jsonb DEFAULT '{"onChainActivity":0.25,"transactionHistory":0.35,"collateralScore":0.2,"attestationScore":0.2}',
  "createdAt"          timestamptz NOT NULL DEFAULT now(),
  "updatedAt"          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "riskMetric" (
  id                   text PRIMARY KEY,
  "userId"             text NOT NULL,
  "agentId"            text NOT NULL,
  month                text NOT NULL,
  "defaultProbability" numeric(5,2) NOT NULL DEFAULT 0,
  "ratingBand"         text NOT NULL DEFAULT 'AAA',
  exposure             numeric(18,2) NOT NULL DEFAULT 0,
  "createdAt"          timestamptz NOT NULL DEFAULT now(),
  "updatedAt"          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "i18nLocale" (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "i18nString" (
  locale      text NOT NULL,
  key         text NOT NULL,
  value       text NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (locale, key)
);

ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS deliverable_kind text NOT NULL DEFAULT 'text';
ALTER TABLE job_specs ADD COLUMN IF NOT EXISTS required_capabilities jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '["text"]';

CREATE TABLE IF NOT EXISTS artifacts (
  id           text PRIMARY KEY,
  task_id      text NOT NULL,
  agent_id     text NOT NULL,
  name         text NOT NULL DEFAULT 'artifact',
  mime         text NOT NULL,
  data_base64  text NOT NULL,
  size         integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts (task_id);
-- Moved below the CREATE above. These ran before the table existed, and on a
-- fresh database that aborted the whole migration: ADD COLUMN IF NOT EXISTS
-- tolerates a missing column, never a missing table.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE artifacts ALTER COLUMN data_base64 DROP NOT NULL;

CREATE TABLE IF NOT EXISTS gov_accounts (
  user_id       text PRIMARY KEY,
  balance       numeric(24,6) NOT NULL DEFAULT 0,
  total_earned  numeric(24,6) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gov_locks (
  id         text PRIMARY KEY,
  user_id    text NOT NULL,
  amount     numeric(24,6) NOT NULL,
  locked_at  timestamptz NOT NULL DEFAULT now(),
  unlock_at  timestamptz NOT NULL,
  withdrawn  boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS gov_locks_user_idx ON gov_locks (user_id);
CREATE TABLE IF NOT EXISTS gov_proposals (
  id               text PRIMARY KEY,
  creator_user_id  text NOT NULL,
  title            text NOT NULL,
  body             text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  closes_at        timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS gov_votes (
  proposal_id  text NOT NULL,
  user_id      text NOT NULL,
  choice       text NOT NULL,
  power        numeric(24,6) NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  via_agent_id text,
  rationale    text,
  PRIMARY KEY (proposal_id, user_id)
);
ALTER TABLE gov_votes ADD COLUMN IF NOT EXISTS via_agent_id text;
ALTER TABLE gov_votes ADD COLUMN IF NOT EXISTS rationale text;
ALTER TABLE gov_votes ADD COLUMN IF NOT EXISTS confidence numeric(4,3);

CREATE TABLE IF NOT EXISTS gov_delegate_reviews (
  proposal_id  text NOT NULL,
  user_id      text NOT NULL,
  via_agent_id text NOT NULL,
  choice       text NOT NULL,
  confidence   numeric(4,3),
  rationale    text,
  reason       text,
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, user_id)
);

ALTER TABLE gov_proposals ADD COLUMN IF NOT EXISTS onchain_poll_address text;

CREATE TABLE IF NOT EXISTS gov_onchain_votes (
  proposal_id    text NOT NULL,
  user_id        text NOT NULL,
  agent_id       text NOT NULL,
  poll_address   text NOT NULL,
  option_index   integer NOT NULL,
  encrypted_salt text,
  commit_tx_hash text,
  reveal_tx_hash text,
  status         text NOT NULL DEFAULT 'committed',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, user_id)
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id     text PRIMARY KEY,
  scope  text NOT NULL,
  ip     text NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_attempts_scope_ip_at_idx ON auth_attempts (scope, ip, at);

-- One row per UserOperation the operator's paymaster paid for. Same shape and
-- the same reason as auth_attempts above: a per-instance counter is not a
-- counter at all across serverless fan-out. This one guards the operator's
-- wallet rather than a login -- see lib/onchain/gas-policy.ts.
CREATE TABLE IF NOT EXISTS sponsored_ops (
  id       text PRIMARY KEY,
  agent_id text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sponsored_ops_agent_at_idx ON sponsored_ops (agent_id, at);

CREATE TABLE IF NOT EXISTS oauth_clients (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  redirect_uris   jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code            text PRIMARY KEY,
  client_id       text NOT NULL,
  user_id         text NOT NULL,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  scope           text NOT NULL DEFAULT 'mcp',
  expires_at      timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token           text PRIMARY KEY,
  user_id         text NOT NULL,
  client_id       text NOT NULL,
  scope           text NOT NULL DEFAULT 'mcp',
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "insurancePolicy" (
  id           text PRIMARY KEY,
  "userId"     text NOT NULL,
  "agentId"    text NOT NULL,
  "policyType" text NOT NULL,
  coverage     numeric(18,2) NOT NULL,
  premium      numeric(18,2) NOT NULL,
  status       text NOT NULL DEFAULT 'active',
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);
-- ── V2 tables: the gas fuse's ledger, and the dispute gate's record ──
--
-- Both were declared in schema.ts and existed NOWHERE ELSE. This file did not
-- create them, and neither did the eight tables that genuinely self-create at
-- runtime (ops_leases, work_proofs, platform_secrets, settlement_queue, …), so
-- on a real deployment both simply failed.
--
-- gas_spend is the worse of the two, because its failure is invisible BY
-- DESIGN: lib/gas-budget.ts fails toward SPONSORING when the ledger is
-- unreadable — correct in itself, since refusing would take the market down
-- over a migration — and an unreadable ledger is indistinguishable from an
-- empty one. So the entire app-side fuse answered SPONSOR to everything while
-- looking exactly like a quiet day, with only the ZeroDev cap actually holding.

CREATE TABLE IF NOT EXISTS gas_spend (
  id         text PRIMARY KEY,
  lane       text NOT NULL,
  agent_id   text,
  usd        numeric(12,6) NOT NULL,
  label      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Every sponsored call filters on exactly this pair.
CREATE INDEX IF NOT EXISTS gas_spend_lane_created_idx ON gas_spend (lane, created_at);

CREATE TABLE IF NOT EXISTS dispute_rulings (
  id              text PRIMARY KEY,
  onchain_job_id  integer NOT NULL,
  decision        text NOT NULL,
  ground          text NOT NULL,
  reason          text NOT NULL,
  evidence        jsonb,
  tx_hash         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispute_rulings_job_idx ON dispute_rulings (onchain_job_id);

-- ── Backfill: reconnect reposted bounties to their GitHub issue ──────
--
-- Every repost path (grading failure, dispute refund, price raise) inserts a
-- NEW job_specs row copied from the old one, and all three carried
-- repo_full_name while dropping issue_number. That column is the CANCEL KEY:
-- the webhook's specsForIssue matches on (repo_full_name, issue_number), so a
-- reposted bounty answered "issue closed" with "no job for this issue" and
-- returned silently, leaving the escrow locked with no issue pointing at it.
--
-- The code is fixed; these rows are not, and a fix that only applies to future
-- reposts leaves the money that is already stranded exactly where it is.
--
-- Climbs parent_spec_hash — the lineage link the repost paths already write —
-- to the nearest ancestor that still knows its issue. Idempotent: it only ever
-- fills NULLs, so re-running is a no-op. Depth-capped in case a chain ever
-- loops; a runaway recursion inside a migration is worse than an unfixed row.
WITH RECURSIVE climb(spec_hash, ancestor, depth) AS (
  SELECT spec_hash, parent_spec_hash, 0
    FROM job_specs
   WHERE issue_number IS NULL AND repo_full_name IS NOT NULL AND parent_spec_hash IS NOT NULL
  UNION ALL
  SELECT c.spec_hash, p.parent_spec_hash, c.depth + 1
    FROM climb c
    JOIN job_specs p ON p.spec_hash = c.ancestor
   WHERE p.issue_number IS NULL AND p.parent_spec_hash IS NOT NULL AND c.depth < 20
)
UPDATE job_specs t
   SET issue_number = a.issue_number
  FROM climb c
  JOIN job_specs a ON a.spec_hash = c.ancestor
 WHERE t.spec_hash = c.spec_hash
   AND t.issue_number IS NULL
   AND a.issue_number IS NOT NULL;
`

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Aborting.')
    process.exit(1)
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await pool.query(sql)
    console.log('Migration complete.')
  } finally {
    await pool.end()
  }
}

// Only auto-run when executed directly (`node scripts/migrate.mjs`), not
// when imported as a module (e.g. by the admin migrate API route).
const isDirectRun = process.argv[1] && process.argv[1].endsWith('migrate.mjs')
if (isDirectRun) {
  main().catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
}
