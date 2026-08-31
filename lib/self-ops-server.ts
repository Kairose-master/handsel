/**
 * Self-ops collector — gathers the vitals `lib/self-ops.ts` judges.
 *
 * Runs on the ops cycle's FAST subset (see the step in lib/ops-cycle.ts), so
 * every read here is bounded and best-effort: a vital that cannot be read in
 * time reports null and the pure detector treats null honestly rather than
 * inventing a value. Never throws into the tick.
 */
import { detectSelfOpsFindings, formatSelfOpsReport, type PlatformVitals, type SelfOpsFinding } from '@/lib/self-ops'

/** Bound a read so a slow RPC cannot stall a visitor-driven tick. */
async function within<T>(ms: number, work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      }),
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function collectPlatformVitals(): Promise<PlatformVitals> {
  const now = Date.now()

  // When the last FULL cycle started: the 'full-cycle' lease is taken at the
  // start of every full run for FULL_CYCLE_LEASE_MS, so leased_until minus
  // the TTL is the start time. No new table, no new write path — the signal
  // already exists as a side effect of the thing being measured.
  let lastFullCycleAt: number | null = null
  try {
    const { pool } = await import('@/lib/db')
    const { FULL_CYCLE_LEASE_MS } = await import('@/lib/ops-cycle')
    const { rows } = await pool.query(`SELECT leased_until FROM ops_leases WHERE name = 'full-cycle'`)
    const leasedUntil = rows[0]?.leased_until ? new Date(rows[0].leased_until).getTime() : null
    if (leasedUntil !== null && Number.isFinite(leasedUntil)) {
      lastFullCycleAt = leasedUntil - FULL_CYCLE_LEASE_MS
    }
  } catch {
    // table missing (fresh deploy) or db hiccup — reads as "never observed"
  }

  let onchainConfigured = false
  let oracleWei: bigint | null = null
  try {
    const { isAgentAccountConfigured } = await import('@/lib/onchain/config')
    onchainConfigured = isAgentAccountConfigured()
    if (onchainConfigured) {
      const { oracleAccount } = await import('@/lib/onchain/clients')
      const { publicClient } = await import('@/lib/onchain/clients')
      oracleWei = await within(3_000, publicClient().getBalance({ address: oracleAccount().address }))
    }
  } catch {
    oracleWei = null
  }

  let openStorefronts: number | null = null
  try {
    const { enabledStorefronts } = await import('@/lib/office-storefront')
    const rows = await within(3_000, enabledStorefronts())
    openStorefronts = rows === null ? null : rows.length
  } catch {
    openStorefronts = null
  }

  let realMoney = false
  try {
    const { isRealMoney } = await import('@/lib/onchain/real-money')
    realMoney = isRealMoney()
  } catch {
    // stays false — a misread here only softens wording, never a threshold
  }

  return { now, lastFullCycleAt, oracleWei, onchainConfigured, openStorefronts, realMoney }
}

/** The ops step body: collect, judge, say so where the operator will look.
 *  Criticals go to console.error so they surface in the deployment's log
 *  stream and in the cron run's JSON report — this sweep reports, it never
 *  fixes (see lib/self-ops.ts's header for why). */
export async function runSelfOpsSweep(): Promise<{
  findings: SelfOpsFinding[]
  report: string
}> {
  const vitals = await collectPlatformVitals()
  const findings = detectSelfOpsFindings(vitals)
  const report = formatSelfOpsReport(findings)
  const worst = findings.find((f) => f.severity === 'critical')
  if (worst) console.error(`[self-ops]\n${report}`)
  else if (findings.length > 0) console.warn(`[self-ops]\n${report}`)
  return { findings, report }
}
