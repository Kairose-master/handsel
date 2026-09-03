/**
 * The approval policy engine — "may this task be paid, and by whom?"
 *
 * Automatic approval is not a boolean. `autoApprove: true` says nothing
 * about a $40 task that rewrote the deploy config with failing tests, and a
 * flag that cannot tell that apart from a $1 typo fix is a flag that will be
 * left off. This module evaluates a WRITTEN policy against the evidence a
 * session collected and returns one of five outcomes:
 *
 *   ALLOW             pay without a person, nothing to surface
 *   ALLOW_WITH_LOG    pay without a person, show it in the inbox as done
 *   REQUIRE_OWNER     the owner decides; nothing moves until they do
 *   REQUIRE_REVIEWER  an independent reviewer must answer first
 *   DENY              refused; the task fails with the reason on record
 *
 * ## Two layers, and the order matters
 *
 * 1. **Hard rules** the policy cannot relax. A run that touched files
 *    outside its workspace, a payment over the budget, a task rated E4
 *    (money movement, deploys, deletion, production), a modified secret —
 *    these decide before any rule the owner wrote is read. An owner can
 *    write a stricter policy; nobody can write a looser one than these.
 * 2. **The owner's rules**, as data: `deny` (any matches → DENY),
 *    `requireOwner` (any → REQUIRE_OWNER), `requireReviewer` (any →
 *    REQUIRE_REVIEWER), `autoApprove` (ALL must hold → allow). A condition
 *    on evidence that is MISSING never holds — "unknown" is not "passed"
 *    (docs/failure-modes.md invariant 5), so a task with no test report
 *    cannot auto-approve under a policy that asks for passing tests.
 *
 * ## What a decision leaves behind
 *
 * Every decision is a receipt: policy id + version, the evidence the
 * engine read (verbatim, flattened), which rule matched, and why in one
 * sentence per reason. The session stores that on the ApprovalRecord and a
 * person overriding it does not erase it — the policy's verdict and the
 * person's verdict are both on the record. That is what makes "why was this
 * paid" answerable a month later.
 *
 * JSON is the canonical policy format (this repo's rule for every readable
 * layer); `renderPolicy` is a projection for the editor, never parsed back.
 *
 * Pure. Nothing here reads a database or a chain.
 */
import { STATUS_META, type ApprovalOutcome, type RiskTier, type SessionStatus, type TaskSettlement } from '@/lib/office-session'

export type { ApprovalOutcome, RiskTier }

export const RISK_TIERS: readonly RiskTier[] = ['E0', 'E1', 'E2', 'E3', 'E4']
export const riskRank = (t: RiskTier): number => RISK_TIERS.indexOf(t)

/**
 * The execution-risk ladder. Same letters as lib/evidence-assurance.ts's
 * evidence classes, deliberately NOT the same thing: an evidence class says
 * how much a claim may be trusted; a risk tier says how much damage an
 * action can do. Both are policy ladders, both cap what may happen without
 * a person, and they are consulted at different points (verify vs
 * authorize). Keep the names apart in prose: "evidence E3", "risk E3".
 */
export const RISK_TIER_MEANING: Record<RiskTier, string> = {
  E0: 'read and analyse — nothing on disk changes',
  E1: 'edit files inside the workspace',
  E2: 'run tests, builds and a bounded shell inside the workspace',
  E3: 'reach the network, install packages, open a pull request',
  E4: 'move money, deploy, delete, or change production',
}

/* ── Context: what the engine reads ───────────────────────────────────── */

export type ApprovalContext = {
  officeId: string
  sessionId: string
  taskId: string
  amountUsd: number
  riskTier: RiskTier
  changedFiles: string[]
  /** null = no deterministic test ran (not "failed", not "passed"). */
  testsPassed: boolean | null
  /** null = no CI is attached to this task. */
  ciPassed: boolean | null
  reviewerVerdict: 'APPROVE' | 'REVISE' | null
  /** null = the worker has no score yet (a real cold start). */
  workerCredit: number | null
  budgetRemainingUsd: number
  /** Spent under this policy in the current 24h window, before this task. */
  dailySpentUsd: number
  productionImpact: boolean
  secretModified: boolean
  newDependency: boolean
  reviewerDisagreement: boolean
  /** The run wrote outside the granted workdir. Always a hard deny. */
  workspaceEscape: boolean
  settlement: TaskSettlement
}

