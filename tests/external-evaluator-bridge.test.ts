import { describe, expect, it, vi } from 'vitest'
import { ExternalEvaluatorBridge } from '@/lib/external-evaluator-bridge'

/**
 * The stub this replaces (`daydreamsai/skills-market#58`) hardcoded
 * `{ passed: true }` against a domain that doesn't resolve. These tests pin
 * the two properties that make this a real bridge instead: it calls a real
 * endpoint with a real base URL, and it can return false and null, not just
 * a convenient pass.
 */

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('ExternalEvaluatorBridge', () => {
  it('refuses construction without a token — fail-closed, no silent anonymous calls', () => {
    expect(() => new ExternalEvaluatorBridge({} as never)).toThrow(/token is required/)
  })

  it('defaults to the real mainnet base URL, not the nonexistent handsel.dev', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ passed: true, reason: 'ok', gradedAt: 't' }))
    const bridge = new ExternalEvaluatorBridge({ token: 'tok', fetchImpl })
    await bridge.evaluate({ deliverable: 'd', spec: 's' })
    expect(fetchImpl).toHaveBeenCalledWith('https://handsel-main.vercel.app/api/grade', expect.any(Object))
  })

  it('accepts the sepolia base URL override for zero-value testing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ passed: true, reason: 'ok', gradedAt: 't' }))
    const bridge = new ExternalEvaluatorBridge({ token: 'tok', baseUrl: 'https://handsel-nu.vercel.app', fetchImpl })
    await bridge.evaluate({ deliverable: 'd', spec: 's' })
    expect(fetchImpl).toHaveBeenCalledWith('https://handsel-nu.vercel.app/api/grade', expect.any(Object))
  })

  it('sends the bearer token and body the real /api/grade route expects', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ passed: true, reason: 'ok', gradedAt: 't' }))
    const bridge = new ExternalEvaluatorBridge({ token: 'secret-tok', fetchImpl })
    await bridge.evaluate({ deliverable: 'the diff', spec: 'must compile', label: 'bounty-1' })
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret-tok' })
    expect(JSON.parse(init.body as string)).toEqual({ deliverable: 'the diff', spec: 'must compile', label: 'bounty-1' })
  })

  it('returns a real fail verdict — the check can fail', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ passed: false, reason: 'does not compile', gradedAt: 't' }))
    const bridge = new ExternalEvaluatorBridge({ token: 'tok', fetchImpl })
    const result = await bridge.evaluate({ deliverable: 'd', spec: 's' })
    expect(result.passed).toBe(false)
    expect(result.score).toBe(0)
    expect(result.lane).toBe('model')
  })

  it('treats an ungraded response as null, never coerced to false or true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ passed: null, reason: 'no LLM key', gradedAt: 't' }))
    const bridge = new ExternalEvaluatorBridge({ token: 'tok', fetchImpl })
    const result = await bridge.evaluate({ deliverable: 'd', spec: 's' })
    expect(result.passed).toBeNull()
    expect(result.score).toBeNull()
  })

  it('carries the proof url through on a pass', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ passed: true, reason: 'meets spec', gradedAt: 't', proof: { url: 'https://handsel-main.vercel.app/proof/abc' } }))
    const bridge = new ExternalEvaluatorBridge({ token: 'tok', fetchImpl })
    const result = await bridge.evaluate({ deliverable: 'd', spec: 's' })
    expect(result.proofUrl).toBe('https://handsel-main.vercel.app/proof/abc')
  })

  it('throws on a rejected token rather than returning a fake verdict', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_token' }, 401))
    const bridge = new ExternalEvaluatorBridge({ token: 'bad', fetchImpl })
    await expect(bridge.evaluate({ deliverable: 'd', spec: 's' })).rejects.toThrow(/token rejected/)
  })

  it('throws on rate limit rather than silently retrying or fabricating a pass', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'rate limit' }, 429))
    const bridge = new ExternalEvaluatorBridge({ token: 'tok', fetchImpl })
    await expect(bridge.evaluate({ deliverable: 'd', spec: 's' })).rejects.toThrow(/rate limited/)
  })

  it('refuses an empty deliverable or spec before making a call', async () => {
    const fetchImpl = vi.fn()
    const bridge = new ExternalEvaluatorBridge({ token: 'tok', fetchImpl })
    await expect(bridge.evaluate({ deliverable: '', spec: 's' })).rejects.toThrow(/deliverable is required/)
    await expect(bridge.evaluate({ deliverable: 'd', spec: '  ' })).rejects.toThrow(/spec .* is required/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
