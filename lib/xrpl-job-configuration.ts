import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { externalJobPricing, PRICE_ENV, BOUNTY_ENV, type ExternalJobPricing } from '@/lib/external-job-pricing'
import { xrplMerchantConfig, type XrplMerchantConfig } from '@/lib/xrpl-x402-merchant'

export async function xrplJobConfiguration(): Promise<
  { response: Response } | { config: XrplMerchantConfig; pricing: Extract<ExternalJobPricing, { open: true }> }
> {
  const config = xrplMerchantConfig()
  if (!config) return { response: Response.json({ error: 'XRPL job posting is not configured. Set XRPL_PAY_TO, XRPL_RLUSD_ISSUER, XRPL_NETWORK, and XRPL_FACILITATOR_URL.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) } as const
  const { isRealMoney } = await import('@/lib/onchain/real-money')
  // Collection on XRPL mainnet is real money even if escrow runs on testnet.
  const pricing = externalJobPricing({ isRealMoney: config.network === 'xrpl:0' || isRealMoney(), price: process.env[PRICE_ENV], bounty: process.env[BOUNTY_ENV] })
  if (!pricing.open) return { response: Response.json({ error: pricing.reason }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) } as const
  if (!process.env.X402_JOB_REQUESTER_AGENT_ID) return { response: Response.json({ error: 'Job posting is unavailable: X402_JOB_REQUESTER_AGENT_ID is unset.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) } as const
  const [house] = await db.select({ smartAccountAddress: agent.smartAccountAddress }).from(agent).where(eq(agent.id, process.env.X402_JOB_REQUESTER_AGENT_ID))
  if (!house?.smartAccountAddress) return { response: Response.json({ error: 'The Handsel job requester is not provisioned.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) } as const
  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) return { response: Response.json({ error: 'Labor market is not configured on this deployment.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) } as const
  return { config, pricing } as const
}
