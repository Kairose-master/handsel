/**
 * The chain RPC transport — the fix for the measured production failure where
 * every RPC error over a week was HTTP 429 from the primary provider
 * (base-mainnet.infura.io), and every call site built its own default-tuned
 * viem transport so nothing could be adjusted in one place.
 *
 * Pins two things:
 *  1. The pure parts: URL-list parsing and which transport shape a list builds
 *     (one URL → plain http, several → fallback, none → chain-default http).
 *  2. The call sites: every chain read/write client goes through
 *     chainTransport(). A file that quietly goes back to `http(onchainEnv.rpcUrl)`
 *     silently loses batching, the 429-tuned retry, and the fallback URLs.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { base } from 'viem/chains'
import { buildChainTransport, isMalformedRpcResult,
  isTxHash, CHAIN_HTTP_OPTIONS, rpcUrlList, withPublicFallbacks, PUBLIC_RPC_URLS } from '@/lib/onchain/transport'

describe('rpcUrlList', () => {
  it('returns the primary alone when no fallbacks are configured', () => {
    expect(rpcUrlList('https://a.example', '')).toEqual(['https://a.example'])
  })

  it('puts the primary first, then fallbacks in order', () => {
    expect(rpcUrlList('https://a.example', 'https://b.example,https://c.example')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ])
  })

  it('trims whitespace and drops empty entries', () => {
    expect(rpcUrlList(' https://a.example ', ' https://b.example , ,, https://c.example ')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ])
  })

  it('de-duplicates while keeping first occurrence order', () => {
    expect(rpcUrlList('https://a.example', 'https://b.example,https://a.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('handles an unset primary with configured fallbacks', () => {
    expect(rpcUrlList('', 'https://b.example')).toEqual(['https://b.example'])
  })
})

describe('buildChainTransport', () => {
  // The chain's own default RPC is ALWAYS appended as the last resort —
  // measured need (2026-09-01): the configured provider answered `latest`
  // with a null block and every claim in an office round failed twice over,
  // while the chain's healthy public endpoint sat one un-populated env var
  // away. So a single configured URL still builds a fallback pair.
  it('a single URL still gets the chain default behind it', () => {
    const t = buildChainTransport(['https://a.example'])({ chain: base })
    expect(t.config.type).toBe('fallback')
    const inner = (t.value as { transports: { config: { type: string }; value?: { url?: string } }[] }).transports
    expect(inner).toHaveLength(2)
    expect(inner[0].value?.url).toBe('https://a.example')
    // No explicit URL on the last: viem resolves the chain's own default RPC.
    expect(inner[1].value?.url).toBe(base.rpcUrls.default.http[0])
  })

  it('orders several URLs primary first, chain default last', () => {
    const t = buildChainTransport(['https://a.example', 'https://b.example'])({ chain: base })
    expect(t.config.type).toBe('fallback')
    const inner = (t.value as { transports: { config: { type: string }; value?: { url?: string } }[] }).transports
    expect(inner).toHaveLength(3)
    expect(inner[0].value?.url).toBe('https://a.example')
    expect(inner[1].value?.url).toBe('https://b.example')
    expect(inner[2].value?.url).toBe(base.rpcUrls.default.http[0])
  })

  it("an empty list is the chain's default RPC alone (the pre-existing unset-env behavior)", () => {
    const t = buildChainTransport([])({ chain: base })
    expect(t.config.type).toBe('http')
    // No explicit URL: viem resolves the chain's own default RPC.
    expect(t.value?.url).toBe(base.rpcUrls.default.http[0])
  })

  it('tunes retry for rate limits, not blips, and batches same-tick reads', () => {
    // 429 was 100% of the measured failures; viem's 150ms default re-hits a
    // per-second limit while it is still saying no.
    expect(CHAIN_HTTP_OPTIONS.retryDelay).toBeGreaterThanOrEqual(400)
    expect(CHAIN_HTTP_OPTIONS.retryCount).toBeGreaterThanOrEqual(3)
    expect(CHAIN_HTTP_OPTIONS.batch).toBe(true)
    const t = buildChainTransport([])({ chain: base })
    expect(t.config.retryCount).toBe(CHAIN_HTTP_OPTIONS.retryCount)
    expect(t.config.retryDelay).toBe(CHAIN_HTTP_OPTIONS.retryDelay)
  })
})

describe('call sites use chainTransport()', () => {
  const files = ['lib/onchain/clients.ts', 'lib/onchain/account.ts', 'lib/onchain/mini-vault-chain.ts']

  for (const file of files) {
    it(`${file} does not rebuild a default transport from the raw RPC URL`, () => {
      const src = readFileSync(file, 'utf8')
      expect(src).not.toContain('http(onchainEnv.rpcUrl)')
      expect(src).toContain('chainTransport()')
    })
  }

  it('the bundler transport stays a plain http transport (vendor-specific state must not rotate)', () => {
    const src = readFileSync('lib/onchain/account.ts', 'utf8')
    expect(src).toContain('bundlerTransport: http(onchainEnv.bundlerRpc)')
  })
})

describe('isMalformedRpcResult — a 200 with an impossible null is a transport failure', () => {
  it('flags null/undefined where the chain always has an answer', () => {
    expect(isMalformedRpcResult('eth_getBalance', ['0xabc', 'latest'], undefined)).toBe(true)
    expect(isMalformedRpcResult('eth_estimateGas', [{}], null)).toBe(true)
    expect(isMalformedRpcResult('eth_getBlockByNumber', ['latest', false], null)).toBe(true)
    // A broadcast with no hash is not an acceptance (§67).
    expect(isMalformedRpcResult('eth_sendRawTransaction', ['0xsigned'], null)).toBe(true)
  })

  it('lets legitimate nulls through — pending receipts, future blocks', () => {
    expect(isMalformedRpcResult('eth_getTransactionReceipt', ['0xhash'], null)).toBe(false)
    expect(isMalformedRpcResult('eth_getBlockByNumber', ['0xfffffff', false], null)).toBe(false)
  })

  it('never flags a real result', () => {
    expect(isMalformedRpcResult('eth_getBalance', ['0xabc', 'latest'], '0x0')).toBe(false)
    expect(isMalformedRpcResult('eth_getBlockByNumber', ['latest', false], { number: '0x1' })).toBe(false)
  })
})

describe('a swallowed transaction fails loudly instead of exhausting the route budget', () => {
  // viem's waitForTransactionReceipt polls FOREVER by default. A provider
  // that accepted a tx (returned a hash) and never propagated it left every
  // write path spinning until the Vercel runtime killed the invocation at
  // 120s — funding transfers, wave posts, gas top-ups, all at once, with no
  // error logged. Every EOA write's receipt wait is bounded.
  it('sendEoaCall and the gas top-up wait with a timeout', () => {
    const src = readFileSync('lib/onchain/account.ts', 'utf8')
    expect(src).toContain('RECEIPT_TIMEOUT_MS')
    const waits = src.match(/waitForTransactionReceipt\(\{[^}]*\}\)/g) ?? []
    expect(waits.length).toBeGreaterThanOrEqual(2)
    for (const w of waits) expect(w).toContain('timeout: RECEIPT_TIMEOUT_MS')
  })
})

describe('a signed transaction is broadcast to every node, not the first healthy-looking one', () => {
  // fallback() rotates on errors — and the outage that took every write
  // path down at once was a primary that ACCEPTED transactions (hash
  // returned: success, no rotation) into a mempool it never propagated.
  // A signed tx is idempotent, so eth_sendRawTransaction fans out to all
  // configured nodes and the chain default; the first acceptance wins.
  it('buildChainTransport special-cases eth_sendRawTransaction with a fan-out', () => {
    const src = readFileSync('lib/onchain/transport.ts', 'utf8')
    expect(src).toContain("args.method === 'eth_sendRawTransaction'")
    expect(src).toContain('Promise.allSettled')
    // Reads stay on the ranked fallback — the fan-out is writes only.
    const block = src.slice(src.indexOf('export function buildChainTransport'))
    expect(block).toContain('return t.request(args as never)')
  })

  it('only a real transaction hash wins the fan-out — a null "success" is not an acceptance', () => {
    // 2026-09-02: a node fulfilled eth_sendRawTransaction with null, the
    // first-fulfilled rule took it, and every posting on two desks waited
    // its full receipt timeout on hash "undefined" while the nodes that had
    // actually answered were ignored. Nothing reached a mempool.
    expect(isTxHash('0x' + 'ab'.repeat(32))).toBe(true)
    expect(isTxHash(null)).toBe(false)
    expect(isTxHash(undefined)).toBe(false)
    expect(isTxHash('0x1234')).toBe(false)
    expect(isTxHash({ hash: '0x' + 'ab'.repeat(32) })).toBe(false)
    const src = readFileSync('lib/onchain/transport.ts', 'utf8')
    const block = src.slice(src.indexOf("args.method === 'eth_sendRawTransaction'"))
    expect(block).toContain("r.status === 'fulfilled' && isTxHash(r.value)")
    expect(block).toContain('no node returned a transaction hash')
  })

  it('receipts fan out too — a mined receipt from any node beats a null from the ranked one', () => {
    // Twice in one round the broadcast landed through one node and the
    // receipt polls asked a lagging one, which answered null until the
    // timeout. Null is legitimate for this method, so the guard cannot
    // catch it; asking every node can.
    const src = readFileSync('lib/onchain/transport.ts', 'utf8')
    const block = src.slice(src.indexOf("args.method === 'eth_getTransactionReceipt'"))
    expect(block.length).toBeGreaterThan(100)
    expect(block).toContain('Promise.allSettled(singles.map')
    expect(block).toContain("r.status === 'fulfilled' && r.value != null")
    // All-null is still null — the transaction may simply not be mined yet.
    expect(block).toContain("if (results.some((r) => r.status === 'fulfilled')) return null")
    // Other reads stay on the ranked fallback.
    expect(block).toContain('return t.request(args as never)')
  })
})

describe('withPublicFallbacks — the operator ranks first, then a set of independent public nodes', () => {
  // §67: one sick primary plus one throttled public node is not a fan-out.
  it('appends the chain\'s keyless public RPCs behind the configured ones, de-duplicated', () => {
    const out = withPublicFallbacks(['https://a.example', 'https://base-sepolia.drpc.org'], 84532)
    expect(out[0]).toBe('https://a.example')
    expect(out).toHaveLength(1 + PUBLIC_RPC_URLS[84532].length)
    expect(new Set(out).size).toBe(out.length)
    for (const u of PUBLIC_RPC_URLS[84532]) expect(out).toContain(u)
  })
  it('leaves an unknown chain alone', () => {
    expect(withPublicFallbacks(['https://a.example'], 424242)).toEqual(['https://a.example'])
  })
  it('every public URL is https and carries no key', () => {
    for (const urls of Object.values(PUBLIC_RPC_URLS)) {
      expect(urls.length).toBeGreaterThanOrEqual(2)
      for (const u of urls) {
        expect(u).toMatch(/^https:\/\//)
        expect(u).not.toMatch(/key|token|api_key|\?/i)
      }
    }
  })
  it('chainTransport composes the public set in', () => {
    const src = readFileSync('lib/onchain/transport.ts', 'utf8')
    expect(src).toContain('buildChainTransport(withPublicFallbacks(rpcUrlList(onchainEnv.rpcUrl, onchainEnv.rpcFallbackUrls), CHAIN.id))')
  })
})
