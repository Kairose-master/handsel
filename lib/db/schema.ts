import { pgTable, text, timestamp, boolean, decimal, integer, jsonb, primaryKey, index } from 'drizzle-orm/pg-core'
import type { RedTeamObjective } from '@/lib/redteam'

// Better Auth Tables
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailverified').notNull().default(false),
  image: text('image'),
  password: text('password'),
  // Pre-registered payout wallet: lets "withdraw all earnings" sweep every
  // owned agent's USDC balance to one address with a single click instead
  // of re-typing a recipient per agent, per withdrawal.
  payoutAddress: text('payoutaddress'),
  // Per-account spending-policy overrides (null = platform default from
  // WALLET_MAX_TX_USD / WALLET_DAILY_CAP_USD). The caps protect the OWNER's
  // funds from a runaway/compromised agent, so the owner is the right
  // person to size them — an operator env var can't know one user wants a
  // $50 leash on an experiment and another wants to sweep $5k of earnings.
  walletMaxTxUsd: decimal('walletmaxtxusd', { precision: 12, scale: 2 }),
  walletDailyCapUsd: decimal('walletdailycapusd', { precision: 12, scale: 2 }),
  createdAt: timestamp('createdat', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedat', { withTimezone: true }).notNull().defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('userid').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  expiresAt: timestamp('expiresat', { withTimezone: true }).notNull(),
  ipAddress: text('ipaddress'),
  userAgent: text('useragent'),
  createdAt: timestamp('createdat', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedat', { withTimezone: true }).notNull().defaultNow(),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  userId: text('userid').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('accountid').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provideraccountid').notNull(),
  refreshToken: text('refreshtoken'),
  accessToken: text('accesstoken'),
  expiresAt: timestamp('expiresat', { withTimezone: true }),
  createdAt: timestamp('createdat', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedat', { withTimezone: true }).notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresat', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdat', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updatedat', { withTimezone: true }).defaultNow(),
})

/**
 * dm_threads / dm_messages — direct messages between two platform users.
 * One thread per unordered pair (userA, userB); userA is always the
 * lexicographically smaller id so a pair maps to exactly one thread.
 */
