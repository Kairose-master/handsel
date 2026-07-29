/**
 * The fuse — and, more importantly, the reserve behind it.
 *
 * Sponsored gas is the one pool an attacker can drain without paying anything.
 * The contract cannot lose money nobody put in it, and escrow is bounded by what
 * people post; the paymaster is bounded by nothing until something bounds it.
 * `flatFee`/`flatBond` make each individual action cost the actor something,
 * which is the structural answer. This is what happens when the structure is
 * wrong anyway.
 *
 * ## Degrade, do not stop
 *
 * A budget that simply refuses when exhausted converts a gas attack into a
 * denial of service — the attacker spends the operator's money and, as a bonus,
 * takes the market offline for everyone. So exhaustion falls through to
 * SELF_PAY: the action still happens, the agent's own account pays for it. On
 * Base that is a fraction of a cent, so the honest user's experience degrades
 * from "free" to "nearly free" rather than from "working" to "broken".
 *
 * ## Two lanes, and this is the part that matters
 *
 * A single global budget means an attacker who drains it also disables
 * `expireReview`, `expireDispute`, `reclaimJob` and `expireOpen` — the
 * permissionless exits that free OTHER people's escrow. That turns a gas attack
 * into a way to freeze the market's money, which is strictly worse than the gas
 * itself and is exactly the class of failure the whole v2 rewrite exists to
 * close.
 *
 * So keeper traffic draws on a reserve that user traffic cannot touch. It is the
 * same rule the dispute design follows: the policy layer is allowed to be
 * broken, the backstop is not. The reserve is small and stays small because the
 * sweeps are already capped at MAX_EXITS_PER_PASS and MAX_RULINGS_PER_PASS.
 */

/** Which pool a call draws from. */
export type Lane = 'user' | 'keeper'

export type SponsorDecision = 'sponsor' | 'self_pay' | 'refuse'

/**
 * Per-agent ceiling before an agent starts paying its own gas.
 *
 * Deliberately per-AGENT and not per-user: an attacker's cheapest move is many
 * agents, and a per-user cap only bites once they are all traced to one user,
 * which is precisely what a Sybil is arranging not to happen. The per-agent cap
 * is the one that bounds the blast radius of an identity that is free to create.
 */
export const AGENT_GAS_BUDGET_USD = envNum('AGENT_GAS_BUDGET_USD', 0.5)

/** Everything user-initiated, across all agents, per rolling day. */
export const USER_LANE_BUDGET_USD = envNum('USER_LANE_GAS_BUDGET_USD', 5)

/**
 * The reserve. Small on purpose, and never shared with the user lane.
 *
 * The sweeps make at most MAX_EXITS_PER_PASS + MAX_RULINGS_PER_PASS = 6 calls
 * per pass, so a day of keeper traffic is bounded by the ops cadence rather than
 * by how many jobs exist. If this is ever exhausted, something is wrong that a
 * bigger number will not fix — see `keeperStarved`.
 */
export const KEEPER_LANE_BUDGET_USD = envNum('KEEPER_LANE_GAS_BUDGET_USD', 2)

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  // An empty or garbage env var once became a $0/day cap in production and
  // blocked every withdrawal from the first attempt. Zero is never a sane
  // budget; fall back rather than enforce a value nobody meant.
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export type SponsorInput = {
  lane: Lane
  /** Sponsored USD this agent has already consumed in the window. */
  agentSpentUsd: number
  /** Sponsored USD this LANE has consumed in the window, all agents. */
  laneSpentUsd: number
  /** Whether the caller has a funded account that could pay instead. */
  canSelfPay: boolean
  agentBudgetUsd?: number
  laneBudgetUsd?: number
}

export type SponsorVerdict = { decision: SponsorDecision; reason: string }

/**
 * Whether to sponsor this call, make the caller pay, or refuse it.
 *
 * Pure, because every interesting case is a threshold and thresholds are where
 * off-by-ones live. Nothing here reads a clock, a database, or an env var at
 * call time — the budgets come in as arguments so a test can sit exactly on one.
 */
export function decideSponsorship(input: SponsorInput): SponsorVerdict {
  const laneBudget =
    input.laneBudgetUsd ?? (input.lane === 'keeper' ? KEEPER_LANE_BUDGET_USD : USER_LANE_BUDGET_USD)

  if (input.lane === 'keeper') {
    // The reserve is not shared and does not degrade to self-pay: there is no
    // "caller" to bill. A keeper call is the operator freeing somebody else's
    // escrow, so the only honest options are do it or admit it is not being
    // done. Exhaustion here is an alarm, not a routine state.
    if (input.laneSpentUsd >= laneBudget) {
      return { decision: 'refuse', reason: 'keeper reserve exhausted — settlement sweeps are not running' }
    }
    return { decision: 'sponsor', reason: 'keeper reserve' }
  }

  const agentBudget = input.agentBudgetUsd ?? AGENT_GAS_BUDGET_USD
  const overAgent = input.agentSpentUsd >= agentBudget
  const overLane = input.laneSpentUsd >= laneBudget
  if (!overAgent && !overLane) return { decision: 'sponsor', reason: 'within budget' }

  const which = overAgent && overLane ? 'agent and lane' : overAgent ? 'agent' : 'user lane'
  // Falling through to self-pay rather than refusing is the whole design. A
  // budget that refuses turns a gas attack into a denial of service: the
  // attacker spends the operator's money AND takes the market down.
  return input.canSelfPay
    ? { decision: 'self_pay', reason: `${which} gas budget spent — caller pays its own gas` }
    : { decision: 'refuse', reason: `${which} gas budget spent and the caller cannot pay its own gas` }
}

