'use server'
/**
 * The three numbers on the fleet landing page, and the environment line.
 *
 * Every figure is a live query and every one may be null: the page prints a
 * dash and says the read failed, never a zero it did not measure ("no fake
 * data, ever"). No auth — this is the public landing.
 */
import { pool } from '@/lib/db'

export type FleetOverview = {
  /** Agents with a provisioned wallet. */
  agents: number | null
  /** Jobs whose escrow released on a passing grade, ever. */
  jobsDelivered: number | null
  /** Signed work proofs issued, ever. */
  proofs: number | null
  realMoney: boolean | null
  chainName: string | null
}

async function count(sql: string): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ n: string }>(sql)
    return Number(rows[0]?.n ?? 0)
  } catch {
    return null
  }
}

export async function getFleetOverview(): Promise<FleetOverview> {
  const [agents, jobsDelivered, proofs] = await Promise.all([
    count(`SELECT count(*) AS n FROM agent WHERE "smartAccountAddress" IS NOT NULL`),
    count(`SELECT count(*) AS n FROM platform_events WHERE kind = 'JOB_COMPLETED'`),
    count(`SELECT count(*) AS n FROM work_proofs`),
  ])
  let realMoney: boolean | null = null
  let chainName: string | null = null
  // Same gate as the guest landing (failure-modes §28): an unconfigured
  // market answers null, never "test money" by default.
  try {
    const { isLaborMarketConfigured, CHAIN } = await import('@/lib/onchain/config')
    chainName = CHAIN.name
    if (isLaborMarketConfigured()) {
      const { isRealMoney } = await import('@/lib/onchain/real-money')
      realMoney = await isRealMoney()
    }
  } catch {
    /* unconfigured chain: the page says so */
  }
  return { agents, jobsDelivered, proofs, realMoney, chainName }
}
