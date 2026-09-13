import { feedMeta } from '@/lib/feed-meta'
import { isLaborMarketConfigured } from '@/lib/onchain/config'
import type { OnchainJob } from '@/lib/onchain/labor'

/** An unavailable read is not an empty market. Only complete, block-pinned
 * reads may supply aggregate metrics. No job details escape via metadata. */
export async function readMarketSnapshot() {
  const meta = feedMeta()
  let state: 'ok' | 'unconfigured' | 'unreachable' = 'unconfigured'
  let jobs: OnchainJob[] | null = null
  let blockNumber: string | null = null
  let observedAt: string | null = null
  if (isLaborMarketConfigured()) {
    try {
      const { readJobsSnapshot } = await import('@/lib/onchain/labor')
      const result = await readJobsSnapshot()
      jobs = result.jobs
      blockNumber = result.blockNumber
      observedAt = result.observedAt
      state = 'ok'
    } catch {
      state = 'unreachable'
    }
  }
  return {
    jobs,
    snapshot: {
      ...meta, state, blockNumber, observedAt,
      source: 'contract_job_state' as const,
      coverage: state === 'ok' ? 'all_contract_jobs' as const : 'unavailable' as const,
      finality: 'latest_not_finalized' as const,
    },
  }
}
