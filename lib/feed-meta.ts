/**
 * Which chain a machine is looking at, in the response it is already reading.
 *
 * §26 fixed the human-facing half of this: no user-facing string may assert an
 * environment from a constant, because the landing page asserted "public
 * testnet, zero monetary value" on Base mainnet for weeks. The machine-facing
 * half was never built at all. `GET /api/tasks` — the documented integration
 * point, unauthenticated and polled by programs — returned a list of jobs with
 * **no statement of which money they settle in**. A program had exactly one way
 * to tell mainnet from testnet: the hostname it happened to be given.
 *
 * That is worse than the §26 bug rather than milder. A human misreading a
 * disclaimer still sees a page. A program has no context at all, and this feed
 * is what we point programs at.
 *
 * ## How this was found, which is the part worth keeping
 *
 * It was not found. It was **asserted into existence**. A paid third-party audit
 * reported `/api/tasks` as "CONSISTENT" on both deployments and quoted a `meta`
 * block — `environment`, `chainId`, `realMoney`, `currencyLabel`,
 * `contractAddress`, `warning` — with exact values. No such block existed. The
 * report was verified where it alleged defects and taken on trust where it
 * alleged correctness, so a fabricated clean bill of health propagated into
 * `docs/failure-modes.md`, `docs/deployments.md`, `CLAUDE.md`, a public GitHub
 * comment, and the safety contract of a skill package about to be distributed
 * to worker agents. Recorded as §27.
 *
 * This file makes the claim true rather than retracting it, because the claim
 * was right — it just had nobody implementing it. Field names are kept exactly
 * as they were published, since integrations were told those names.
 *
 * Everything here is DERIVED. Nothing is a literal about which deployment this
 * is, which is the whole point and is pinned by `tests/feed-meta.test.ts`.
 */
import { CHAIN, onchainEnv } from '@/lib/onchain/config'
import { isRealMoney } from '@/lib/onchain/real-money'

export type FeedMeta = {
  /** `"mainnet"` when the configured chain settles in real money. */
  environment: 'mainnet' | 'testnet'
  chainId: number
  chainName: string
  /** The one field that changes what a reader should do. */
  realMoney: boolean
  currency: string
  /** Long form, for display. Never abbreviated to a bare ticker on a testnet. */
  currencyLabel: string
  /** The market these jobs live in, so a reader can check the chain itself
   *  rather than trusting this object. */
  contractAddress: string | null
  explorerUrl: string | null
  /** Present in both cases. A warning that only appears on mainnet teaches a
   *  reader that its absence means safety, and absence is also what a bug looks
   *  like. */
  warning: string
}

const EXPLORERS: Record<number, string> = {
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
  11155111: 'https://sepolia.etherscan.io',
}

export function feedMeta(): FeedMeta {
  const real = isRealMoney()
  const address = onchainEnv.laborMarketAddress || null
  const explorer = EXPLORERS[CHAIN.id] ?? null
  return {
    environment: real ? 'mainnet' : 'testnet',
    chainId: CHAIN.id,
    chainName: CHAIN.name,
    realMoney: real,
    currency: real ? 'USDC' : 'test USDC',
    currencyLabel: real ? 'real Circle USDC' : 'faucet test tokens (no monetary value)',
    contractAddress: address,
    explorerUrl: address && explorer ? `${explorer}/address/${address}` : null,
    warning: real
      ? 'These jobs settle in real USDC. Fees and worker bonds are real money.'
      : 'Testnet only. Tokens have no real monetary value.',
  }
}
