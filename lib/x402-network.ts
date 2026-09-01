/**
 * Which network the x402 paywall settles on.
 *
 * This was the string `'base-sepolia'`, written four times into
 * `middleware.ts`, with a comment explaining that the payment rail is
 * "deliberately independent of ONCHAIN_CHAIN, because the payment rail doesn't
 * need to live where the credit contracts live."
 *
 * That reasoning holds for exactly one of the four routes it was applied to.
 * Selling a credit report is a data sale: it does not matter what chain the
 * buyer's dollar came from. The other three **fund escrow** —
 * `POST /api/jobs/external` buys a house-escrowed bounty, and each storefront
 * commission funds a whole escrowed pipeline out of the serving prime's own
 * wallet. For those, the currency the buyer pays in and the currency the
 * platform spends are the same trade, and a rail that floats free of the
 * escrow chain is not independence, it is a mismatch.
 *
 * On a Base **mainnet** deployment the mismatch is a drain with no attacker
 * skill required: Base Sepolia USDC is a faucet token that costs nothing to
 * obtain, so a client mints the fee for free and the desk answers with real
 * Circle USDC locked in a real escrow. Every guard around these routes is
 * about *how much* — the daily cap, the fixed price, the margin test — and not
 * one of them checks *what*.
 *
 * So the network follows the chain. Derived here rather than imported from
 * `lib/onchain/config.ts` because middleware runs on the edge and that module
 * pulls in viem's chain definitions and throws on an unknown value; a paywall
 * that cannot construct is a paywall that is off. Copy-plus-pin, the same
 * convention as `lib/storefront-pricing.ts`: the copy is tiny and a test pins
 * it against the real chain list so the two cannot diverge.
 */

/** The x402 networks this app can settle on. */
export type X402Network = 'base' | 'base-sepolia'

/**
 * Real money settles on Base; everything else settles on Base Sepolia.
 *
 * `sepolia` and `giwa-sepolia` are testnets with no x402 network of their own,
 * and mapping them to test USDC is right for the same reason mapping `base` to
 * real USDC is: the buyer should be paying in money of the same kind the
 * platform is about to spend.
 *
 * An unset chain means no on-chain layer at all, which is a supported way to
 * run this app — and the safe default there is test money, never real.
 */
export function x402NetworkFor(chainName: string | undefined | null): X402Network {
  return chainName === 'base' ? 'base' : 'base-sepolia'
}

/**
 * Does this route's price fund escrow the platform then spends?
 *
 * Kept as an explicit list rather than a guess, because the answer decides
 * whether a currency mismatch is a curiosity or a drain, and a route added
 * later should have to say which kind it is.
 */
export const ESCROW_FUNDING_ROUTES = ['POST /api/jobs/external', 'POST /api/storefront/'] as const

export function fundsEscrow(route: string): boolean {
  return ESCROW_FUNDING_ROUTES.some((r) => route.startsWith(r))
}
