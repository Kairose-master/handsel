/**
 * A local paymaster: the account's own gas pool.
 *
 * A real ERC-4337 paymaster sponsors gas at the protocol level and needs a
 * deposit in the EntryPoint plus a signing service. This deployment has
 * neither, so every kernel account self-pays — and `ensureAgentGas`, the one
 * thing in this codebase that refills an empty agent, only runs in EOA mode
 * and spends the OPERATOR's ether. In kernel mode nothing refills anything:
 * an agent that runs out stops, permanently, until a human notices and sends
 * it ETH by hand.
 *
 * That is a smaller problem than it looks, because it does not need the
 * protocol. Every agent on an account belongs to one owner, and that owner can
 * hold ETH in one of their own agents. Sponsorship then is just a transfer
 * between two wallets the same person controls, sized to what the chain is
 * about to charge — which is exactly the shape lib/office-bond-cover.ts
 * already established for USDC bonds.
 *
 * So this is not "a paymaster we could not build". It is the part of one that
 * is actually load-bearing here: an agent that would have stopped keeps
 * working, out of a pool its owner filled on purpose.
 *
 * What makes it safe is that it is bounded in four independent ways, and the
 * bounds matter more than the mechanism:
 *
 *  1. **Opt-in and named.** Nothing is sponsored until the owner designates a
 *     source agent. No pool, no sponsorship — never "helpfully" drained from
 *     whichever wallet happened to have money.
 *  2. **A per-window budget.** Gas is needed for EVERY write, including work
 *     an agent claims from strangers, so unlike bond cover this cannot be
 *     gated on the job. The budget is the guard: an account can spend at most
 *     LOCAL_GAS_WINDOW_BUDGET_WEI a day on sponsorship, and a runaway
 *     auto-miner burns that and stops, not the wallet.
 *  3. **A reserve in the source.** The transfer is itself a UserOperation paid
 *     out of the pool's own balance; a pool drained to zero cannot fund
 *     anything, including its own rescue.
 *  4. **Recorded before it is sent.** Same discipline as every other spend
 *     here: a top-up that lands and is not recorded is one the budget hands
 *     out again.
 */
import { pool as pgPool } from '@/lib/db'
import { AGENT_GAS_FLOOR } from '@/lib/onchain/account'

/** What a sponsored agent is topped up TO. Matches AGENT_GAS_TOPUP and
 *  ETH_FUNDING_TARGET_WEI — one working session's worth. Topping up to the
 *  FLOOR would leave the agent one call from stopping, which is the state
 *  being sponsored out of. */
export const LOCAL_GAS_TARGET_WEI = 200_000_000_000_000n // 0.0002 ETH

/** Ceiling on a single top-up, so a misread balance cannot move a large
 *  amount in one call. */
export const LOCAL_GAS_MAX_TOPUP_WEI = 1_000_000_000_000_000n // 0.001 ETH

/** Left in the pool agent so it can still send. Same reasoning, and the same
 *  number, as the funding/withdrawal reserve. */
export const LOCAL_GAS_POOL_RESERVE_WEI = 200_000_000_000_000n // 0.0002 ETH

export const LOCAL_GAS_WINDOW_MS = 24 * 60 * 60 * 1000

/** Most an account may sponsor in one window. Env-overridable, but bounded
 *  here rather than trusted: an unparseable or absurd env var must not become
 *  an unbounded spend of someone's ether. */
export const LOCAL_GAS_WINDOW_BUDGET_WEI = (() => {
  const raw = process.env.LOCAL_GAS_WINDOW_BUDGET_ETH
  const parsed = raw !== undefined && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  const eth = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 0.1) : 0.005
  return BigInt(Math.round(eth * 1e18))
})()

