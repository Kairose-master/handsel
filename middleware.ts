import { NextResponse, type NextRequest } from 'next/server'
import { paymentMiddleware } from 'x402-next'

/**
 * x402 paywall — the first real revenue rail.
 *
 * GET /api/agents/:id/report (the full underwritten credit report) costs
 * $0.01 in USDC per request, paid machine-to-machine over the x402
 * protocol (HTTP 402 + X-PAYMENT header, Linux Foundation standard). This
 * is the "pay-per-query credit check" business model wired up for real:
 * an agent that wants another agent's credit report pays for it, no
 * account, no API key, one HTTP roundtrip.
 *
 * Payment settles on Base Sepolia (testnet USDC) via the public x402
 * facilitator — deliberately independent of ONCHAIN_CHAIN, because the
 * payment rail doesn't need to live where the credit contracts live.
 *
 * Fully optional, same convention as the rest of the on-chain layer:
 * without X402_PAY_TO set, the paywall disappears and the report is free.
 */
const payTo = process.env.X402_PAY_TO as `0x${string}` | undefined
const facilitatorUrl = (process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator') as `${string}://${string}`

const x402 = payTo
  ? paymentMiddleware(
      payTo,
      {
        'GET /api/agents/*/report': {
          price: '$0.01',
          network: 'base-sepolia',
          config: {
            description: 'Handsel agent credit report — underwritten score, graded-fact history, repayment record',
            mimeType: 'application/json',
          },
        },
        // The Labor Index — real, platform-wide market data (supply,
        // open demand, graded-pass quality), not one agent's report.
        'GET /api/market/index': {
          price: '$0.01',
          network: 'base-sepolia',
          config: {
            description: 'Handsel Labor Index — real-time agent supply, open job demand, and independent-grading pass rate across the whole market',
            mimeType: 'application/json',
          },
        },
        // Demand inflow from outside: the posting fee buys a house-agent-
        // escrowed bounty on the Labor Market. No account, no API key.
        'POST /api/jobs/external': {
          price: '$0.10',
          network: 'base-sepolia',
          config: {
            description:
              'Post a job to the Handsel Labor Market ($25 testnet bounty escrowed for you). Body: {title, acceptance_criteria, description?, test_code?, min_score?}',
            mimeType: 'application/json',
          },
        },
      },
      { url: facilitatorUrl },
    )
  : null

export default async function middleware(request: NextRequest) {
  if (!x402) return NextResponse.next()
  return x402(request)
}

export const config = {
  matcher: ['/api/agents/:id/report', '/api/jobs/external', '/api/market/index'],
}
