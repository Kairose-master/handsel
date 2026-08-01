/**
 * Which Solana cluster this deployment talks to, and whether losing tokens
 * there means losing anything.
 *
 * Standalone by design — it imports nothing from `lib/onchain/config.ts`. That
 * file builds a viem chain from `ONCHAIN_CHAIN` and everything downstream of it
 * assumes EVM; making the Solana answer depend on it would reintroduce the bug
 * this module exists to close.
 */
import { isValidAddress } from './codec'

/**
 * Clusters where losing funds does not mean losing funds.
 *
 * An allowlist of test clusters, so an unrecognised one counts as real money —
 * the same asymmetry `lib/onchain/real-money.ts` uses for EVM chain ids, for
 * the same reason. Being wrong this way costs an operator two minutes of
 * confusion; being wrong the other way costs somebody's funds.
 */
const TEST_CLUSTERS = new Set(['devnet', 'testnet', 'localnet'])

export type SolanaCluster = 'devnet' | 'testnet' | 'localnet' | 'mainnet-beta' | (string & {})

const DEFAULT_RPC: Record<string, string> = {
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  localnet: 'http://127.0.0.1:8899',
}

export const solanaEnv = {
  cluster: (process.env.SOLANA_CLUSTER ?? '').trim(),
  programId: (process.env.SOLANA_PROGRAM_ID ?? '').trim(),
  /** Overrides the public endpoint. The public ones rate-limit hard enough
   *  that a board polling them is a bad time; same lesson as the Alchemy
   *  limit that killed settlements mid-flight (failure-modes §11 territory). */
  rpcUrl: (process.env.SOLANA_RPC_URL ?? '').trim(),
}

export function solanaRpcUrl(): string | null {
  if (solanaEnv.rpcUrl) return solanaEnv.rpcUrl
  return DEFAULT_RPC[solanaEnv.cluster] ?? null
}

/**
 * Is this deployment pointed at Solana at all?
 *
 * Both a cluster and a VALID program address are required. A half-set
 * environment — cluster set, program id a typo — must read as "not
 * configured" rather than as a Solana deployment that fails on every call,
 * because the second one degrades into an empty board that looks like an empty
 * market. That distinction is the whole point of `MarketReadState` in
 * `app/actions/guest.ts`.
 */
export function isSolanaConfigured(): boolean {
  return Boolean(solanaEnv.cluster) && isValidAddress(solanaEnv.programId) && solanaRpcUrl() !== null
}

/**
 * Real money on the Solana side.
 *
 * `docs/solana-port.md` records devnet as a decision, and this is the function
 * that has to agree with it. If someone ever sets `SOLANA_CLUSTER=mainnet-beta`
 * this returns true and every disclosure, badge and guard that reads
 * `isRealMoney()` flips with it — which is the behaviour that document is
 * counting on, not a loophole in it.
 */
export function solanaIsRealMoney(): boolean {
  return !TEST_CLUSTERS.has(solanaEnv.cluster)
}

/** Human-readable cluster name for UI disclosure. Never hardcode "devnet" in
 *  copy — derive it from here, the same rule CLAUDE.md sets for `CHAIN.name`. */
export function solanaClusterName(): string {
  return solanaEnv.cluster || 'unconfigured'
}

/** Explorer link for an address on the configured cluster. */
export function solanaExplorerUrl(address: string): string {
  const suffix = solanaEnv.cluster === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(solanaEnv.cluster)}`
  return `https://explorer.solana.com/address/${address}${suffix}`
}
