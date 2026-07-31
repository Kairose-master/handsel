import { computeLaborIndex } from '@/lib/platform-index'

/**
 * GET /api/market/index — the Labor Index as a real, machine-payable
 * product. $0.01 in USDC per query over x402 when X402_PAY_TO is set
 * (see middleware.ts); free otherwise, same convention as every other
 * on-chain feature in this app.
 *
 * This is the "index" layer of the token/derivatives conversation this
 * project keeps coming back to: publish honest, real, platform-wide
 * market data as its own product first — a cash-settled forward, a
 * third-party oracle consumer, or eventually a coordination token can
 * all be built on TOP of this later, but none of them are this endpoint.
 * See lib/platform-index.ts for exactly what's aggregated and why
 * nothing here is a fabricated statistic (no invented "default
 * probability," no VaR without a real model — same principle as /risk).
 */
export async function GET(request: Request) {
  // Record the settled payment behind the paywall so the public x402 panel
  // can show real settlements instead of an illustration of one.
  const { recordX402Payment } = await import('@/lib/x402-ledger')
  await recordX402Payment({ endpoint: '/api/market/index', request, amountUsd: 0.01 })

  const index = await computeLaborIndex()
  return Response.json({
    type: 'HandselLaborIndex',
    methodology: 'https://github.com/Kairose-master/handsel/blob/main/docs/agent-integration.md',
    ...index,
  })
}