/** Fields a condition may name. `changedFileCount` is derived. */
export type ConditionField =
  | 'amountUsd'
  | 'riskTier'
  | 'changedFileCount'
  | 'testsPassed'
  | 'ciPassed'
  | 'reviewerVerdict'
  | 'workerCredit'
  | 'budgetRemainingUsd'
  | 'dailySpentUsd'
  | 'productionImpact'
  | 'secretModified'
  | 'newDependency'
  | 'reviewerDisagreement'
  | 'settlement'

export const CONDITION_FIELDS: readonly ConditionField[] = [
  'amountUsd',
  'riskTier',
  'changedFileCount',
  'testsPassed',
  'ciPassed',
  'reviewerVerdict',
  'workerCredit',
  'budgetRemainingUsd',
  'dailySpentUsd',
  'productionImpact',
  'secretModified',
  'newDependency',
  'reviewerDisagreement',
  'settlement',
]

export type ConditionOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in'
export const CONDITION_OPS: readonly ConditionOp[] = ['==', '!=', '<', '<=', '>', '>=', 'in']

export type Condition = { field: ConditionField; op: ConditionOp; value: string | number | boolean | null | Array<string | number> }

export type ApprovalPolicy = {
  id: string
  version: number
  dailyBudgetUsd: number
  singleTaskLimitUsd: number
  /** ALL must hold for an automatic allow. */
  autoApprove: Condition[]
  /** ANY holds → REQUIRE_OWNER. */
  requireOwner: Condition[]
  /** ANY holds → REQUIRE_REVIEWER (only while no reviewer has answered). */
  requireReviewer: Condition[]
  /** ANY holds → DENY. */
  deny: Condition[]
}

/** The policy in the product spec, as data. */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  id: 'default',
  version: 1,
  dailyBudgetUsd: 20,
  singleTaskLimitUsd: 3,
  autoApprove: [
    { field: 'testsPassed', op: '!=', value: false },
    { field: 'changedFileCount', op: '<=', value: 10 },
    { field: 'secretModified', op: '==', value: false },
    { field: 'productionImpact', op: '==', value: false },
    { field: 'reviewerVerdict', op: '==', value: 'APPROVE' },
    { field: 'amountUsd', op: '<=', value: 2 },
  ],
  requireOwner: [
    { field: 'amountUsd', op: '>', value: 2 },
    { field: 'productionImpact', op: '==', value: true },
    { field: 'newDependency', op: '==', value: true },
    { field: 'reviewerDisagreement', op: '==', value: true },
  ],
  requireReviewer: [{ field: 'reviewerVerdict', op: '==', value: null }],
  deny: [],
}

/* ── Evaluation ───────────────────────────────────────────────────────── */

export type MatchedRule = { rule: 'hard' | 'deny' | 'requireOwner' | 'requireReviewer' | 'autoApprove'; condition: Condition | string }

export type ApprovalDecision = {
  outcome: ApprovalOutcome
  policyId: string
  policyVersion: number
  /** The flattened evidence, exactly as the engine saw it. */
  evidence: Record<string, unknown>
  matched: MatchedRule[]
  reasons: string[]
  decidedAt: number
}

export function flattenContext(ctx: ApprovalContext): Record<string, unknown> {
  return {
    officeId: ctx.officeId,
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    amountUsd: ctx.amountUsd,
    riskTier: ctx.riskTier,
    changedFileCount: ctx.changedFiles.length,
    changedFiles: ctx.changedFiles.slice(0, 50),
    testsPassed: ctx.testsPassed,
    ciPassed: ctx.ciPassed,
    reviewerVerdict: ctx.reviewerVerdict,
    workerCredit: ctx.workerCredit,
    budgetRemainingUsd: ctx.budgetRemainingUsd,
    dailySpentUsd: ctx.dailySpentUsd,
    productionImpact: ctx.productionImpact,
    secretModified: ctx.secretModified,
    newDependency: ctx.newDependency,
    reviewerDisagreement: ctx.reviewerDisagreement,
    workspaceEscape: ctx.workspaceEscape,
    settlement: ctx.settlement,
  }
}