export const dmThread = pgTable('dm_threads', {
  id: text('id').primaryKey(),
  userAId: text('user_a_id').notNull(),
  userBId: text('user_b_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const dmMessage = pgTable('dm_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull(),
  senderId: text('sender_id').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * platform_events — a lightweight, append-only feed of notable cross-user
 * activity (job posted/completed, template published/bought, verified task
 * settled) so the marketplace feels alive. Purely additive/read-only from
 * the app's perspective; existing tables remain the source of truth.
 */
export const platformEvent = pgTable('platform_events', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // JOB_POSTED | JOB_COMPLETED | TEMPLATE_PUBLISHED | TEMPLATE_PURCHASED | VERIFIED_TASK_SETTLED
  summary: text('summary').notNull(), // pre-rendered human-readable line, no join needed to display
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * dispute_rulings — every decision the refund gate has made, append-only.
 *
 * The point is not an audit trail for the operator; it is that the rule is
 * PUBLISHED and each ruling can be checked against it. `REFUND_GATE_TABLE`
 * renders to markdown, so a reader sees the table and the rows it produced side
 * by side and can tell whether the two agree. A policy nobody can check is a
 * policy in name only, which is what "an admin clicked refund" was.
 *
 * Deliberately NOT `job_specs.disputeNote`, which the machine paths used to
 * write: that is a single last-writer-wins prose column, rendered publicly and
 * unauthenticated on the guest board, and it cannot hold more than one ruling
 * or say which rule produced it.
 */
/**
 * gas_spend — what sponsorship has actually cost, per lane.
 *
 * The budget in lib/gas-budget.ts is only as real as the ledger it reads. This
 * is deliberately separate from `creditTransaction` and the treasury tables:
 * those are USDC moving between parties, this is the operator's ETH leaving and
 * never coming back except through the fee.
 */
export const gasSpend = pgTable('gas_spend', {
  id: text('id').primaryKey(),
  /** 'user' | 'keeper' — the keeper reserve exists so that draining the user
   *  lane cannot disable the sweeps that free other people's escrow. */
  lane: text('lane').notNull(),
  agentId: text('agent_id'),
  /** Estimated USD. Estimated because the true cost is known only after the
   *  bundler settles, and a budget that waits for certainty is a budget that
   *  has already been overspent. */
  usd: decimal('usd', { precision: 12, scale: 6 }).notNull(),
  /** What it paid for, for the ops log. */
  label: text('label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const disputeRuling = pgTable('dispute_rulings', {
  id: text('id').primaryKey(),
  onchainJobId: integer('onchain_job_id').notNull(),
  /** 'refund' | 'no_refund' */
  decision: text('decision').notNull(),
  /** Which row of REFUND_GATE_TABLE fired: NO_DELIVERABLE, SUBSTITUTED, … */
  ground: text('ground').notNull(),
  reason: text('reason').notNull(),
  /** The evidence vector the decision was made from, so a ruling can be
   *  recomputed later against a table that may since have changed. */
  evidence: jsonb('evidence').$type<Record<string, unknown>>(),
  /** Null when the ruling was no_refund — nothing moved, so nothing to link. */
  txHash: text('tx_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * task_progress — live, per-task step feed (PLAN_CREATED, TOOL_EXECUTED,
 * TASK_COMPLETED, ...) pushed by the runtime as a task actually runs, so the
 * UI can show what an agent is doing in real time instead of only a final
 * result. Purely cosmetic, same as platform_events: agent_events (the
 * credit-scoring ledger) remains the sole authoritative record, written
 * once by /api/runtime/callback when the run finishes. A failed live push
 * never breaks the run itself.
 */
export const taskProgress = pgTable('task_progress', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  eventType: text('event_type').notNull(),
  detail: jsonb('detail').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * admin_grants — the access control matrix: rows are (user, permission)
 * pairs, so different admins can hold different capabilities instead of one
 * global "is admin" boolean. ADMIN_EMAIL (env) is a separate superadmin
 * bootstrap — always implicitly holds every permission, so granting/revoking
 * rows here can never lock the platform operator out.
 */
export const adminGrant = pgTable('admin_grants', {
  userId: text('user_id').notNull(),
  permission: text('permission').notNull(), // 'disputes' | 'credit_rules' | ...
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  grantedBy: text('granted_by'), // userId of the admin who granted it, if not the superadmin
})

/**
 * credit_rating_rules — a DMN-style decision table overriding the
 * score -> rating / risk-level thresholds hardcoded in credit-engine's
 * scoring.ts. Empty table = use the shipped defaults (DEFAULT_RATING_RULES /
 * DEFAULT_RISK_RULES). Edited from /admin/credit-rules (requires the
 * 'credit_rules' permission) so a non-engineer can change lending policy
 * without touching code.
 */
/**
 * ci_bounty_policies — a repo owner's standing authorisation to turn red CI
 * checks into funded jobs. This table IS the money surface for the CI-bounty
 * lane: no row for a repo means no auto-spend, ever. See lib/ci-bounty.ts.
 */
export const ciBountyPolicy = pgTable('ci_bounty_policies', {
  repoFullName: text('repo_full_name').primaryKey(),
  funderAgentId: text('funder_agent_id').notNull(),
  bountyUsd: decimal('bounty_usd', { precision: 18, scale: 2 }).notNull(),
  dailyCapUsd: decimal('daily_cap_usd', { precision: 18, scale: 2 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: text('created_by'), // userId who set it
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * redteam_origin_proofs — proof that an account controls an https origin, and
 * may therefore authorise attacks against it (lib/redteam.ts).
 *
 * `verifiedAt` is nullable ON PURPOSE. A row with a nonce and no timestamp is a
 * challenge that was issued and never answered — a different fact from "verified
 * a long time ago". Both refuse an engagement; they refuse it differently, and
 * the schema has to be able to tell them apart or the code above it cannot.
 */
export const redteamOriginProof = pgTable('redteam_origin_proofs', {
  targetKey: text('target_key').notNull(), // 'endpoint:https://host[:port]'
  userId: text('user_id').notNull(),
  nonce: text('nonce').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * build_runs — one row per build (docs/build-service.md increment 2). v1
 * decision, recorded here because the doc says it must be explicit rather
 * than assumed: a build is exactly ONE repo job, not a planner-decomposed N
 * (lib/delegation.ts has zero repo-goal awareness today). `budget`/`drawn`/
 * `refunded` mirror `BuildEnvelope` (lib/build-envelope.ts) verbatim in base
 * units — this row IS the envelope's persistence, not a separate model of it.
 */
export const buildRun = pgTable('build_runs', {
  id: text('id').primaryKey(),
  requesterAgentId: text('requester_agent_id').notNull(),
  goal: text('goal').notNull(),
  repoFullName: text('repo_full_name').notNull(),
  budgetBaseUnits: text('budget_base_units').notNull(),
  drawnBaseUnits: text('drawn_base_units').notNull(),
  refundedBaseUnits: text('refunded_base_units').notNull(),
  closed: boolean('closed').notNull().default(false),
  // 'posted' (job escrowed, awaiting CI) | 'failed' (draw rejected or postRepoJob threw)
  status: text('status').notNull(),
  specHash: text('spec_hash'),
  bountyUsd: decimal('bounty_usd', { precision: 18, scale: 2 }),
  feeUsd: decimal('fee_usd', { precision: 18, scale: 2 }),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const creditRatingRule = pgTable('credit_rating_rules', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // 'rating' | 'risk_level'
  minScore: integer('min_score').notNull(),
  value: text('value').notNull(), // e.g. 'AAA' (kind=rating) or 'LOW' (kind=risk_level)
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'), // userId of the admin who last wrote this table
})

/**
 * user_api_keys — BYOK (bring your own key).
 * Each user's Anthropic key, AES-256-GCM encrypted at rest; their agent runs
 * bill their own account. Never returned to the client, never logged.
 */
export const userApiKey = pgTable('user_api_keys', {
  userId: text('user_id').primaryKey(),
  // Nullable since OpenAI-compatible keys landed: an account may bring
  // ONLY a Groq/OpenRouter/etc. key and no Anthropic key at all.
  anthropicKeyEnc: text('anthropic_key_enc'),
  keyHint: text('key_hint'), // last 4 chars, for display only
  // OpenAI-compatible BYOK (Groq, Together, OpenRouter, LM Studio…):
  // used by the delegation planner/verifier when no Anthropic key is set.
  openaiBaseUrl: text('openai_base_url'),
  openaiKeyEnc: text('openai_key_enc'),
  openaiModel: text('openai_model'),
  openaiHint: text('openai_hint'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// App Tables
export const agent = pgTable('agent', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  walletAddress: text('walletAddress').notNull().unique(),
  smartAccountAddress: text('smartAccountAddress'), // ERC-4337 Kernel account (Sepolia)
  customInstructions: text('customInstructions'), // from a purchased/cloned agent template, if any
  runtimeType: text('runtimeType').default('platform'), // 'platform' | 'webhook' (BYO endpoint we call) | 'local' (owner's worker polls us — no tunnel needed) | 'cloud' (we call the owner's own OpenAI-compatible cloud API key server-side — no terminal, no polling) | 'mcp' (we call an external MCP server's tool to do the work — any MCP-speaking agent as a worker)
  webhookUrl: text('webhookUrl'), // BYO agent HTTP endpoint, called instead of the platform runtime
  webhookSecretEnc: text('webhookSecretEnc'), // AES-256-GCM encrypted per-agent secret (webhook callbacks AND local-worker polling)
  lastPollAt: timestamp('lastPollAt', { withTimezone: true }), // local worker's last poll — powers the online/offline badge
  cloudBaseUrl: text('cloudBaseUrl'), // 'cloud' mode: OpenAI-compatible base URL (e.g. https://api.groq.com/openai/v1)
  cloudModel: text('cloudModel'), // 'cloud' mode: model name sent in the chat/completions request
  cloudApiKeyEnc: text('cloudApiKeyEnc'), // 'cloud' mode: AES-256-GCM encrypted API key, decrypted only server-side at dispatch time
  mcpServerUrl: text('mcpServerUrl'), // 'mcp' mode: external MCP server (Streamable HTTP) we call to do the work
  mcpToolName: text('mcpToolName'), // 'mcp' mode: which tool on that server does the work
  mcpAuthHeaderEnc: text('mcpAuthHeaderEnc'), // 'mcp' mode: AES-256-GCM encrypted Authorization header value (optional), sent only server-side at dispatch time
  // Platform-wide moderation for agent-to-agent messaging (open by design —
  // see agentMessage below): unlike agent_blocks, which is one recipient's
  // own opt-out, this is an admin ('agent_messages' permission) muting the
  // agent for EVERYONE at once, for abuse that a single block can't reach.
  messagingSuspended: boolean('messagingSuspended').notNull().default(false),
  messagingSuspendedReason: text('messagingSuspendedReason'),
  erc8004Id: integer('erc8004Id'), // this agent's id in the ERC-8004 Identity Registry, once registered
  autoMine: boolean('autoMine').notNull().default(false), // auto-accept qualifying open jobs when this local worker polls idle
  // Governance: any agent the owner opts in can act as its AI voting
  // delegate — the cron heartbeat reads open proposals and casts the owner's
  // $LEDGER vote per votePolicy. Off unless the owner explicitly opts in AND
  // sets a stance. Not gated on credit score (that's a labor-market signal,
  // unrelated to who the owner trusts to vote for them).
  autoVote: boolean('autoVote').notNull().default(false),
  votePolicy: text('votePolicy'), // the standing stance the delegate votes by
  // Deliverable kinds this worker can produce ('text' | 'image' | 'file').
  // Declared at registration (or edited later); auto-mine and dispatch only
  // match jobs whose deliverableKind the worker declared. Text-only is the
  // safe default — every LLM worker can do it.
  capabilities: jsonb('capabilities').$type<string[]>().notNull().default(['text']),
  modelVersion: text('modelVersion').default('claude-sonnet-5'),
  creditScore: decimal('creditScore', { precision: 6, scale: 2 }).notNull().default('0'),
  creditRating: text('creditRating').default('unrated'),
  riskLevel: text('riskLevel').default('UNKNOWN'),
  riskRating: text('riskRating').default('unrated'),
  totalCreditLine: decimal('totalCreditLine', { precision: 18, scale: 2 }).default('0'),
  availableCredit: decimal('availableCredit', { precision: 18, scale: 2 }).default('0'),
  attestations: jsonb('attestations').default([]),
  performanceMetrics: jsonb('performanceMetrics').default({}),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * agent_events — the behavioral ledger.
 * Every action taken by an agent runtime produces one structured event.
 * These rows are the raw input of the credit scoring engine: credit is
 * derived exclusively from recorded behavior, never assigned manually.
 */
export const agentEvent = pgTable('agent_events', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  taskId: text('task_id').notNull(),
  eventType: text('event_type').notNull(), // TASK_STARTED | PLAN_CREATED | TOOL_EXECUTED | TASK_COMPLETED | TASK_FAILED | ACHIEVEMENT_VERIFIED
  success: boolean('success').notNull().default(true),
  executionTime: integer('execution_time').notNull().default(0), // seconds
  tokenCost: integer('token_cost').notNull().default(0),
  qualityScore: decimal('quality_score', { precision: 4, scale: 3 }), // 0.000 – 1.000, set by the evaluation node
  detail: jsonb('detail').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * agent_tasks — async task lifecycle.
 * POST /tasks creates a row (status running) and returns immediately, so
 * the request never blocks on the multi-minute agent run and can't hit the
 * serverless function timeout. The runtime calls back on completion; the
 * dashboard polls this row for the result.
 */
export const agentTask = pgTable('agent_tasks', {
  id: text('id').primaryKey(), // taskId
  userId: text('user_id').notNull(),
  agentId: text('agent_id').notNull(),
  task: text('task').notNull(),
  status: text('status').notNull().default('running'), // running | processing | completed | failed
  output: text('output'),
  result: jsonb('result'), // { plan, qualityScore, evaluation, executionTime, tokenCost }
  credit: jsonb('credit'), // credit state after recalculation
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * agent_messages — a structured, machine-readable channel for agents to
 * negotiate directly with each other (division of labor: subcontracting,
 * proposals, status pings) — deliberately separate from dm_messages
 * (free-text human-to-human). `body` is natural language, for whichever
 * LLM reads the thread; `payload` carries the structured fields a proposal
 * actually needs (bounty_usd, deadline, acceptance_criteria, min_score,
 * ref_message_id for a reply chain). Open by design — any registered
 * agent can message any other — so sendAgentMessage() in
 * lib/agent-messages.ts enforces a rate limit, honors agent_blocks
 * (self-service, per-recipient), and honors agent.messagingSuspended
 * (admin-moderated, platform-wide — see the 'agent_messages' permission
 * in lib/admin.ts).
 *
 * This table NEVER moves money or creates a binding obligation by itself.
 * A 'job_proposal_accept' message is just information; turning agreed
 * terms into a real escrowed job is always a separate, explicit call to
 * the existing postJobAction — the same authorization boundary the
 * auto-approve design already settled on (see Claude.md).
 */
export const agentMessage = pgTable('agent_messages', {
  id: text('id').primaryKey(),
  fromAgentId: text('from_agent_id').notNull(),
  toAgentId: text('to_agent_id').notNull(),
  type: text('type').notNull(), // 'inquiry' | 'info' | 'job_proposal' | 'job_counter_proposal' | 'job_proposal_accept' | 'job_proposal_reject'
  body: text('body').notNull(),
  payload: jsonb('payload').default({}),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** One row = fromAgentId's owner has blocked messages from blockedAgentId. */
export const agentBlock = pgTable('agent_blocks', {
  blockerAgentId: text('blocker_agent_id').notNull(),
  blockedAgentId: text('blocked_agent_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * agent_templates — published agent "recipes" (custom instructions) other
 * users can buy to spawn their own new agent from. Credit history never
 * transfers: the spawned agent starts at a genuine cold start and earns its
 * own score. The exemplarAgentId points at the creator's real agent, whose
 * actual behavioral history (lib/db/schema agentEvent/verifiableTask/etc.)
 * serves as the portfolio proof shown to buyers — no fabricated claims.
 */
export const agentTemplate = pgTable('agent_templates', {
  id: text('id').primaryKey(),
  creatorUserId: text('creator_user_id').notNull(),
  exemplarAgentId: text('exemplar_agent_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  customInstructions: text('custom_instructions').notNull(),
  priceUsd: decimal('price_usd', { precision: 18, scale: 2 }).notNull().default('0'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** One purchase = one newly spawned agent for the buyer. */
export const agentTemplatePurchase = pgTable('agent_template_purchases', {
  id: text('id').primaryKey(),
  templateId: text('template_id').notNull(),
  buyerUserId: text('buyer_user_id').notNull(),
  buyerAgentId: text('buyer_agent_id').notNull(),
  priceUsd: decimal('price_usd', { precision: 18, scale: 2 }).notNull(),
  txHash: text('tx_hash'), // null for free templates
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * delegations — a big task handed to a "prime" agent, which decomposes it
 * and subcontracts the pieces as real Labor Market jobs (escrowed from the
 * prime agent's own wallet, bounded by the budget the owner set here).
 * Client → Prime → market workers: the hierarchical-delegation primitive.
 *
 * Subtask identity lives in the subtasks jsonb (specHash + onchainJobId
 * per entry); their live status is always derived from the on-chain job +
 * job_specs at read time, never cached here — only terminal results
 * (output snapshots, final assembly) are written back.
 */
export const delegation = pgTable('delegations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  primeAgentId: text('prime_agent_id').notNull(),
  task: text('task').notNull(),
  budgetUsd: decimal('budget_usd', { precision: 12, scale: 2 }).notNull(),
  /** planned → posted → completed | failed. 'planned' rows have a plan the
   *  owner hasn't confirmed yet — nothing has been escrowed. */
  status: text('status').notNull().default('planned'),
  /** [{ title, description, acceptanceCriteria, bountyUsd, testCode?,
   *     specHash?, onchainJobId?, output?, failed? }] */
  subtasks: jsonb('subtasks').$type<unknown[]>().notNull().default([]),
  /** Owner's standing consent for the prime agent to LLM-review Submitted
   *  work and release escrow on a pass — the delegation-level analogue of
   *  a job's autoApprove, chosen explicitly at creation. */
  autoVerify: boolean('auto_verify').notNull().default(true),
  finalOutput: text('final_output'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * job_specs — off-chain metadata for on-chain jobs.
 * The LaborMarket contract stores only a specHash; the human-readable title
 * and description live here, keyed by that hash. On-chain = money/state,
 * off-chain = content.
 */
export const jobSpec = pgTable('job_specs', {
  specHash: text('spec_hash').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  acceptanceCriteria: text('acceptance_criteria'), // what "done" means; fed to the worker agent's task prompt AND to dispute review
  requesterAgentId: text('requester_agent_id'),
  workerAgentId: text('worker_agent_id'), // set once a worker accepts
  onchainJobId: integer('onchain_job_id'), // the LaborMarket jobId, once known
  /**
   * WHICH LaborMarket that jobId belongs to.
   *
   * A jobId alone is not an identifier. Every deployment restarts the counter
   * at 1, so old #245 and new #245 are different jobs and nothing in the row
   * could tell them apart — which is why redeploying the contract used to mean
   * walking out and reposting every live job instead of just deploying.
   *
   * Null means "whatever ONCHAIN_LABOR_MARKET pointed at when this row was
   * written", which is the honest reading of every row that predates this
   * column. New writes always stamp it.
   */
  onchainContract: text('onchain_contract'),
  agentTaskId: text('agent_task_id'), // links to agent_tasks — the real run that produced the deliverable
  disputeNote: text('dispute_note'), // requester's reason, if disputed
  attachmentUrl: text('attachment_url'), // source material the worker agent should act on (Vercel Blob)
  attachmentName: text('attachment_name'),
  // Auto-graded code jobs: requester-authored Python asserts run against the
  // worker's submitted code by the PLATFORM runtime (grader ≠ solver).
  testCode: text('test_code'),
  /**
   * The platform-authored grader bound to this job, written ONLY by the code
   * that posts a catalog job — never derived from anything a requester supplies.
   *
   * `resolveTestSuiteSpec(title)` infers the same binding from a job TITLE, and
   * a title is user-supplied: anyone could name a job `tests → <slug>:` and be
   * graded by a platform reference implementation aimed at unrelated work. That
   * is harmless while a grader verdict only advises, and it is a forgeable
   * refund the moment a verdict can move escrow — see `authorOfRule`. This
   * column is the non-forgeable version of the same fact.
   */
  testSuiteSlug: text('test_suite_slug'),
  /**
   * The nonce inside the sealed brief, kept so the specHash can be RECOMPUTED.
   *
   * It was generated inline at every posting site and thrown away, which made
   * the on-chain commitment unverifiable by construction — you could hash a
   * brief but never check one. Rows written before this column exists return
   * `unverifiable` from briefMatchesHash, never `mismatch`; see lib/spec-hash.ts
   * for why that distinction is worth a third enum value.
   */
  briefNonce: text('brief_nonce'),
  // `refusedBrief` marks a submission the worker declined as directing them
  // outside the task (§24). It is stored HERE rather than in agent_events on
  // purpose: everything written to agent_events is scoring input, and a refusal
  // must not move a score in either direction. This is also what the free-pass
  // count reads back.
  //
  // `workerIncapable` is the OTHER thing a non-submission can be (§25): the
  // worker had no tool for the job. Kept as a separate field rather than a
  // second value of `refusedBrief` because the two are read by different
  // parties for different purposes — `refusedBrief` counts toward a worker's
  // free-pass limit and points at a requester, `workerIncapable` counts toward
  // nothing and points at no one.
  testResult: jsonb('test_result').$type<{
    passed: boolean | null
    output: string
    gradedAt: string
    refusedBrief?: boolean
    workerIncapable?: boolean
    /**
     * The worker's appeal against a failing verdict (`lib/appeal.ts`).
     *
     * Stored on the job rather than in `agent_events` for the same reason the
     * two flags above are: an appeal is a claim about a verdict, not behavioural
     * data about anyone, and it must not move a score by existing. Only its
     * OUTCOME may change `passed`, and then the change is to this same row.
     *
     * `originalPassed` is kept because once `passed` is rewritten the fact that
     * something was overturned is otherwise unrecoverable — and an appeal
     * process whose history you cannot read is indistinguishable from a verdict
     * that was never questioned.
     */
    appeal?: {
      filedAt: string
      route: 'recompute' | 'panel'
      originalPassed: boolean
      status: 'open' | 'resolved'
      resolvedAt?: string
      overturned?: boolean
      reason?: string
    }
  }>(),
  // Requester's explicit, authenticated-at-posting-time consent to release
  // escrow automatically on a passing verdict, with no further approval
  // click. Only meaningful when testCode is set. Defaults true (matches
  // house-agent jobs, which have no human ever coming back to click
  // approve) but the Post-a-Job form lets a real requester opt out and
  // keep manual review even for auto-graded jobs — see autoApprovePassedJob
  // in /api/runtime/callback, which now checks this flag before releasing
  // anything instead of inferring consent from testCode's mere presence.
  autoApprove: boolean('auto_approve').notNull().default(true),
  // What the worker must deliver: 'text' (default — the submitted output
  // string IS the deliverable), 'image' (the submission must attach image
  // artifact(s); graded by a vision LLM when a key is available, else
  // manual review), or 'file' (arbitrary attached artifact, manual review).
  deliverableKind: text('deliverable_kind').notNull().default('text'),
  // Tool capabilities the worker must declare to claim ('web' live web
  // access, 'code' code execution, 'gpu' heavy compute). Matched at every
  // accept gate alongside deliverableKind.
  requiredCapabilities: jsonb('required_capabilities').$type<string[]>().notNull().default([]),
  // Failed-tests auto-return: how many times this spec lineage has been
  // auto-reposted, and which workers already failed it (blocked from
  // re-accepting the repost).
  repostCount: integer('repost_count').notNull().default(0),
  failedWorkerIds: jsonb('failed_worker_ids').$type<string[]>(),
  // The spec this row was auto-reposted FROM (null for originals). The
  // explicit lineage pointer lets anything tracking the original job — a
  // delegation subtask, an external poster — follow the work to its
  // replacement instead of losing it at the first refund.
  parentSpecHash: text('parent_spec_hash'),
  // Mining-pool-style claim lock: before any on-chain accept, a worker
  // atomically claims the spec here — losers skip in milliseconds instead
  // of racing to an on-chain revert. TTL'd (stale claims expire) so a
  // claimer that dies releases the job.
  claimedByAgentId: text('claimed_by_agent_id'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  // x402-posted jobs: the external payer's address (attribution only —
  // on-chain requester is the platform's house agent, which fronted the
  // escrow that the payer's x402 payment bought).
  externalPoster: text('external_poster'),
  // GitHub repo jobs (docs/github-jobs.md): repoFullName set ⇒ the deliverable
  // is a unified diff, the platform App opens the PR, the repo's own CI is the
  // grader, and MERGE (never CI alone) releases the escrow via the webhook.
  repoFullName: text('repo_full_name'),
  baseBranch: text('base_branch'),
  prNumber: integer('pr_number'),
  ciStatus: text('ci_status'), // 'pending' | 'success' | 'failure' — mirrors the check-suite webhook
  // Label-to-bounty bot: the GitHub issue this job was minted from. One job
  // per (repoFullName, issueNumber) — the idempotency and cancel key.
  issueNumber: integer('issue_number'),
  // CI-bounty lane: the failing check this job was auto-originated from
  // (lib/ci-bounty.ts). Present ONLY on auto-posted CI-fix jobs, and its value
  // is ciFailureSignature() — the dedup key ("one red check is one job") and
  // the marker that makes daily spend countable per repo.
  ciCheckSignature: text('ci_check_signature'),
  // Red-team lane: the objective this job pays for (lib/redteam.ts). Present
  // ONLY on jobs minted by an authorised engagement, and its presence is what
  // routes grading to the deterministic canary/attestation judge instead of an
  // LLM. It holds a canary FINGERPRINT, never a canary.
  redteamObjective: jsonb('redteam_objective').$type<{
    engagementId: string
    targetKey: string
    objective: RedTeamObjective
  }>(),
  // Rising-price (Dutch auction) plan for an unclaimed job: PricingPlan from
  // lib/market-price.ts, or null for an ordinary fixed-price job. The CURRENT
  // price is never stored here — it is always the live on-chain bounty, since
  // a cached price that drifts from the escrow promises money the contract
  // cannot pay.
  // pendingUsd/pendingMinScore record a raise's intent BEFORE the old escrow
  // is cancelled, so a raise interrupted between refund and repost is a
  // resumable orphan instead of vanished work (lib/price-raise.ts).
  pricing: jsonb('pricing').$type<{
    ceilingUsd: number
    stepUsd: number
    stepMinutes: number
    raises?: number
    pendingUsd?: number
    pendingMinScore?: number
  }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * verifiable_tasks — verified-task lifecycle (the trustworthy quality signal).
 * The server generates problem + answer (grader ≠ solver), escrows the bounty
 * on-chain, sends only the problem to the solving agent, and on callback
 * grades the output against the hidden answer; correct answers settle the
 * escrow via commit-reveal. The answer/salt stay server-side until reveal.
 */
export const verifiableTask = pgTable('verifiable_tasks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  solverAgentId: text('solver_agent_id').notNull(),
  requesterAgentId: text('requester_agent_id').notNull(),
  difficulty: integer('difficulty').notNull(),
  problem: text('problem').notNull(),
  answer: text('answer').notNull(), // hidden ground truth
  salt: text('salt').notNull(), // commit-reveal salt
  bountyUsd: decimal('bounty_usd', { precision: 18, scale: 2 }).notNull(),
  onchainId: integer('onchain_id'),
  agentTaskId: text('agent_task_id'), // links to agent_tasks (the solve run)
  status: text('status').notNull().default('posting'), // posting | awaiting_solver | declined | solving | settling | completed | failed | error
  submittedAnswer: text('submitted_answer'),
  postTxHash: text('post_tx_hash'),
  settleTxHash: text('settle_tx_hash'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * credit_scores — append-only score history.
 * One row per recalculation, so the dashboard can show credit evolution
 * (before → after) together with the reason for each change.
 */
export const creditScoreEntry = pgTable('credit_scores', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  score: integer('score').notNull(), // 300 – 990
  rating: text('rating').notNull(), // AAA … D
  creditLimit: decimal('credit_limit', { precision: 18, scale: 2 }).notNull(),
  riskLevel: text('risk_level').notNull(), // LOW | MODERATE | ELEVATED | HIGH
  calculationReason: text('calculation_reason').notNull(),
  /** Which engine produced this number — `epoch@hash` from
   *  lib/credit-engine/version.ts. Null on rows written before the stamp
   *  existed, and null is NOT "probably current": see sameComparabilityClass. */
  engineVersion: text('engine_version'),
  breakdown: jsonb('breakdown').default({}), // per-factor component scores
  registryTxHash: text('registry_tx_hash'), // on-chain limit publish (optional)
  attestationTxHash: text('attestation_tx_hash'), // EAS attestation (optional)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const creditLine = pgTable('creditLine', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  agentId: text('agentId').notNull(),
  status: text('status').notNull().default('active'),
  totalLimit: decimal('totalLimit', { precision: 18, scale: 2 }).notNull(),
  used: decimal('used', { precision: 18, scale: 2 }).notNull().default('0'),
  available: decimal('available', { precision: 18, scale: 2 }).notNull(),
  interestRate: decimal('interestRate', { precision: 5, scale: 2 }).notNull().default('8.5'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const creditTransaction = pgTable('creditTransaction', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  fromAgentId: text('fromAgentId').notNull(),
  toAgentId: text('toAgentId'),
  status: text('status').notNull().default('pending'),
  amount: decimal('amount', { precision: 18, scale: 2 }).notNull(),
  type: text('type').notNull(),
  description: text('description'),
  // Loan terms (lib/loan-terms.ts): every credit_draw now matures. dueAt is
  // set at draw time; defaultedAt is stamped by the default sweep when the
  // loan runs past due + grace. Null dueAt = drawn before terms existed —
  // grandfathered, never retroactively defaulted.
  dueAt: timestamp('dueAt', { withTimezone: true }),
  termDays: integer('termDays'),
  defaultedAt: timestamp('defaultedAt', { withTimezone: true }),
  // Last loan-lifecycle email sent for this draw ('due-soon' | 'overdue' |
  // 'defaulted') — the dedup marker that keeps the reminder sweep from
  // re-mailing the same phase every cron tick.
  remindedPhase: text('remindedPhase'),
  approvedAt: timestamp('approvedAt', { withTimezone: true }),
  rejectedAt: timestamp('rejectedAt', { withTimezone: true }),
  settledAt: timestamp('settledAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const creditAssessment = pgTable('creditAssessment', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  agentId: text('agentId').notNull(),
  onChainActivity: decimal('onChainActivity', { precision: 5, scale: 2 }).notNull().default('50'),
  transactionHistory: decimal('transactionHistory', { precision: 5, scale: 2 }).notNull().default('60'),
  collateralScore: decimal('collateralScore', { precision: 5, scale: 2 }).notNull().default('45'),
  attestationScore: decimal('attestationScore', { precision: 5, scale: 2 }).notNull().default('55'),
  overallScore: decimal('overallScore', { precision: 5, scale: 2 }).notNull().default('0'),
  weights: jsonb('weights').default({
    onChainActivity: 0.25,
    transactionHistory: 0.35,
    collateralScore: 0.2,
    attestationScore: 0.2,
  }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const riskMetric = pgTable('riskMetric', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  agentId: text('agentId').notNull(),
  month: text('month').notNull(),
  defaultProbability: decimal('defaultProbability', { precision: 5, scale: 2 }).notNull().default('0'),
  ratingBand: text('ratingBand').notNull().default('AAA'),
  exposure: decimal('exposure', { precision: 18, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

// Runtime i18n: locales added from the admin UI (static LOCALES in
// lib/i18n-dict.ts stay the shipped baseline) …
export const i18nLocale = pgTable('i18nLocale', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

// … and LLM-translated strings filled in at runtime with a registered API
// key. Static dictionaries (human-reviewed, shipped in the bundle) always
// win over these rows; rows only cover keys the bundle doesn't.
export const i18nString = pgTable(
  'i18nString',
  {
    locale: text('locale').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.locale, t.key] })],
)

/**
 * Submission artifacts — binary deliverables (images, files) attached to a
 * task result via /api/runtime/callback. Stored inline as base64 (≤2MB
 * each, ≤4 per submission — testnet scale; swap the storage layer for
 * Vercel Blob when real volume arrives) and served by GET /api/artifacts/:id.
 * The unguessable id is the access token, same model as attachment URLs.
 */
export const artifact = pgTable('artifacts', {
  id: text('id').primaryKey(), // art-<nanoid>
  taskId: text('task_id').notNull(), // agent_tasks.id of the producing run
  agentId: text('agent_id').notNull(),
  name: text('name').notNull().default('artifact'),
  mime: text('mime').notNull(),
  /** Inline form — null when the artifact lives in blob storage instead. */
  dataBase64: text('data_base64'),
  /** Blob form (Vercel Blob public URL) — null for inline artifacts. */
  url: text('url'),
  size: integer('size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---- Governance: $LEDGER token, ve-lockup, proposals & voting ----
// Off-chain ledger v1 (Snapshot-style, testnet): $LEDGER is EARNED from
// real platform contribution (completed work), never bought — so voting
// weight tracks genuine usage, not capital. ve-lockup: locking longer
// grants more voting power per token, decaying linearly to zero at unlock.

/** Unlocked $LEDGER balance per account (locked amounts live in govLock). */
export const govAccount = pgTable('gov_accounts', {
  userId: text('user_id').primaryKey(),
  balance: decimal('balance', { precision: 24, scale: 6 }).notNull().default('0'),
  totalEarned: decimal('total_earned', { precision: 24, scale: 6 }).notNull().default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A vote-escrow lock: `amount` $LEDGER locked from lockedAt until unlockAt.
 *  Voting power = amount × (unlockAt − now) / MAX_LOCK, ≥ 0. */
export const govLock = pgTable(
  'gov_locks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    amount: decimal('amount', { precision: 24, scale: 6 }).notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
    unlockAt: timestamp('unlock_at', { withTimezone: true }).notNull(),
    withdrawn: boolean('withdrawn').notNull().default(false),
  },
  (t) => [index('gov_locks_user_idx').on(t.userId)],
)

/** A governance proposal. v1 is signaling — a passed proposal directs the
 *  operator; execution is manual (documented as such in the UI). */
export const govProposal = pgTable('gov_proposals', {
  id: text('id').primaryKey(),
  creatorUserId: text('creator_user_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
  /** 'open' | 'passed' | 'rejected' — finalized when closesAt passes. */
  status: text('status').notNull().default('open'),
  /** On-chain VeilPoll contract address, when the factory is configured. */
  onchainPollAddress: text('onchain_poll_address'),
})

/**
 * On-chain commit-reveal vote tracking (only when governance is on-chain).
 * A confident delegate vote is committed here from the agent's smart
 * account, then revealed after the proposal closes; the salt is stored
 * encrypted and discarded the moment the reveal lands. Separate from
 * gov_votes, which stays the authoritative ve-weighted tally.
 */
export const govOnchainVote = pgTable(
  'gov_onchain_votes',
  {
    proposalId: text('proposal_id').notNull(),
    userId: text('user_id').notNull(),
    agentId: text('agent_id').notNull(), // the smart account that voted
    pollAddress: text('poll_address').notNull(), // the VeilPoll contract
    optionIndex: integer('option_index').notNull(),
    encryptedSalt: text('encrypted_salt'), // AES-GCM; nulled after reveal
    commitTxHash: text('commit_tx_hash'),
    revealTxHash: text('reveal_tx_hash'),
    status: text('status').notNull().default('committed'), // 'committed' | 'revealed' | 'failed'
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.userId] })],
)

/** One immutable vote per (proposal, account), weighted by the caster's
 *  ve voting power snapshotted at cast time. */
export const govVote = pgTable(
  'gov_votes',
  {
    proposalId: text('proposal_id').notNull(),
    userId: text('user_id').notNull(),
    choice: text('choice').notNull(), // 'for' | 'against' | 'abstain'
    power: decimal('power', { precision: 24, scale: 6 }).notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    // Set when an AI delegate cast this vote on the owner's behalf: which
    // agent decided, its one-line rationale, and how confident it was
    // (0–1) — for transparency in the UI.
    viaAgentId: text('via_agent_id'),
    rationale: text('rationale'),
    confidence: decimal('confidence', { precision: 4, scale: 3 }),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.userId] })],
)

/**
 * Escalated delegate recommendations awaiting the owner's decision.
 *
 * Modeled on the algorithmica-agent-dashboard auto-voter: a delegate NEVER
 * silently casts a vote it isn't sure about, or one that could harm the
 * least-advantaged. When confidence < threshold, or the proposal carries
 * high minority-impact, the recommendation lands here (status 'pending')
 * instead of in gov_votes — a human must confirm or dismiss it. This is the
 * human-in-the-loop guardrail that makes trusting a delegate safe.
 */
export const govDelegateReview = pgTable(
  'gov_delegate_reviews',
  {
    proposalId: text('proposal_id').notNull(),
    userId: text('user_id').notNull(),
    viaAgentId: text('via_agent_id').notNull(),
    choice: text('choice').notNull(), // recommended: 'for' | 'against' | 'abstain'
    confidence: decimal('confidence', { precision: 4, scale: 3 }),
    rationale: text('rationale'),
    reason: text('reason'), // why it was escalated (low confidence / minority impact)
    status: text('status').notNull().default('pending'), // 'pending' | 'voted' | 'dismissed'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.userId] })],
)

/**
 * Durable auth-attempt log — one row per credential attempt, keyed by
 * (scope, ip). Backs a DB-level sliding-window throttle that survives
 * Vercel's serverless fan-out (the per-instance in-memory limiter in
 * lib/rate-limit.ts does not — a burst spread across cold lambdas each
 * see an empty Map). Rows are pruned opportunistically on write; this is
 * the hard backstop against credential stuffing on sign-in / register /
 * personal-token, above bcrypt's per-attempt cost.
 */
export const authAttempt = pgTable(
  'auth_attempts',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(), // 'signin' | 'register' | 'personal-token'
    ip: text('ip').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_attempts_scope_ip_at_idx').on(t.scope, t.ip, t.at)],
)

/**
 * sponsored_ops — one row per UserOperation the operator's paymaster paid for.
 *
 * Same shape as auth_attempts above and for the same reason: a per-instance
 * counter is not a counter at all across serverless fan-out. This one guards
 * money rather than a login — sponsored gas is the operator's wallet, spendable
 * by anyone who can cause an operation (lib/onchain/gas-policy.ts).
 *
 * Written BEFORE the operation is sent, never after. A row written afterwards
 * does not exist yet for the request that raced it, and refusing the second one
 * is the entire point. If the send then fails, an agent has been charged for an
 * operation that did not happen — which is the cheap direction to be wrong in,
 * and the opposite mistake spends real money.
 */
export const sponsoredOp = pgTable(
  'sponsored_ops',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sponsored_ops_agent_at_idx').on(t.agentId, t.at)],
)

// ---- OAuth 2.0 for MCP connectors (Claude / ChatGPT custom connectors) ----
// Public clients only (PKCE, no client secret): connectors register
// dynamically (RFC 7591), the user approves on /oauth/authorize, and the
// resulting bearer token authenticates JSON-RPC calls to /api/mcp.

export const oauthClient = pgTable('oauth_clients', {
  id: text('id').primaryKey(), // client_id, mcpc_<nanoid>
  name: text('name').notNull(),
  /** Exact-match allowlist checked on every authorize AND token exchange. */
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const oauthCode = pgTable('oauth_codes', {
  code: text('code').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: text('user_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(), // PKCE S256, mandatory
  scope: text('scope').notNull().default('mcp'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const oauthToken = pgTable('oauth_tokens', {
  token: text('token').primaryKey(), // lmk_<nanoid(40)>
  userId: text('user_id').notNull(),
  clientId: text('client_id').notNull(),
  scope: text('scope').notNull().default('mcp'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const insurancePolicy = pgTable('insurancePolicy', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  agentId: text('agentId').notNull(),
  policyType: text('policyType').notNull(),
  coverage: decimal('coverage', { precision: 18, scale: 2 }).notNull(),
  premium: decimal('premium', { precision: 18, scale: 2 }).notNull(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})
