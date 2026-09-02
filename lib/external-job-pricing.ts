/**
 * What an outside client pays, and what that buys.
 *
 * `POST /api/jobs/external` charges $0.10 over x402 and escrows a $25 bounty
 * from the house agent. On mUSDC that is a deliberate subsidy: the point was
 * demand, the token is free, and 250x out for 1x in costs the house nothing.
 *
 * On a real chain the same arithmetic is a faucet handle on the house agent's
 * wallet, and the daily cap only sets the rate. The route's own header has
 * promised since it was written that "on mainnet this becomes bounty
 * pass-through", and pass-through was never built — so the route currently
 * refuses outright on a real-money chain (docs/security-audit.md F27).
 *
 * This is the pass-through. It exists so that opening the route on mainnet is
 * a matter of setting two numbers rather than writing code under time
 * pressure, and so the one invariant that matters is asserted rather than
 * assumed:
 *
 *   **the price must exceed the bounty.**
 *
 * Same rule `lib/storefront-pricing.ts` already enforces for the storefront,
 * and the same reason: a route selling below the escrow it funds is a subsidy
 * wearing a price tag, and a subsidy nobody decided to give is a leak.
 *
 * Pure. The route reads `externalJobPricing()` and refuses when it says to.
 */

/** The testnet shape, unchanged: a nominal fee buying a real practice bounty. */
export const TESTNET_PRICE_USD = 0.1
export const TESTNET_BOUNTY_USD = 25

/**
 * The real-money shape, from the environment.
 *
 * Env rather than constants because these are the operator's numbers, not the
 * codebase's — and because the alternative is a commit at the moment somebody
 * wants to change a price, which is when a commit is least welcome.
 */
export const PRICE_ENV = 'EXTERNAL_JOB_PRICE_USD'
export const BOUNTY_ENV = 'EXTERNAL_JOB_BOUNTY_USD'

export type ExternalJobPricing =
  | { open: true; priceUsd: number; bountyUsd: number; marginUsd: number }
  | { open: false; reason: string }

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Is this route open, at what price, funding what bounty?
 *
 * Closed is the default on real money and that is deliberate. An operator who
 * has not set a price has not decided to sell this, and inferring one from the
 * testnet numbers would be the platform deciding to spend real money on its
 * owner's behalf.
 */
export function externalJobPricing(input: {
  isRealMoney: boolean
  price?: string
  bounty?: string
}): ExternalJobPricing {
  if (!input.isRealMoney) {
    return {
      open: true,
      priceUsd: TESTNET_PRICE_USD,
      bountyUsd: TESTNET_BOUNTY_USD,
      marginUsd: TESTNET_PRICE_USD - TESTNET_BOUNTY_USD,
    }
  }

  const priceUsd = num(input.price)
  const bountyUsd = num(input.bounty)
  if (priceUsd === null || bountyUsd === null) {
    return {
      open: false,
      reason:
        `External job posting is closed on this deployment. Its testnet pricing — $${TESTNET_PRICE_USD} for a ` +
        `$${TESTNET_BOUNTY_USD} escrowed bounty — is a subsidy that cannot run on a real-money chain. ` +
        `Set ${PRICE_ENV} and ${BOUNTY_ENV} to open it, with the price above the bounty.`,
    }
  }
  if (priceUsd <= bountyUsd) {
    // Loud rather than clamped. Silently charging more than configured would
    // be the platform overruling its operator about money; silently escrowing
    // less would sell a bounty the buyer did not get.
    return {
      open: false,
      reason:
        `${PRICE_ENV} ($${priceUsd.toFixed(2)}) must exceed ${BOUNTY_ENV} ($${bountyUsd.toFixed(2)}) — ` +
        'at or below it every posting escrows more than it collects.',
    }
  }
  return { open: true, priceUsd, bountyUsd, marginUsd: Math.round((priceUsd - bountyUsd) * 100) / 100 }
}

/** The x402 price string for the paywall's static map. */
export function externalJobPriceLabel(pricing: ExternalJobPricing): string {
  return pricing.open ? `$${pricing.priceUsd.toFixed(2)}` : `$${TESTNET_PRICE_USD.toFixed(2)}`
}