/**
 * Does one condition hold? A null/undefined field value never satisfies an
 * ordering or equality against a non-null value — the only condition a
 * missing reading can satisfy is `== null` (or `!= <something>`), which is
 * how a policy asks "has nobody reviewed this yet".
 */
export function conditionHolds(c: Condition, evidence: Record<string, unknown>): boolean {
  const v = evidence[c.field]
  if (c.field === 'riskTier') {
    const lhs = typeof v === 'string' && RISK_TIERS.includes(v as RiskTier) ? riskRank(v as RiskTier) : null
    const rhs = typeof c.value === 'string' && RISK_TIERS.includes(c.value as RiskTier) ? riskRank(c.value as RiskTier) : null
    if (c.op === 'in') return Array.isArray(c.value) && typeof v === 'string' && c.value.includes(v)
    if (lhs === null || rhs === null) return c.op === '!=' && lhs !== rhs
    return compare(lhs, rhs, c.op)
  }
  if (c.op === 'in') return Array.isArray(c.value) && (typeof v === 'string' || typeof v === 'number') && c.value.includes(v)
  if (v === null || v === undefined) {
    if (c.op === '==') return c.value === null
    if (c.op === '!=') return c.value !== null
    return false
  }
  if (c.op === '==') return v === c.value
  if (c.op === '!=') return v !== c.value
  if (typeof v === 'number' && typeof c.value === 'number') return compare(v, c.value, c.op)
  return false
}

function compare(a: number, b: number, op: ConditionOp): boolean {
  switch (op) {
    case '<':
      return a < b
    case '<=':
      return a <= b
    case '>':
      return a > b
    case '>=':
      return a >= b
    case '==':
      return a === b
    case '!=':
      return a !== b
    default:
      return false
  }
}

export function describeCondition(c: Condition): string {
  return `${c.field} ${c.op} ${Array.isArray(c.value) ? `[${c.value.join(', ')}]` : String(c.value)}`
}

/**
 * Evaluate. Hard rules first, then the owner's rules, then the automatic
 * path — the first layer that decides, decides.
 */
