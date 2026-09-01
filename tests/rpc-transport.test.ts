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
import { buildChainTransport, isMalformedRpcResult, CHAIN_HTTP_OPTIONS, rpcUrlList } from '@/lib/onchain/transport'

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
