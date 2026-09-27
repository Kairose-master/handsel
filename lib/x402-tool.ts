/**
 * x402-paid HTTP tools as office roles — the pure half.
 *
 * The Sep-2026 supply side of the agent economy is plain HTTP endpoints that
 * answer 402 and take $0.01 in USDC per call (Cloudflare Workers behind
 * x402-hono: yield watchers, liquidation sentinels, contract scanners…). They
 * are not MCP servers, so `connect_mcp_worker` cannot wire them, and until
 * now an office role could only use a tool that was free. This lets a role
 * BUY a tool call: the role's runtime pays the 402 out of the account's
 * x402 buyer key, inside the agent's spend envelope, and submits what came
 * back as its work (or, in 'assisted' mode, writes its deliverable from it).
 *
 * The one rule this file exists to enforce is Groundtruth's: **a 402
 * challenge is adversarial input.** The server we are paying tells us how
 * much, to whom, on which network and in what asset — and a compromised or
 * merely misconfigured server can say anything. So nothing from the
 * challenge is trusted: the network and asset are pinned by the deployment,
 * the price is capped by the binding, and `pickRequirement` refuses any
 * `accepts` entry that does not match all three. Pure; the fetch, the signer
 * and the ledger are in `lib/x402-tool-server.ts`.
 */

export type X402Network = 'base' | 'base-sepolia'

export const USDC_BY_NETWORK: Record<X402Network, string> = {
  base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'base-sepolia': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
}

export type X402ToolBinding = {
  /** The paid endpoint. https only. */
  url: string
  method: 'GET' | 'POST'
  /** Hard ceiling per call, USD. The challenge may ask for less, never more. */
  priceCapUsd: number
  /** POST: the JSON key the task text is sent under. GET: the query param. */
  bodyKey: string
  /** Optional: refuse a challenge whose payTo differs (a server that changed
   *  hands mid-subscription is a server you stop paying). Lowercase hex. */
  payTo?: string
}

export const X402_TOOL_PRICE_CAP_MAX_USD = 1

export function parseX402ToolBinding(input: unknown): { ok: true; binding: X402ToolBinding } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'binding must be an object' }
  const o = input as Record<string, unknown>
  const url = typeof o.url === 'string' ? o.url.trim() : ''
  if (!/^https:\/\/[^\s]+$/.test(url)) return { ok: false, reason: 'url must be https://…' }
  const method = o.method === 'GET' ? 'GET' : o.method === 'POST' || o.method === undefined ? 'POST' : null
  if (!method) return { ok: false, reason: 'method must be GET or POST' }
  const cap = typeof o.priceCapUsd === 'number' ? o.priceCapUsd : Number(o.priceCapUsd)
  if (!Number.isFinite(cap) || cap <= 0) return { ok: false, reason: 'priceCapUsd must be a positive number' }
  if (cap > X402_TOOL_PRICE_CAP_MAX_USD) return { ok: false, reason: `priceCapUsd over the $${X402_TOOL_PRICE_CAP_MAX_USD} per-call ceiling for a tool` }
  const bodyKey = typeof o.bodyKey === 'string' && o.bodyKey.trim() ? o.bodyKey.trim() : 'query'
  let payTo: string | undefined
  if (o.payTo !== undefined && o.payTo !== null && o.payTo !== '') {
    if (typeof o.payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(o.payTo)) return { ok: false, reason: 'payTo must be a 20-byte hex address' }
    payTo = o.payTo.toLowerCase()
  }
  return { ok: true, binding: { url, method, priceCapUsd: Math.round(cap * 1e6) / 1e6, bodyKey, ...(payTo ? { payTo } : {}) } }
}

/** One entry of an x402 v1 `accepts` array — only the fields we check. */
export type PaymentRequirement = {
  scheme: string
  network: string
  asset: string
  payTo: string
  maxAmountRequired: string
}

export type RequirementPick = { ok: true; chosen: PaymentRequirement; priceUsd: number } | { ok: false; reason: string }

/**
 * Choose the ONE requirement we are willing to pay, or refuse. Pins: exact
 * scheme, the deployment's network, that network's USDC, the binding's price
 * cap, and (when set) the binding's payTo. Everything else in the challenge
 * is ignored — a server cannot talk us onto another chain, another token, or
 * a bigger number.
 */
export function pickRequirement(
  accepts: readonly PaymentRequirement[],
  pins: { network: X402Network; priceCapUsd: number; payTo?: string },
): RequirementPick {
  const usdc = USDC_BY_NETWORK[pins.network]
  const capUnits = BigInt(Math.round(pins.priceCapUsd * 1e6))
  const reasons: string[] = []
  for (const r of accepts) {
    if (r.scheme !== 'exact') { reasons.push(`scheme ${r.scheme}`); continue }
    if (r.network !== pins.network) { reasons.push(`network ${r.network}`); continue }
    if (r.asset.toLowerCase() !== usdc) { reasons.push(`asset ${r.asset}`); continue }
    if (pins.payTo && r.payTo.toLowerCase() !== pins.payTo) { reasons.push(`payTo ${r.payTo}`); continue }
    let units: bigint
    try { units = BigInt(r.maxAmountRequired) } catch { reasons.push('unparseable amount'); continue }
    if (units <= 0n) { reasons.push('zero amount'); continue }
    if (units > capUnits) { reasons.push(`price ${Number(units) / 1e6} over cap ${pins.priceCapUsd}`); continue }
    return { ok: true, chosen: r, priceUsd: Number(units) / 1e6 }
  }
  return { ok: false, reason: accepts.length === 0 ? 'challenge offered no payment options' : `no acceptable option (${reasons.join('; ')})` }
}

/** USD → USDC base units, the number x402-fetch wants as `maxValue`. */
export function usdToUnits(usd: number): bigint {
  return BigInt(Math.round(usd * 1e6))
}

/** Build the request a binding sends for one task. */
export function requestFor(binding: X402ToolBinding, task: string): { url: string; init: RequestInit } {
  if (binding.method === 'GET') {
    const u = new URL(binding.url)
    u.searchParams.set(binding.bodyKey, task)
    return { url: u.toString(), init: { method: 'GET', headers: { Accept: 'application/json, text/plain;q=0.9' } } }
  }
  return {
    url: binding.url,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain;q=0.9' }, body: JSON.stringify({ [binding.bodyKey]: task }) },
  }
}

/** A verified starting point — Handsel's own paid market index, so the wiring
 *  can be smoke-tested against a server whose 402 we control. Third-party
 *  tools are added the way MCP connectors are: probed, then recorded in
 *  docs/office-connectors.md. */
export const X402_TOOL_PRESETS: readonly { id: string; label: string; binding: X402ToolBinding; blurb: string }[] = [
  {
    id: 'handsel-market-index',
    label: 'Handsel market index (paid read)',
    binding: { url: 'https://handsel-nu.vercel.app/api/market/index', method: 'GET', priceCapUsd: 0.01, bodyKey: 'q' },
    blurb: 'The live market index this deployment sells for $0.01 — the smoke-test target for a paid-tool role.',
  },
]