export function evaluateApproval(policy: ApprovalPolicy, ctx: ApprovalContext, now = Date.now()): ApprovalDecision {
  const evidence = flattenContext(ctx)
  const base = { policyId: policy.id, policyVersion: policy.version, evidence, decidedAt: now }
  const hard = (outcome: ApprovalOutcome, reason: string): ApprovalDecision => ({
    ...base,
    outcome,
    matched: [{ rule: 'hard', condition: reason }],
    reasons: [reason],
  })

  // Hard denials — no policy can make these payable.
  if (ctx.workspaceEscape) return hard('DENY', 'the run wrote outside its granted workspace')
  if (!Number.isFinite(ctx.amountUsd) || ctx.amountUsd < 0) return hard('DENY', 'amount is not a valid non-negative number')
  if (ctx.amountUsd > ctx.budgetRemainingUsd + 1e-9) {
    return hard('DENY', `$${ctx.amountUsd.toFixed(2)} exceeds the session's remaining budget of $${ctx.budgetRemainingUsd.toFixed(2)}`)
  }
  if (ctx.amountUsd > 0 && ctx.dailySpentUsd + ctx.amountUsd > policy.dailyBudgetUsd + 1e-9) {
    return hard('DENY', `$${(ctx.dailySpentUsd + ctx.amountUsd).toFixed(2)} would exceed the daily budget of $${policy.dailyBudgetUsd.toFixed(2)}`)
  }
  if (ctx.testsPassed === false) return hard('DENY', 'the deterministic tests failed')
  if (ctx.ciPassed === false) return hard('DENY', 'CI failed')

  // Hard escalations — a person, always.
  if (ctx.riskTier === 'E4') return hard('REQUIRE_OWNER', `risk tier E4 (${RISK_TIER_MEANING.E4}) is never automatic`)
  if (ctx.secretModified) return hard('REQUIRE_OWNER', 'a secret-bearing file was modified')
  if (ctx.productionImpact) return hard('REQUIRE_OWNER', 'production configuration is affected')
  if (ctx.amountUsd > policy.singleTaskLimitUsd + 1e-9) {
    return hard('REQUIRE_OWNER', `$${ctx.amountUsd.toFixed(2)} is over the single-task limit of $${policy.singleTaskLimitUsd.toFixed(2)}`)
  }

  const matchedIn = (rules: Condition[], rule: MatchedRule['rule']): MatchedRule[] =>
    rules.filter((c) => conditionHolds(c, evidence)).map((c) => ({ rule, condition: c }))

  const denied = matchedIn(policy.deny, 'deny')
  if (denied.length) return { ...base, outcome: 'DENY', matched: denied, reasons: denied.map((m) => `deny: ${describeCondition(m.condition as Condition)}`) }

  const owner = matchedIn(policy.requireOwner, 'requireOwner')
  if (owner.length) {
    return { ...base, outcome: 'REQUIRE_OWNER', matched: owner, reasons: owner.map((m) => `owner: ${describeCondition(m.condition as Condition)}`) }
  }

  if (ctx.reviewerVerdict === null) {
    const reviewer = matchedIn(policy.requireReviewer, 'requireReviewer')
    if (reviewer.length) {
      return {
        ...base,
        outcome: 'REQUIRE_REVIEWER',
        matched: reviewer,
        reasons: reviewer.map((m) => `reviewer: ${describeCondition(m.condition as Condition)}`),
      }
    }
  }

  const failing = policy.autoApprove.filter((c) => !conditionHolds(c, evidence))
  if (failing.length) {
    // A policy that cannot decide sends it to the owner. Never to DENY: an
    // unmet auto-approve condition is the absence of a green light, not a
    // red one.
    return {
      ...base,
      outcome: 'REQUIRE_OWNER',
      matched: failing.map((c) => ({ rule: 'autoApprove' as const, condition: c })),
      reasons: failing.map((c) => `not automatic: ${describeCondition(c)} does not hold (${evidenceWord(evidence[c.field])})`),
    }
  }

  const held = policy.autoApprove.map((c) => ({ rule: 'autoApprove' as const, condition: c }))
  const reasons = policy.autoApprove.map((c) => `holds: ${describeCondition(c)}`)
  // Nothing moved and nothing on disk changed beyond edits → plain ALLOW.
  // Anything that spends or ran a shell is allowed WITH a log line the
  // owner sees in the inbox as already done.
  const quiet = ctx.amountUsd === 0 && riskRank(ctx.riskTier) <= riskRank('E1')
  return { ...base, outcome: quiet ? 'ALLOW' : 'ALLOW_WITH_LOG', matched: held, reasons }
}

function evidenceWord(v: unknown): string {
  if (v === null || v === undefined) return 'no reading'
  return `is ${JSON.stringify(v)}`
}

/* ── Risk tier & file classification ──────────────────────────────────── */

const SECRET_FILE = /(^|\/)(\.env(\..+)?|.*\.pem|.*\.key|.*secret.*|.*credential.*|id_rsa.*|.*\.p12|.*\.pfx)$/i
const PRODUCTION_FILE =
  /(^|\/)(vercel\.json|Dockerfile|docker-compose.*\.ya?ml|\.github\/workflows\/.*|infra\/.*|terraform\/.*|.*\.tf|k8s\/.*|helm\/.*|deploy.*\.(sh|ya?ml|json)|fly\.toml|Procfile|.*\.prod(uction)?\.(json|ya?ml|env|ts|js))$/i
const DEPENDENCY_FILE = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|requirements.*\.txt|pyproject\.toml|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock))$/i

export function isSecretPath(p: string): boolean {
  return SECRET_FILE.test(p)
}
export function isProductionPath(p: string): boolean {
  return PRODUCTION_FILE.test(p)
}
export function isDependencyPath(p: string): boolean {
  return DEPENDENCY_FILE.test(p)
}

export type RiskSignals = {
  changedFiles: string[]
  shellUsed: boolean
  networkUsed: boolean
  installed: boolean
  gitPushed: boolean
  moneyMoves: boolean
  deployed: boolean
  deletedFiles: string[]
}