let tableReady: Promise<void> | null = null
function ensureTables(): Promise<void> {
  tableReady ??= (async () => {
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS account_gas_pool (
         user_id text PRIMARY KEY,
         source_agent_id text NOT NULL,
         enabled boolean NOT NULL DEFAULT true,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS account_gas_sponsorship (
         id bigserial PRIMARY KEY,
         user_id text NOT NULL,
         agent_id text NOT NULL,
         wei numeric NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pgPool.query(
      `CREATE INDEX IF NOT EXISTS account_gas_sponsorship_window
         ON account_gas_sponsorship (user_id, created_at)`,
    )
  })()
  return tableReady
}

export type GasPool = { sourceAgentId: string; enabled: boolean } | null

export async function getGasPool(userId: string): Promise<GasPool> {
  await ensureTables()
  const { rows } = await pgPool.query<{ source_agent_id: string; enabled: boolean }>(
    `SELECT source_agent_id, enabled FROM account_gas_pool WHERE user_id = $1`,
    [userId],
  )
  const row = rows[0]
  return row ? { sourceAgentId: row.source_agent_id, enabled: row.enabled } : null
}

/** Designate (or disable) the agent this account sponsors gas out of.
 *  Ownership of `sourceAgentId` is the caller's to establish. */
export async function setGasPool(userId: string, sourceAgentId: string, enabled = true): Promise<void> {
  await ensureTables()
  await pgPool.query(
    `INSERT INTO account_gas_pool (user_id, source_agent_id, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET source_agent_id = $2, enabled = $3, updated_at = now()`,
    [userId, sourceAgentId, enabled],
  )
}

export async function disableGasPool(userId: string): Promise<void> {
  await ensureTables()
  await pgPool.query(`UPDATE account_gas_pool SET enabled = false, updated_at = now() WHERE user_id = $1`, [userId])
}

/** Wei this account has sponsored inside the current window. */
export async function sponsoredInWindow(userId: string): Promise<bigint> {
  await ensureTables()
  const { rows } = await pgPool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(wei), 0)::text AS total FROM account_gas_sponsorship
      WHERE user_id = $1 AND created_at > now() - make_interval(secs => $2)`,
    [userId, Math.round(LOCAL_GAS_WINDOW_MS / 1000)],
  )
  try {
    return BigInt(rows[0]?.total ?? '0')
  } catch {
    return 0n
  }
}

export type SponsorPlan =
  | { sponsor: true; amountWei: bigint }
  | { sponsor: false; why: 'already-funded' | 'over-window-budget' | 'pool-too-low' | 'nothing-worth-sending' }

/**
 * Decide a single top-up. Pure, so the arithmetic that spends someone's ether
 * is testable without a chain or a database.
 */
export function planSponsorship(input: {
  heldWei: bigint
  poolHeldWei: bigint
  spentInWindowWei: bigint
  budgetWei?: bigint
}): SponsorPlan {
  if (input.heldWei >= AGENT_GAS_FLOOR) return { sponsor: false, why: 'already-funded' }

  const budget = input.budgetWei ?? LOCAL_GAS_WINDOW_BUDGET_WEI
  const remainingBudget = budget > input.spentInWindowWei ? budget - input.spentInWindowWei : 0n
  if (remainingBudget <= 0n) return { sponsor: false, why: 'over-window-budget' }

  const poolSpendable =
    input.poolHeldWei > LOCAL_GAS_POOL_RESERVE_WEI ? input.poolHeldWei - LOCAL_GAS_POOL_RESERVE_WEI : 0n
  if (poolSpendable <= 0n) return { sponsor: false, why: 'pool-too-low' }

  // Every ceiling applies at once, and the smallest wins. Clamping rather than
  // refusing when one of them binds: a partial top-up that clears the floor is
  // still an agent that can work, and refusing outright would make a nearly
  // exhausted budget behave like no budget at all.
  let amount = LOCAL_GAS_TARGET_WEI - input.heldWei
  for (const cap of [LOCAL_GAS_MAX_TOPUP_WEI, remainingBudget, poolSpendable]) {
    if (cap < amount) amount = cap
  }
  // Below the floor the transfer buys nothing — the agent still cannot act,
  // and the gas spent sending it is wasted twice.
  if (amount < AGENT_GAS_FLOOR) return { sponsor: false, why: 'nothing-worth-sending' }
  return { sponsor: true, amountWei: amount }
}

/**
 * Agents currently being sponsored, and the pool while it is sending.
 *
 * The top-up is a transfer FROM the pool agent, which goes through the very
 * send path that asks for sponsorship — so without this a single empty agent
 * would recurse until the stack gave out. Per-instance, which is the right
 * scope: it guards a call chain, not a resource.
 */
const inFlight = new Set<string>()

/** Why nothing was sponsored. Every refusal is named rather than collapsed to
 *  a boolean: "the budget is spent" and "this account has no pool" are the
 *  same non-event to the caller and completely different to the owner. */
export type SponsorRefusal =
  | 'already-funded'
  | 'over-window-budget'
  | 'pool-too-low'
  | 'nothing-worth-sending'
  | 'no-pool'
  | 'is-pool'
  | 'reentrant'
  | 'unreadable'
  | 'failed'

export type SponsorOutcome =
  | { sponsored: true; amountWei: bigint; from: string; txHash: string }
  | { sponsored: false; why: SponsorRefusal }

/**
 * Top `agentId` up out of its owner's pool, if there is one and it can afford
 * it.
 *
 * Never throws and never blocks the caller: sponsorship failing must leave the
 * send exactly as it was — the chain refuses what it should, and the reason is
 * a log line rather than an exception in an unrelated code path.
 */
export async function sponsorAgentGas(agentId: string): Promise<SponsorOutcome> {
  if (inFlight.has(agentId)) return { sponsored: false, why: 'reentrant' }
  try {
    const { db } = await import('@/lib/db')
    const { agent } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')

    const [me] = await db
      .select({ id: agent.id, name: agent.name, userId: agent.userId, smartAccountAddress: agent.smartAccountAddress })
      .from(agent)
      .where(eq(agent.id, agentId))
    if (!me?.smartAccountAddress) return { sponsored: false, why: 'unreadable' }

    const poolRow = await getGasPool(me.userId)
    if (!poolRow || !poolRow.enabled) return { sponsored: false, why: 'no-pool' }
    // A pool cannot fund itself, and the guard below would not catch it: the
    // pool's own send is the thing that would ask.
    if (poolRow.sourceAgentId === agentId) return { sponsored: false, why: 'is-pool' }
    if (inFlight.has(poolRow.sourceAgentId)) return { sponsored: false, why: 'reentrant' }

    const [source] = await db
      .select({ id: agent.id, name: agent.name, userId: agent.userId, smartAccountAddress: agent.smartAccountAddress })
      .from(agent)
      .where(eq(agent.id, poolRow.sourceAgentId))
    // The pool must still belong to this owner. A designation outlives the
    // agent it names, and an agent can change hands.
    if (!source?.smartAccountAddress || source.userId !== me.userId) return { sponsored: false, why: 'no-pool' }

    const { ethBalanceOfWei } = await import('@/lib/onchain/treasury')
    const [heldWei, poolHeldWei, spent] = await Promise.all([
      ethBalanceOfWei(me.smartAccountAddress as `0x${string}`),
      ethBalanceOfWei(source.smartAccountAddress as `0x${string}`),
      sponsoredInWindow(me.userId),
    ])

    const plan = planSponsorship({ heldWei, poolHeldWei, spentInWindowWei: spent })
    if (!plan.sponsor) return { sponsored: false, why: plan.why }

    // Recorded BEFORE the send, like every other spend in this codebase: a
    // top-up that lands and is not recorded is one the budget hands out again.
    await ensureTables()
    await pgPool.query(
      `INSERT INTO account_gas_sponsorship (user_id, agent_id, wei) VALUES ($1, $2, $3)`,
      [me.userId, agentId, plan.amountWei.toString()],
    )

    inFlight.add(agentId)
    inFlight.add(poolRow.sourceAgentId)
    try {
      const { transferEth } = await import('@/lib/onchain/treasury')
      const txHash = await transferEth(source.id, me.smartAccountAddress as `0x${string}`, plan.amountWei)
      console.info(
        `[local-paymaster] sponsored ${me.name} ${plan.amountWei} wei from ${source.name} (tx ${txHash})`,
      )
      return { sponsored: true, amountWei: plan.amountWei, from: source.name, txHash }
    } finally {
      inFlight.delete(agentId)
      inFlight.delete(poolRow.sourceAgentId)
    }
  } catch (error) {
    console.warn(`[local-paymaster] sponsorship of ${agentId} failed:`, error)
    return { sponsored: false, why: 'failed' }
  }
}
