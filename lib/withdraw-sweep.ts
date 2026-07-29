/**
 * The thing that collects what settlement credited.
 *
 * **V2 settlement CREDITS; it does not transfer.** Every payout is a number in
 * `withdrawable(address)` until someone calls `withdraw()`, and that is
 * deliberate — pushing meant one blocklisted recipient could revert a whole
 * settlement, which is residual risk R1 reintroduced through the token. The
 * price of that design is a second transaction, and a second transaction nobody
 * makes is money that never arrives.
 *
 * `lib/onchain/labor-v2.ts` has exposed `withdraw()` since the day the V2 surface
 * was written and NOTHING has ever called it. That is the same shape as the four
 * permissionless exits before `lib/deadline-sweep.ts`: a mechanism that exists,
 * is correct, and is not wired to anything. A worker on that deployment would
 * finish jobs, watch the dashboard say it earned, and hold no tokens.
 *
 * ## Why this is its own ops step, and why it is not the deadline sweep
 *
 * Different failure meanings. A deadline that goes uncalled leaves somebody
 * else's escrow frozen; a withdrawal that goes uncalled leaves only the
 * creditor's own money waiting, and it waits safely — `withdrawable` is a
 * balance, not a deadline, and nothing expires it. So this one is allowed to be
 * best-effort in a way the backstop is not, and it must not be able to consume
 * the lease or the pass budget that the backstop depends on.
 *
 * The direction of the rule, again: the policy layer may break, the backstop may
 * not.
 */
import { acquireOpsLease, releaseOpsLease } from '@/lib/ops-lease'

const LEASE_MS = 4 * 60_000

/**
 * At most this many withdrawals per pass.
 *
 * Bounded for the same reason the exits are: a sweep whose cost scales with the
 * size of the market is a sweep that eventually times out and then never
 * completes at all. Withdrawals are also the LEAST urgent on-chain call this
 * system makes — the money is safe where it is — so this is deliberately smaller
 * than MAX_EXITS_PER_PASS.
 */
export const MAX_WITHDRAWALS_PER_PASS = 2

/**
 * Don't spend a UserOp to collect dust.
 *
 * A sponsored withdrawal costs the operator roughly USER_OP_COST_USD whatever it
 * moves, so collecting a fraction of a cent burns more than it delivers — and it
 * does it on the operator's budget, repeatedly, since the balance never grows
 * past the threshold on its own. Below this the balance simply waits for the
 * next job to top it up, which is what a pull payment is for.
 */
export const MIN_WITHDRAW_USD = 0.05

export type Withdrawable = { agentId: string; address: string; amountUsd: number }

/**
 * Which balances are worth collecting, largest first.
 *
 * Pure, and separated from the chain for the same reason `dueDeadlines` is: the
 * interesting cases are a threshold and an ordering, and both are testable only
 * if nothing here reads a clock or a contract.
 *
 * Largest first rather than oldest first — unlike a deadline, a withdrawal has
 * no clock to be late against, so the ordering that matters is the one that
 * moves the most money per sponsored UserOp.
 */
export function dueWithdrawals(balances: Withdrawable[], minUsd = MIN_WITHDRAW_USD): Withdrawable[] {
  return balances
    .filter((b) => b.amountUsd >= minUsd)
    .slice()
    .sort((a, b) => b.amountUsd - a.amountUsd)
}

/**
 * Collect the balances that are worth collecting.
 *
 * Every call is individually caught. These are independent creditors; one whose
 * withdrawal reverts — a token blocklist, a bad account — must not stop the
 * others, and it especially must not stop them permanently, which is what an
 * uncaught throw in a capped loop does to everyone sorted after it.
 */
export async function sweepWithdrawals(): Promise<string> {
  const { isV2Market, withdrawableOf, withdraw } = await import('@/lib/onchain/labor-v2')
  if (!(await isV2Market())) return 'skipped: not a v2 market'
  if (!(await acquireOpsLease('withdrawals', LEASE_MS))) return 'skipped: leased'

  try {
    const agents = await agentsWithAccounts()
    if (agents.length === 0) return 'no agents with smart accounts'

    const balances: Withdrawable[] = []
    for (const a of agents) {
      try {
        const amountUsd = await withdrawableOf(a.address as `0x${string}`)
        balances.push({ agentId: a.id, address: a.address, amountUsd })
      } catch {
        // An unreadable balance is not a reason to skip every other creditor.
      }
    }

    const due = dueWithdrawals(balances)
    if (due.length === 0) return '0 due'

    const batch = due.slice(0, MAX_WITHDRAWALS_PER_PASS)
    let done = 0
    const failures: string[] = []
    for (const w of batch) {
      try {
        await withdraw(w.agentId)
        done++
      } catch (e) {
        failures.push(`${w.agentId}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`)
      }
    }

    // The deferred count, for the same reason the deadline sweep reports it: a
    // pass that collects 2 of 2 and a pass that collects 2 of 90 read
    // identically unless the backlog is in the line.
    const deferred = due.length - batch.length
    return [
      `${done}/${batch.length} collected`,
      deferred > 0 ? `${deferred} deferred` : '',
      failures.length ? `failed: ${failures.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join(', ')
  } finally {
    await releaseOpsLease('withdrawals')
  }
}

async function agentsWithAccounts(): Promise<{ id: string; address: string }[]> {
  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { isNotNull } = await import('drizzle-orm')
  const rows = await db
    .select({ id: agent.id, address: agent.smartAccountAddress })
    .from(agent)
    .where(isNotNull(agent.smartAccountAddress))
  return rows.filter((r): r is { id: string; address: string } => Boolean(r.address))
}