/** The strongest thing the run did, on the ladder. */
export function riskTierFor(s: RiskSignals): RiskTier {
  const production = s.changedFiles.some(isProductionPath)
  if (s.moneyMoves || s.deployed || production) return 'E4'
  if (s.deletedFiles.length > 0 && s.deletedFiles.some((f) => !f.includes('/') || isProductionPath(f) || isSecretPath(f))) return 'E4'
  if (s.networkUsed || s.installed || s.gitPushed || s.changedFiles.some(isDependencyPath)) return 'E3'
  if (s.shellUsed) return 'E2'
  if (s.changedFiles.length > 0 || s.deletedFiles.length > 0) return 'E1'
  return 'E0'
}

/** What a workspace grant permits at most — the ceiling a run under it can reach. */
export function grantCeiling(grant: { write: boolean; shell: boolean; network: boolean; install: boolean; gitPush: boolean; externalPayments: boolean }): RiskTier {
  if (grant.externalPayments) return 'E4'
  if (grant.network || grant.install || grant.gitPush) return 'E3'
  if (grant.shell) return 'E2'
  if (grant.write) return 'E1'
  return 'E0'
}

/** Build the context's file-derived flags from the changed list. */
export function fileFlags(changedFiles: string[]): { secretModified: boolean; productionImpact: boolean; newDependency: boolean } {
  return {
    secretModified: changedFiles.some(isSecretPath),
    productionImpact: changedFiles.some(isProductionPath),
    newDependency: changedFiles.some(isDependencyPath),
  }
}

/* ── The money gate ───────────────────────────────────────────────────── */

export type MoneyGateInput = {
  sessionStatus: SessionStatus
  outcome: ApprovalOutcome
  decidedBy: 'policy' | 'owner' | 'reviewer'
  settlement: TaskSettlement
  realMoney: boolean
  /** OFFICE_SESSION_ALLOW_REAL_MONEY */
  allowRealMoneyFlag: string | undefined
}

export type MoneyGate = { allowed: boolean; why: string }

/**
 * The last check before an escrow release is asked for. Every "no" here is
 * a sentence the inbox can show; every "yes" has passed the status table,
 * the decision, and the deployment guard.
 *
 * An internal task never moves money and is allowed through for the record
 * only. On a real-money deployment a POLICY decision cannot release without
 * `OFFICE_SESSION_ALLOW_REAL_MONEY=true` — the same shape as
 * LINEAGE_MANDATE_ALLOW_REAL_MONEY and REVIEW_STAKE_ALLOW_REAL_MONEY. An
 * owner's own click is their decision and is not gated by the flag.
 */
export function moneyGate(i: MoneyGateInput): MoneyGate {
  if (i.settlement === 'internal') return { allowed: true, why: 'internal task — no escrow, nothing moves' }
  if (i.outcome !== 'ALLOW' && i.outcome !== 'ALLOW_WITH_LOG') {
    if (i.decidedBy === 'policy') return { allowed: false, why: `policy outcome ${i.outcome} does not authorize a payment` }
  }
  if (!STATUS_META[i.sessionStatus].moneyMayMove) return { allowed: false, why: `session is ${i.sessionStatus}; money may not move here` }
  if (i.realMoney && i.decidedBy === 'policy' && i.allowRealMoneyFlag !== 'true') {
    return { allowed: false, why: 'real-money deployment: automatic release needs OFFICE_SESSION_ALLOW_REAL_MONEY=true; an owner can still approve by hand' }
  }
  return { allowed: true, why: `${i.decidedBy} authorized under ${i.outcome}` }
}

/* ── Serialisation ────────────────────────────────────────────────────── */

export type PolicyParse = { ok: true; policy: ApprovalPolicy } | { ok: false; error: string }

