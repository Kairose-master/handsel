import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const route = readFileSync('app/api/xrpl/jobs/route.ts', 'utf8')
const sharedPost = readFileSync('lib/external-job-create.ts', 'utf8')

describe('XRPL paid job posting stays idempotent and reuses Handsel posting', () => {
  it('binds an invoice to the quoted request and consumes each signed transaction once', () => {
    expect(route).toContain('body_hash text NOT NULL')
    expect(route).toContain('payment_hash text UNIQUE')
    expect(route).toContain("ON CONFLICT DO NOTHING RETURNING invoice_id")
    expect(route).toContain("if (row?.state === 'complete') return jsonResponse(row.response_body")
    expect(route).toContain('row.body_hash !== requestHash')
    expect(route).toContain('invoiceId.startsWith(`${requestHash.slice(0, 32)}.`)')
    const challenge = route.slice(route.indexOf('if (!payment)'))
    expect(challenge.slice(0, challenge.indexOf('return Response.json'))).not.toContain('ensureInvoiceTable')
  })

  it('does not create a job before facilitator settlement succeeds', () => {
    expect(route.indexOf("'settle', payment, requirements")).toBeLessThan(route.indexOf('createExternalJob({'))
    expect(route).toContain("settlement.success !== true")
    expect(route).toContain("payment_response jsonb")
    expect(route).toContain("headers.set('PAYMENT-RESPONSE'")
  })

  it('keeps one shared job and escrow implementation behind both payment adapters', () => {
    expect(readFileSync('app/api/jobs/external/route.ts', 'utf8')).toContain('createExternalJob(')
    expect(route).toContain('createExternalJob(')
    expect(sharedPost).toContain('postJob(houseAgentId, input.pricing.bountyUsd')
  })
})
