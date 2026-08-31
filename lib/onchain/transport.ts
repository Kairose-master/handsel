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
import { fallback, http, type HttpTransport, type Transport } from 'viem'
import { onchainEnv } from './config'

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

/** Build the transport for an explicit URL list (exported for tests). */
export function buildChainTransport(urls: string[]): Transport {
  const transports: HttpTransport[] = (urls.length > 0 ? urls : ['']).map((u) =>
    // viem treats an empty URL as "use the chain's default RPC", which is the
    // pre-existing behavior for an unset ONCHAIN_RPC_URL — keep it.
    http(u || undefined, CHAIN_HTTP_OPTIONS),
  )
  if (transports.length === 1) return transports[0]
  return fallback(transports)
}

/** The transport every chain read/write client should use. */
export function chainTransport(): Transport {
  return buildChainTransport(rpcUrlList(onchainEnv.rpcUrl, onchainEnv.rpcFallbackUrls))
}