function parseConditions(raw: unknown, where: string): Condition[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return `${where} must be a list`
  const out: Condition[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return `${where}: each condition is an object`
    const c = item as Record<string, unknown>
    if (!CONDITION_FIELDS.includes(c.field as ConditionField)) return `${where}: unknown field ${String(c.field)}`
    if (!CONDITION_OPS.includes(c.op as ConditionOp)) return `${where}: unknown operator ${String(c.op)}`
    const v = c.value
    const scalar = v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    const list = Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')
    if (!scalar && !list) return `${where}: value must be a string, number, boolean, null or a list`
    if (c.op === 'in' && !list) return `${where}: 'in' needs a list`
    out.push({ field: c.field as ConditionField, op: c.op as ConditionOp, value: v as Condition['value'] })
  }
  return out
}

/** Strict: unknown keys, bad shapes and negative limits are refused with a sentence. */
export function parsePolicy(raw: unknown): PolicyParse {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'policy must be a JSON object' }
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(r.id) ? r.id : null
  if (!id) return { ok: false, error: 'id must be 1–40 letters, digits, - or _' }
  const version = typeof r.version === 'number' && Number.isInteger(r.version) && r.version >= 1 ? r.version : null
  if (version === null) return { ok: false, error: 'version must be a positive integer' }
  const daily = typeof r.dailyBudgetUsd === 'number' && Number.isFinite(r.dailyBudgetUsd) && r.dailyBudgetUsd >= 0 ? r.dailyBudgetUsd : null
  if (daily === null) return { ok: false, error: 'dailyBudgetUsd must be a non-negative number' }
  const single = typeof r.singleTaskLimitUsd === 'number' && Number.isFinite(r.singleTaskLimitUsd) && r.singleTaskLimitUsd >= 0 ? r.singleTaskLimitUsd : null
  if (single === null) return { ok: false, error: 'singleTaskLimitUsd must be a non-negative number' }
  if (single > daily) return { ok: false, error: 'singleTaskLimitUsd cannot exceed dailyBudgetUsd' }
  const known = new Set(['id', 'version', 'dailyBudgetUsd', 'singleTaskLimitUsd', 'autoApprove', 'requireOwner', 'requireReviewer', 'deny'])
  for (const k of Object.keys(r)) if (!known.has(k)) return { ok: false, error: `unknown key ${k}` }
  const lists = {
    autoApprove: parseConditions(r.autoApprove, 'autoApprove'),
    requireOwner: parseConditions(r.requireOwner, 'requireOwner'),
    requireReviewer: parseConditions(r.requireReviewer, 'requireReviewer'),
    deny: parseConditions(r.deny, 'deny'),
  }
  for (const v of Object.values(lists)) if (typeof v === 'string') return { ok: false, error: v }
  return {
    ok: true,
    policy: {
      id,
      version,
      dailyBudgetUsd: daily,
      singleTaskLimitUsd: single,
      autoApprove: lists.autoApprove as Condition[],
      requireOwner: lists.requireOwner as Condition[],
      requireReviewer: lists.requireReviewer as Condition[],
      deny: lists.deny as Condition[],
    },
  }
}

/** The editor's projection. Readable; never parsed back. */
export function renderPolicy(p: ApprovalPolicy): string {
  const block = (name: string, rules: Condition[]) =>
    rules.length ? `${name}:\n${rules.map((c) => `  - ${describeCondition(c)}`).join('\n')}` : `${name}: []`
  return [
    `policy: ${p.id} (v${p.version})`,
    `daily_budget_usd: ${p.dailyBudgetUsd}`,
    `single_task_limit_usd: ${p.singleTaskLimitUsd}`,
    block('auto_approve (all must hold)', p.autoApprove),
    block('require_owner (any)', p.requireOwner),
    block('require_reviewer (any, while unreviewed)', p.requireReviewer),
    block('deny (any)', p.deny),
    '',
    'hard rules the policy cannot relax:',
    '  - writes outside the workspace → DENY',
    '  - over the remaining or daily budget → DENY',
    '  - failed tests or CI → DENY',
    '  - risk E4, a modified secret, production impact, or over the single-task limit → owner',
  ].join('\n')
}

/** One paragraph a person can read on the inbox card. */
export function receiptText(d: ApprovalDecision): string {
  const head = `${d.outcome} under policy ${d.policyId} v${d.policyVersion}`
  return `${head}\n${d.reasons.map((r) => `- ${r}`).join('\n')}`
}
