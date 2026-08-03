'use server'

import {
  CHALLENGE_WINDOW_DAYS,
  describeChallenge,
  pickChallengeJob,
  type ChallengeState,
} from '@/lib/challenge'

export type ChallengeView = {
  state: ChallengeState
  /** Three-valued, same as the task feed: an empty board and an unreadable
   *  chain are different answers, and a challenge page that renders "no prize"
   *  because the RPC blinked is the worst version of this page. */
  read: 'ok' | 'unconfigured' | 'unreachable'
  escrowAddress: string | null
  explorerUrl: string | null
  chainName: string | null
}

export async function getChallenge(): Promise<ChallengeView> {
  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) {
    return { state: { kind: 'none' }, read: 'unconfigured', escrowAddress: null, explorerUrl: null, chainName: null }
  }

  const { CHAIN, EXPLORER_URL, onchainEnv } = await import('@/lib/onchain/config')
  const escrowAddress = onchainEnv.laborMarketAddress || null
  const base = {
    escrowAddress,
    explorerUrl: escrowAddress ? `${EXPLORER_URL}/address/${escrowAddress}` : null,
    chainName: CHAIN.name,
  }

  let unreachable = false
  const { readJobs } = await import('@/lib/onchain/labor')
  const jobs = await readJobs().catch(() => {
    unreachable = true
    return []
  })
  if (unreachable) return { state: { kind: 'none' }, read: 'unreachable', ...base }

  // Titles are off-chain; join them by id the same way the public board does.
  const { publicJobsResult } = await import('@/app/actions/guest')
  const { jobs: withTitles } = await publicJobsResult(60)
  const titleById = new Map(withTitles.map((j) => [Number(j.id), j.title as string | null]))

  const job = pickChallengeJob(jobs, (j) => titleById.get(j.id))
  return {
    state: describeChallenge(job, Math.floor(Date.now() / 1000), CHALLENGE_WINDOW_DAYS),
    read: 'ok',
    ...base,
  }
}
