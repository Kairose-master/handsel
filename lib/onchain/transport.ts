/**
 * The one place the chain RPC transport is built.
 *
 * Why this file exists: on 2026-08 the mainnet deployment's RPC failures were
 * measured from Vercel's error clusters — 212 of 212 were HTTP 429 from the
 * configured Base RPC, zero were timeouts. viem's default transport had
 * already retried each of those (retryCount 3 at 150ms base ≈ 150/300/600ms),
 * which is tuned for blips, not for a per-second rate limit that needs the
 * better part of a second to clear. And every `http(onchainEnv.rpcUrl)`
 * call site rebuilt its own transport with those defaults, so tuning meant
 * touching four files or none.
 *
 * Three levers, all aimed at 429:
 *
 * 1. **Batching** — independent reads issued in the same tick (the treasury
 *    pages fire one eth_getBalance + one balanceOf per agent, in parallel)
 *    coalesce into one JSON-RPC batch request. The provider may still meter
 *    the calls inside it, but the request-per-second limit — the one that was
 *    actually answering 429 — sees one request instead of N.
 * 2. **Slower, longer retry** — 400ms base doubling per attempt gives a
 *    rate-limited endpoint room to clear where 150ms re-hits it while it is
 *    still saying no.
 * 3. **Fallback URLs** — `ONCHAIN_RPC_FALLBACK_URLS` (comma-separated) names
 *    backup endpoints; when the primary's retries are exhausted the same
 *    request is answered by the next provider instead of failing the read.
 *    Unset, nothing changes: one URL builds a plain http transport.
 *
 * The bundler transport is deliberately NOT built here — a bundler holds
 * vendor-specific UserOperation state, so rotating providers mid-flight is
 * not the safe no-op it is for plain chain reads.
 */
import { fallback, http, type Transport } from 'viem'
import { onchainEnv } from './config'

/**
 * Methods whose result is NEVER legitimately null/undefined. A degraded
 * provider (measured live, 2026-09-01: Infura answering 200 with an empty
 * result) hands viem `undefined`, and the crash happens ABOVE the transport
 * — `BigInt(undefined)` in fee estimation — where `fallback()` cannot see
 * it, so the healthy endpoint one entry down never gets asked. Promoting a
 * malformed result to a thrown error INSIDE the transport is what lets the
 * fallback rotate.
 *
 * Deliberately a whitelist: eth_getTransactionReceipt is null while pending
 * and eth_getBlockByNumber is null for a future block — null is an ANSWER
 * there. "latest" is the exception: the chain always has a latest block.
 */
const NEVER_NULL_METHODS = new Set([
  'eth_blockNumber',
  'eth_chainId',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_estimateGas',
  'eth_call',
])

/** Pure: is this (method, params, result) a malformed provider answer? */
export function isMalformedRpcResult(method: string, params: unknown, result: unknown): boolean {
  if (result !== null && result !== undefined) return false
  if (NEVER_NULL_METHODS.has(method)) return true
  if (method === 'eth_getBlockByNumber' && Array.isArray(params) && params[0] === 'latest') return true
  return false
}

/**
 * Retry/batch options for one chain-RPC endpoint. Worst case adds ~2.8s of
 * waiting (400+800+1600) before giving up on a URL — acceptable for server
 * routes, and strictly better than surfacing the 429 to a money path.
 */
export const CHAIN_HTTP_OPTIONS = {
  batch: true,
  retryCount: 3,
  retryDelay: 400,
} as const

/**
 * Primary URL first, then each fallback, trimmed, de-duplicated, empties
 * dropped. Pure so the parsing — the part that silently misconfigures when it
 * is wrong — is testable without env or network.
 */
export function rpcUrlList(primary: string, fallbackCsv: string): string[] {
  const urls = [primary, ...fallbackCsv.split(',')].map((u) => u.trim()).filter(Boolean)
  return [...new Set(urls)]
}

/** Build the transport for an explicit URL list (exported for tests).
 *
 * The chain's own default public RPC is ALWAYS the last resort, whether or
 * not `ONCHAIN_RPC_FALLBACK_URLS` names anything. Measured need (2026-09-01,
 * §60's sequel): the configured provider began answering `latest` with a
 * null block — viem's fee estimation then throws `Cannot convert undefined
 * to a BigInt` (or BlockNotFoundError, same root) — and every claim in the
 * office round failed twice over while a perfectly healthy public endpoint
 * existed one entry further down a list nobody had populated. A degraded
 * paid provider must degrade to the chain's public RPC, not to a dead
 * market. (With no configured URL at all the default was already the only
 * entry; this just stops it disappearing the moment a primary is set.)
 */
/** Wrap one http transport so a malformed (null-where-impossible) result is
 *  thrown as an error the surrounding `fallback()` can rotate on. */
function guardedHttp(url: string | undefined): Transport {
  const inner = http(url, CHAIN_HTTP_OPTIONS)
  return (cfg) => {
    const t = inner(cfg)
    return {
      ...t,
      async request(args: { method: string; params?: unknown }) {
        const result = await t.request(args as never)
        if (isMalformedRpcResult(args.method, args.params, result)) {
          throw new Error(`RPC returned ${result === null ? 'null' : 'undefined'} for ${args.method} — malformed provider response`)
        }
        return result
      },
    } as typeof t
  }
}

export function buildChainTransport(urls: string[]): Transport {
  const transports: Transport[] = [...urls, ''].map((u) =>
    // viem treats an empty URL as "use the chain's default RPC".
    guardedHttp(u || undefined),
  )
  if (transports.length === 1) return transports[0]
  const ranked = fallback(transports)
  // eth_sendRawTransaction goes to EVERY node, not just the first healthy-
  // looking one. fallback() rotates on ERRORS — and the failure that took
  // every write path down at once was a primary that accepted transactions
  // (returned the hash: success, no rotation) into a mempool it never
  // propagated. A signed transaction is idempotent, so broadcasting it to
  // all nodes is safe: the first acceptance wins, an "already known" from a
  // node that has it is just another acceptance path, and the transaction
  // reaches a mempool that actually mines. Reads keep the ranked fallback.
  return (cfg) => {
    const t = ranked(cfg)
    const singles = transports.map((mk) => mk(cfg))
    return {
      ...t,
      async request(args: { method: string; params?: unknown }) {
        if (args.method === 'eth_sendRawTransaction') {
          const results = await Promise.allSettled(singles.map((s) => s.request(args as never)))
          const ok = results.find((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
          if (ok) return ok.value
          throw (results[0] as PromiseRejectedResult).reason
        }
        return t.request(args as never)
      },
    } as typeof t
  }
}

/** The transport every chain read/write client should use. */
export function chainTransport(): Transport {
  return buildChainTransport(rpcUrlList(onchainEnv.rpcUrl, onchainEnv.rpcFallbackUrls))
}
