/**
 * One page that answers "how much has Handsel made, and where is it".
 *
 * Named `platform-treasury` because `treasury` was already taken twice — by
 * `lib/onchain/treasury.ts` (an agent's own wallet moves) and by
 * `app/actions/treasury.ts`'s `getTreasury(agentId)` (one agent's balances).
 * This is the PLATFORM's side of the ledger, which is a different question
 * from any single agent's.
 *
 * Nothing did. The money sits in three unrelated places and no surface reads
 * more than one of them:
 *
 *   - `X402_PAY_TO` — where external payments land. A bare address; the x402
 *     ledger counts what was charged, and nothing checks the balance.
 *   - the house agent (`X402_JOB_REQUESTER_AGENT_ID`) — a smart account that
 *     FRONTS escrow for external postings. Run it dry and external posting
 *     silently stops working.
 *   - the contract's `feeRecipient` — the protocol fee, credited into
 *     `withdrawable(address)` and never swept.
 *
 * ## A ledger, not a wallet
 *
 * The obvious version of this is a central platform wallet the three drain
 * into. `docs/fee-withdrawal.md` already refuses that, and is right to:
 * automating the fee sweep means putting the key that owns the entire fee
 * stream into a server environment, and merging the three makes one
 * compromise's blast radius the whole platform's money.
 *
 * So this reads and never signs. It adds a view and not one byte of key
 * material or a single new write path. The fee key stays cold and its four
 * manual commands stay the only way to move it.
 *
 * ## Every figure is a live read, and a missing one is null
 *
 * A balance that could not be read renders as "not read", never as `0`. The
 * difference matters more here than anywhere else in the app: "$0.00 in the
 * house wallet" is the alarm that external posting is about to fail, and an
 * RPC timeout that prints the same thing is a false alarm that trains the
 * owner to ignore the real one.
 *
 * Pure. The server module supplies the readings.
 */

export type Balance = {
  label: string
  /** The address the figure is about, when there is one. */
  address: string | null
  /** USD, or null when it could not be read. NEVER 0 as a stand-in. */
  usd: number | null
  /** Why it is null, when it is. */
  unavailable: string | null
  hint: string
}

export type EscrowHealth = {
  /** What the contract owes everyone: escrow plus uncollected withdrawals. */
  owedUsd: number | null
  /** What it actually holds. */
  heldUsd: number | null
  /** held − owed. Negative would mean the contract cannot pay what it owes. */
  surplusUsd: number | null
}

export type Treasury = {
  balances: Balance[]
  escrow: EscrowHealth
  /** Cumulative external inflow, from the x402 ledger. */
  chargedUsd: number | null
  chargedCount: number | null
  /** Collectable right now without touching escrow: the fee credit. */
  collectableUsd: number | null
  /** Anything an operator has to act on. Empty when all is well. */
  alerts: string[]
}

/** Below this the house agent can no longer front an external posting, and
 *  the route starts failing for a reason nothing on the page would explain. */
export const HOUSE_FLOOR_USD = 10

export function buildTreasury(input: {
  feeCredit: number | null
  feeRecipient: string | null
  houseBalance: number | null
  houseAddress: string | null
  payToBalance: number | null
  payTo: string | null
  escrow: EscrowHealth
  chargedUsd: number | null
  chargedCount: number | null
  /** What one external posting costs the house to front. */
  externalBountyUsd: number | null
}): Treasury {
  const balances: Balance[] = [
    {
      label: 'Protocol fee, uncollected',
      address: input.feeRecipient,
      usd: input.feeCredit,
      unavailable: input.feeCredit === null ? 'the market contract did not answer' : null,
      hint: 'Credited by the contract and never swept — pull, not push. docs/fee-withdrawal.md has the four commands.',
    },
    {
      label: 'House agent (fronts external escrow)',
      address: input.houseAddress,
      usd: input.houseBalance,
      unavailable:
        input.houseAddress === null
          ? 'X402_JOB_REQUESTER_AGENT_ID is not set on this deployment'
          : input.houseBalance === null
            ? 'the balance could not be read'
            : null,
      hint: 'Every external job posting is escrowed from here first and returns on refund.',
    },
    {
      label: 'x402 receiving address',
      address: input.payTo,
      usd: input.payToBalance,
      unavailable:
        input.payTo === null
          ? 'X402_PAY_TO is not set — the paywall is off and everything is free'
          : input.payToBalance === null
            ? 'the balance could not be read'
            : null,
      hint: 'Where external clients pay. Settled by the facilitator, not by this app.',
    },
  ]

  const alerts: string[] = []
  // Only ever alerts on a figure that was actually read. An unread balance is
  // not evidence of anything, and alerting on it is how a dashboard teaches
  // its reader to ignore it.
  if (input.houseBalance !== null && input.houseBalance < HOUSE_FLOOR_USD) {
    alerts.push(
      `The house agent holds $${input.houseBalance.toFixed(2)}. Below about $${HOUSE_FLOOR_USD} it can no longer front ` +
        'an external posting, and that route starts failing with an on-chain error rather than a price.',
    )
  }
  if (input.houseBalance !== null && input.externalBountyUsd !== null && input.externalBountyUsd > 0) {
    const postings = Math.floor(input.houseBalance / input.externalBountyUsd)
    if (postings < 5) alerts.push(`That is ${postings} more external posting${postings === 1 ? '' : 's'} at the configured bounty.`)
  }
  if (input.escrow.surplusUsd !== null && input.escrow.surplusUsd < 0) {
    alerts.push(
      `The market contract is short $${Math.abs(input.escrow.surplusUsd).toFixed(2)} against what it owes. ` +
        'This should be impossible; treat it as a live incident.',
    )
  }

  return {
    balances,
    escrow: input.escrow,
    chargedUsd: input.chargedUsd,
    chargedCount: input.chargedCount,
    collectableUsd: input.feeCredit,
    alerts,
  }
}