/**
 * Is the reserve in trouble?
 *
 * Separate from the decision because it answers a different question: not "may
 * this call proceed" but "should a human look". The sweeps are capped per pass,
 * so sustained keeper burn means either the ops cycle is running far more often
 * than intended or something is retrying without bound.
 */
export function keeperStarved(laneSpentUsd: number, budgetUsd = KEEPER_LANE_BUDGET_USD): boolean {
  return laneSpentUsd >= budgetUsd * 0.8
}

// ---------------------------------------------------------------------------
// The ledger the budget reads
// ---------------------------------------------------------------------------

/**
 * Estimated USD per sponsored UserOp.
 *
 * ESTIMATED, and the estimate is the point: the true cost is known only after
 * the bundler settles, and a budget that waits for certainty is a budget that
 * has already been overspent. Deliberately generous — over-estimating spends the
 * allowance faster and degrades to self-pay sooner, which is the safe direction.
 * Replace with the measured figure from deployment #1.
 */
export const USER_OP_COST_USD = envNum('USER_OP_COST_USD', 0.01)

/** The rolling window every budget is measured over. */
export const GAS_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Create the ledger if it is not there.
 *
 * **The comment below used to claim this table self-migrated, and it did not.**
 * `gas_spend` was declared in schema.ts, absent from scripts/migrate.mjs, and
 * absent from the eight tables that genuinely do create themselves at runtime
 * (ops_leases, work_proofs, platform_secrets, settlement_queue, …). On any real
 * deployment every read threw `relation does not exist`, the catch below
 * reported zero spend, and the answer was always SPONSOR.
 *
 * A fuse that cannot read its own ledger is not a conservative fuse, it is a
 * decoration — and the failure is SILENT, because failing toward sponsoring is
 * exactly what an empty ledger legitimately looks like. The ZeroDev cap
 * underneath was doing all of the work the whole time.
 *
 * Same shape as ops-lease.ts: memoized per process, IF NOT EXISTS, has to
 * succeed only once ever. It is also in scripts/migrate.mjs now, so a fresh
 * database has it before the first request rather than after it.
 */
let ledgerReady: Promise<void> | null = null
function ensureLedger(): Promise<void> {
  ledgerReady ??= (async () => {
    const { pool } = await import('@/lib/db')
    await pool.query(
      `CREATE TABLE IF NOT EXISTS gas_spend (
         id         text PRIMARY KEY,
         lane       text NOT NULL,
         agent_id   text,
         usd        numeric(12,6) NOT NULL,
         label      text,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    // Every sponsored call filters on exactly this pair.
    await pool.query('CREATE INDEX IF NOT EXISTS gas_spend_lane_created_idx ON gas_spend (lane, created_at)')
  })().catch((error) => {
    // Clear the memo so the next call retries, rather than caching one failure
    // for the life of the process — which would reproduce the original bug.
    ledgerReady = null
    throw error
  })
  return ledgerReady
}

/** What has been spent, per lane and per agent, inside the window. */
export async function gasSpentInWindow(
  lane: Lane,
  agentId?: string,
): Promise<{ lane: number; agent: number }> {
  try {
    await ensureLedger()
    const { db } = await import('@/lib/db')
    const { gasSpend } = await import('@/lib/db/schema')
    const { and, eq, gte } = await import('drizzle-orm')
    const since = new Date(Date.now() - GAS_WINDOW_MS)
    const rows = await db
      .select({ agentId: gasSpend.agentId, usd: gasSpend.usd })
      .from(gasSpend)
      .where(and(eq(gasSpend.lane, lane), gte(gasSpend.createdAt, since)))
    let laneTotal = 0
    let agentTotal = 0
    for (const r of rows) {
      const usd = Number(r.usd) || 0
      laneTotal += usd
      if (agentId && r.agentId === agentId) agentTotal += usd
    }
    return { lane: laneTotal, agent: agentTotal }
  } catch (error) {
    // Fail toward SPONSORING rather than toward refusing: failing the other way
    // would take the market down over a migration, and the ZeroDev cap is still
    // underneath as the backstop.
    //
    // But notice what this direction costs, because it cost exactly this: an
    // unreadable ledger and an empty one produce the SAME answer, so the fuse
    // being entirely disconnected looked identical to a quiet day. That is why
    // `ensureLedger` above exists rather than a comment asserting the table
    // shows up on its own. Loud, because there is no longer an expected reason
    // to be here.
    console.error('[gas-budget] LEDGER UNREADABLE — sponsoring without a limit:', error)
    return { lane: 0, agent: 0 }
  }
}

/** Record what a sponsored call is expected to cost. Never throws: a ledger
 *  write that fails must not undo an on-chain action that already happened. */
export async function recordGasSpend(lane: Lane, agentId: string | null, label: string): Promise<void> {
  try {
    await ensureLedger()
    const { db } = await import('@/lib/db')
    const { gasSpend } = await import('@/lib/db/schema')
    const { nanoid } = await import('nanoid')
    await db.insert(gasSpend).values({
      id: `gs-${nanoid()}`,
      lane,
      agentId,
      usd: String(USER_OP_COST_USD),
      label,
    })
  } catch (error) {
    console.error('[gas-budget] spend not recorded:', error)
  }
}
