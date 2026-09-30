import { randomUUID } from 'node:crypto'

export const XRPL_RLUSD_CURRENCY = '524C555344000000000000000000000000000000'
export const XRPL_SOURCE_TAG_DEFAULT = 804681468
export const XRPL_JOB_RESOURCE_NAME = 'Handsel — Verified Agent Job Posting'
export const XRPL_JOB_RESOURCE_DESCRIPTION =
  'Pay an autonomous agent to do verified work. Handsel routes your paid job to worker agents, independently grades their deliverables, and releases the existing escrow only when work passes.'

export type XrplMerchantConfig = {
  facilitatorUrl: string
  network: 'xrpl:0' | 'xrpl:1'
  payTo: string
  issuer: string
  sourceTag: number
}

export type XrplPaymentRequirements = {
  scheme: 'exact'
  network: XrplMerchantConfig['network']
  asset: string
  payTo: string
  amount: string
  maxTimeoutSeconds: number
  extra: { invoiceId: string; sourceTag: number; issuer: string }
}

export type XrplPaymentPayload = {
  x402Version: number
  accepted: XrplPaymentRequirements
  payload: { signedTxBlob: string }
  [key: string]: unknown
}

export function xrplMerchantConfig(env: Record<string, string | undefined> = process.env): XrplMerchantConfig | null {
  const payTo = env.XRPL_PAY_TO?.trim()
  const issuer = env.XRPL_RLUSD_ISSUER?.trim()
  if (!payTo || !issuer) return null
  const classicAddress = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/
  if (!classicAddress.test(payTo) || !classicAddress.test(issuer)) return null
  const network = env.XRPL_NETWORK || 'xrpl:0'
  if (network !== 'xrpl:0' && network !== 'xrpl:1') return null
  const sourceTag = Number(env.XRPL_SOURCE_TAG || XRPL_SOURCE_TAG_DEFAULT)
  if (!Number.isInteger(sourceTag) || sourceTag < 0 || sourceTag > 0xffffffff) return null
  let facilitatorUrl: URL
  try {
    facilitatorUrl = new URL(env.XRPL_FACILITATOR_URL || 'https://xrpl-facilitator-mainnet.t54.ai')
  } catch {
    return null
  }
  if (facilitatorUrl.protocol !== 'https:' && facilitatorUrl.hostname !== 'localhost' && facilitatorUrl.hostname !== '127.0.0.1') return null
  const isKnownT54Testnet = facilitatorUrl.hostname === 'xrpl-facilitator-testnet.t54.ai'
  const isKnownT54Mainnet = facilitatorUrl.hostname === 'xrpl-facilitator-mainnet.t54.ai'
  if (isKnownT54Testnet && network !== 'xrpl:1') return null
  if (isKnownT54Mainnet && network !== 'xrpl:0') return null
  return { facilitatorUrl: facilitatorUrl.toString().replace(/\/$/, ''), network, payTo, issuer, sourceTag }
}

export function xrplPaymentRequirements(input: {
  config: XrplMerchantConfig
  amountUsd: number
  invoiceId: string
}): XrplPaymentRequirements {
  return {
    scheme: 'exact',
    network: input.config.network,
    asset: XRPL_RLUSD_CURRENCY,
    payTo: input.config.payTo,
    amount: input.amountUsd.toFixed(2),
    maxTimeoutSeconds: 600,
    extra: { invoiceId: input.invoiceId, sourceTag: input.config.sourceTag, issuer: input.config.issuer },
  }
}

export function xrplPaymentChallenge(input: {
  url: string
  amountUsd: number
  config: XrplMerchantConfig
  invoiceId?: string
}) {
  const invoiceId = input.invoiceId ?? randomUUID()
  const requirement = xrplPaymentRequirements({ config: input.config, amountUsd: input.amountUsd, invoiceId })
  const body = {
    x402Version: 2,
    error: 'Payment required',
    resource: {
      url: input.url,
      name: XRPL_JOB_RESOURCE_NAME,
      description: XRPL_JOB_RESOURCE_DESCRIPTION,
      mimeType: 'application/json',
    },
    accepts: [requirement],
  }
  return {
    invoiceId,
    body,
    header: Buffer.from(JSON.stringify(body)).toString('base64'),
    requirements: requirement,
  }
}

export function decodeXrplPaymentHeader(value: string | null): XrplPaymentPayload | null {
  if (!value) return null
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as XrplPaymentPayload
    if (decoded.x402Version !== 2 || decoded.accepted?.scheme !== 'exact' || typeof decoded.payload?.signedTxBlob !== 'string') return null
    if (!/^[A-Fa-f0-9]+$/.test(decoded.payload.signedTxBlob)) return null
    return decoded
  } catch {
    return null
  }
}

export function paymentMatchesRequirements(payload: XrplPaymentPayload, required: XrplPaymentRequirements): boolean {
  const a = payload.accepted
  return a.scheme === required.scheme && a.network === required.network && a.asset === required.asset &&
    a.payTo === required.payTo && a.amount === required.amount && a.maxTimeoutSeconds === required.maxTimeoutSeconds &&
    a.extra?.invoiceId === required.extra.invoiceId &&
    a.extra?.sourceTag === required.extra.sourceTag && a.extra?.issuer === required.extra.issuer
}

export async function callXrplFacilitator<T>(
  config: XrplMerchantConfig,
  action: 'verify' | 'settle',
  paymentPayload: XrplPaymentPayload,
  paymentRequirements: XrplPaymentRequirements,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(`${config.facilitatorUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
    signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result || typeof result !== 'object') throw new Error(`T54 facilitator ${action} failed (${response.status})`)
  return result as T
}
