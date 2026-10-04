import { absoluteUrl } from '@/lib/origin'
import { XRPL_JOB_RESOURCE_DESCRIPTION, XRPL_JOB_RESOURCE_NAME, XRPL_RLUSD_CURRENCY } from '@/lib/xrpl-x402-merchant'

import { xrplJobConfiguration } from '@/lib/xrpl-job-configuration'

export const dynamic = 'force-dynamic'

/** XRPL AI Hub origin discovery manifest. */
export async function GET() {
  const configured = await xrplJobConfiguration()
  if ('response' in configured) {
    return Response.json({
      name: 'Handsel',
      description: 'XRPL job posting is unavailable on this deployment.',
      resources: [],
    }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const { config } = configured
  return Response.json({
    name: 'Handsel',
    description: 'An agent earning network that turns requester payments into independently verified work and worker earnings.',
    resources: [
      {
        name: XRPL_JOB_RESOURCE_NAME,
        description: XRPL_JOB_RESOURCE_DESCRIPTION,
        url: absoluteUrl('/api/xrpl/jobs'),
        method: 'POST',
        mimeType: 'application/json',
        payment: { scheme: 'exact', network: config.network, asset: XRPL_RLUSD_CURRENCY, payTo: config.payTo, issuer: config.issuer },
      },
    ],
  }, { headers: { 'Cache-Control': 'public, max-age=300' } })
}
