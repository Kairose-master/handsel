/**
 * Which runtime this deployment's money lives on.
 *
 * A deployment is EVM **or** Solana, never both — the market address, the
 * escrow token and the agent wallets all belong to one of them. So this is a
 * discriminator, not a capability list, and it is derived from the environment
 * rather than stored, for the same reason `isRealMoney()` is: a value somebody
 * has to remember to update is a value that will be wrong.
 *
 * Kept in its own file, importing only the Solana side, so that
 * `lib/onchain/config.ts` (which builds a viem chain and is imported by
 * everything EVM) does not have to know Solana exists.
 */
import { isSolanaConfigured, solanaClusterName, solanaIsRealMoney } from './solana/config'

export type ChainKind = 'evm' | 'solana'

/**
 * EVM unless a valid Solana environment is present.
 *
 * Defaulting to EVM keeps every existing deployment on exactly the path it is
 * on today: with `SOLANA_*` unset this returns `'evm'` and nothing downstream
 * changes. A Solana deployment is opt-in and takes two env vars to reach.
 */
export function chainKind(): ChainKind {
  return isSolanaConfigured() ? 'solana' : 'evm'
}

/**
 * The environment label, for disclosure.
 *
 * CLAUDE.md's rule is that nothing hardcodes "testnet" or "mainnet" — labels
 * come from the chain. That rule had an EVM-shaped hole: `CHAIN.name` is built
 * from `ONCHAIN_CHAIN`, so a Solana deployment would have shown the name of a
 * chain it does not use. Returns null when the answer is genuinely unknown,
 * which the footer renders as nothing rather than as a guess.
 */
export function chainDisplayName(evmChainName: string | null | undefined): string | null {
  if (chainKind() === 'solana') return `Solana ${solanaClusterName()}`
  return evmChainName ?? null
}

/**
 * Real money, for whichever runtime this deployment is on.
 *
 * The EVM answer is passed in rather than imported, so this file stays free of
 * `lib/onchain/config.ts` and its viem chain construction. `isRealMoney()` in
 * `lib/onchain/real-money.ts` is the one caller that supplies it, and remains
 * the function the rest of the codebase asks.
 */
export function realMoneyForKind(evmIsRealMoney: boolean): boolean {
  return chainKind() === 'solana' ? solanaIsRealMoney() : evmIsRealMoney
}
