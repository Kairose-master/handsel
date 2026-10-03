import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ escrowReal: false, labor: true, house: true }))
vi.mock('@/lib/db', () => ({ db: { select: () => ({ from: () => ({ where: async () => state.house ? [{ smartAccountAddress: '0xhouse' }] : [] }) }) }, pool: { query: vi.fn(() => { throw new Error('Unpaid preflight must not write invoices') }) } }))
vi.mock('@/lib/db/schema', () => ({ agent: { id: 'id', smartAccountAddress: 'smartAccountAddress' } }))
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }))
vi.mock('@/lib/onchain/real-money', () => ({ isRealMoney: () => state.escrowReal }))
vi.mock('@/lib/onchain/config', () => ({ isLaborMarketConfigured: () => state.labor }))
vi.mock('@/lib/external-job-create', () => ({ externalJobInputError: async () => null, createExternalJob: vi.fn(() => { throw new Error('Unpaid preflight must not create jobs') }) }))

import { xrplJobConfiguration } from '@/lib/xrpl-job-configuration'
import { GET as discovery } from '@/app/.well-known/x402/route'
import { POST } from '@/app/api/xrpl/jobs/route'

beforeEach(() => {
  vi.stubEnv('XRPL_PAY_TO', 'rAAAAAAAAAAAAAAAAAAAAAAAAA')
  vi.stubEnv('XRPL_RLUSD_ISSUER', 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De')
  vi.stubEnv('XRPL_NETWORK', 'xrpl:0')
  vi.stubEnv('XRPL_FACILITATOR_URL', 'https://xrpl-facilitator-mainnet.t54.ai')
  vi.stubEnv('XRPL_SOURCE_TAG', '')
  vi.stubEnv('EXTERNAL_JOB_PRICE_USD', '3')
  vi.stubEnv('EXTERNAL_JOB_BOUNTY_USD', '2')
  vi.stubEnv('X402_JOB_REQUESTER_AGENT_ID', 'house')
  vi.stubEnv('PUBLIC_ORIGIN', 'https://handsel-main.vercel.app')
  state.escrowReal = false
  state.labor = true
  state.house = true
})
afterEach(() => vi.unstubAllEnvs())

describe('production discovery and unpaid challenge agree', () => {
  it('hides an unconfigured merchant without advertising a free resource', async () => {
    vi.stubEnv('XRPL_PAY_TO', '')
    const response = await discovery()
    expect((await response.json()).resources).toEqual([])
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await POST(new Request('https://handsel-main.vercel.app/api/xrpl/jobs', { method: 'POST' }))).status).toBe(503)
  })

  it.each(['requester', 'house', 'labor', 'pricing'])('hides resources when %s is unavailable', async (failure) => {
    if (failure === 'requester') vi.stubEnv('X402_JOB_REQUESTER_AGENT_ID', '')
    if (failure === 'house') state.house = false
    if (failure === 'labor') state.labor = false
    if (failure === 'pricing') vi.stubEnv('EXTERNAL_JOB_PRICE_USD', '2')
    expect((await (await discovery()).json()).resources).toEqual([])
  })

  it('quotes mainnet price even when the escrow runtime is testnet', async () => {
    const resource = (await (await discovery()).json()).resources[0]
    const response = await POST(new Request(resource.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Preflight', acceptance_criteria: 'Read-only configuration check' }) }))
    expect(response.status).toBe(402)
    const challenge = await response.json()
    expect(JSON.parse(Buffer.from(response.headers.get('payment-required')!, 'base64').toString())).toEqual(challenge)
    expect(challenge.resource.url).toBe(resource.url)
    expect(challenge.accepts[0]).toMatchObject({ scheme: resource.payment.scheme, network: resource.payment.network, asset: resource.payment.asset, payTo: resource.payment.payTo, amount: '3.00', extra: { issuer: resource.payment.issuer, sourceTag: 804681468 } })
  })

  it('never falls back to the subsidy when receiving XRPL mainnet money', async () => {
    vi.stubEnv('EXTERNAL_JOB_PRICE_USD', '')
    expect(await xrplJobConfiguration()).toHaveProperty('response.status', 503)
  })

  it('retains the subsidy only when both rails are testnet', async () => {
    vi.stubEnv('XRPL_NETWORK', 'xrpl:1')
    vi.stubEnv('XRPL_FACILITATOR_URL', 'https://xrpl-facilitator-testnet.t54.ai')
    expect(await xrplJobConfiguration()).toHaveProperty('pricing.priceUsd', 0.1)
    state.escrowReal = true
    expect(await xrplJobConfiguration()).toHaveProperty('pricing.priceUsd', 3)
  })
})
