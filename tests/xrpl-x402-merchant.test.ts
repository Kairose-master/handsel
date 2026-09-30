import { describe, expect, it, vi } from 'vitest'
import {
  XRPL_RLUSD_CURRENCY,
  callXrplFacilitator,
  decodeXrplPaymentHeader,
  paymentMatchesRequirements,
  xrplMerchantConfig,
  xrplPaymentChallenge,
  xrplPaymentRequirements,
} from '@/lib/xrpl-x402-merchant'

const config = {
  facilitatorUrl: 'https://xrpl-facilitator-mainnet.t54.ai',
  network: 'xrpl:0' as const,
  payTo: 'rAAAAAAAAAAAAAAAAAAAAAAAAA',
  issuer: 'rBBBBBBBBBBBBBBBBBBBBBBBBB',
  sourceTag: 804681468,
}

describe('XRPL x402 merchant requirements', () => {
  it('builds an invoice-bound RLUSD challenge recognized by the AI Hub', () => {
    const challenge = xrplPaymentChallenge({ url: 'https://handsel.example/api/xrpl/jobs', amountUsd: 3, config, invoiceId: 'invoice-1' })
    expect(challenge.body.x402Version).toBe(2)
    expect(challenge.body.resource.name).toContain('Handsel')
    expect(challenge.body.resource.description).toContain('verified work')
    expect(challenge.body.accepts).toEqual([{
      scheme: 'exact', network: 'xrpl:0', asset: XRPL_RLUSD_CURRENCY, payTo: config.payTo, amount: '3.00',
      maxTimeoutSeconds: 600,
      extra: { invoiceId: 'invoice-1', sourceTag: config.sourceTag, issuer: config.issuer },
    }])
    expect(JSON.parse(Buffer.from(challenge.header, 'base64').toString()).accepts[0].network).toBe('xrpl:0')
  })

  it('decodes signed payment headers and rejects term or invoice substitution', () => {
    const required = xrplPaymentRequirements({ config, amountUsd: 3, invoiceId: 'invoice-1' })
    const encoded = Buffer.from(JSON.stringify({ x402Version: 2, accepted: required, payload: { signedTxBlob: 'AB12CD' } })).toString('base64')
    const payment = decodeXrplPaymentHeader(encoded)
    expect(payment).not.toBeNull()
    expect(paymentMatchesRequirements(payment!, required)).toBe(true)
    expect(paymentMatchesRequirements(payment!, { ...required, extra: { ...required.extra, invoiceId: 'invoice-2' } })).toBe(false)
    expect(decodeXrplPaymentHeader(Buffer.from(JSON.stringify({ x402Version: 2, payload: { signedTxBlob: 'not-hex' } })).toString('base64'))).toBeNull()
  })

  it('requires XRPL recipient, issuer, and a network-matched facilitator', () => {
    expect(xrplMerchantConfig({ XRPL_PAY_TO: config.payTo, XRPL_RLUSD_ISSUER: config.issuer })).toMatchObject({ network: 'xrpl:0' })
    expect(xrplMerchantConfig({ XRPL_PAY_TO: config.payTo })).toBeNull()
    expect(xrplMerchantConfig({ XRPL_PAY_TO: config.payTo, XRPL_RLUSD_ISSUER: config.issuer, XRPL_NETWORK: 'xrpl:1' })).toBeNull()
  })

  it('uses T54 /verify and /settle with the x402 v2 merchant payload', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe(`${config.facilitatorUrl}/verify`)
      expect(JSON.parse(String(init?.body))).toMatchObject({ x402Version: 2, paymentPayload: { payload: { signedTxBlob: 'AB12' } } })
      return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const requirements = xrplPaymentRequirements({ config, amountUsd: 3, invoiceId: 'invoice-1' })
    const result = await callXrplFacilitator(config, 'verify', { x402Version: 2, accepted: requirements, payload: { signedTxBlob: 'AB12' } }, requirements, fetchMock as typeof fetch)
    expect(result).toEqual({ isValid: true })
  })
})
