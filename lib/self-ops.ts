/**
 * Self-ops — the platform noticing its own operational failures.
 *
 * Born from one live diagnosis (2026-08-31): the settlement heartbeat had
 * been green for 950 consecutive runs while never once calling the endpoint
 * (unconfigured skip, `docs/failure-modes.md`'s "a check that cannot fail is
 * not a check" again, one level up), the oracle wallet couldn't top up a
 * newly registered worker, and every storefront reported closed — and each
 * of those was discovered BY A PERSON reading logs, weeks late. This module
 * is those checks as code.
 *
 * Split, and why it matters:
 *
 *  - This file is PURE: a vitals snapshot in, findings out. Every threshold
 *    is testable without a database or a chain.
 *  - `lib/self-ops-server.ts` collects the snapshot and runs on the ops
 *    cycle's **fast (traffic-driven) subset** — deliberately NOT only the
 *    cron: a dead heartbeat cannot report itself from inside the heartbeat.
 *    Any visitor request can surface "the full cycle has not run for hours",
 *    which is the one finding the cron could never deliver.
 *
 * Findings report; they never fix. Every fix here is an operator action
 * (set a secret, fund a wallet, open a desk), and a sweep that "helpfully"
 * moved money or flipped config on its own would be a bigger defect than
 * any it detects.
 */

/**
 * Pure: does this failure text mean THE KEY is unusable — billing or auth —
 * rather than one bad request? A 429 or a timeout is a moment; a dead key is
 * a state, and only a state belongs in a standing finding. Lives here (not
 * in lib/model-key-health.ts, which records the outcomes) so this module
 * stays importable with no database behind it.
 */
export function isKeyDeadReason(reason: string | null | undefined): boolean {
  if (!reason) return false
  return /credit balance|billing|authentication_error|invalid x-api-key|api key|401/i.test(reason)
}

export type PlatformVitals = {
  /** ms epoch. */
  now: number
  /** When the last FULL ops cycle started (ms epoch), or null when no full
   *  cycle has ever been observed / the lease table is unreadable. */
  lastFullCycleAt: number | null
  /** Oracle wallet balance in wei; null = unreadable or not configured. */
  oracleWei: bigint | null
  /** Whether on-chain agent accounts are configured at all — with no oracle
   *  key there is nothing to measure, not a dry wallet. */
  onchainConfigured: boolean
  /** Open storefront count; null = unreadable. */
  openStorefronts: number | null
  realMoney: boolean
  /** Last recorded platform LLM call (lib/model-key-health.ts); null = no
   *  call recorded yet or unreadable. */
  modelCall: { ok: boolean; reason: string | null; at: number } | null
  /** cloud/mcp tasks sitting 'running' past the point their own dispatch
   *  timeout could explain (see STUCK_DISPATCH_AGE_MS); null = unreadable.
   *  This is the observable shape of every callback-death mode found on
   *  2026-08-31 (§60): a shared budget killing dispatches, an edge 401
   *  eating callbacks — from outside they are all "running forever". */
  stuckDispatchTasks: number | null
}

export type SelfOpsSeverity = 'critical' | 'warning' | 'notice'

export type SelfOpsFinding = {
  id:
    | 'heartbeat-never'
    | 'heartbeat-stale'
    | 'oracle-dry'
    | 'oracle-low'
    | 'storefront-all-closed'
    | 'model-key-dead'
    | 'dispatches-vanishing'
  severity: SelfOpsSeverity
  /** One sentence: what is wrong AND the operator action that fixes it. */
  detail: string
}

/** The full cycle is scheduled every 5 minutes; six missed beats is a
 *  pattern, not a blip. */
export const HEARTBEAT_STALE_MS = 30 * 60_000

/** Past a cloud/mcp dispatch's own 4-minute external-call bound plus
 *  generous grading/callback time — a task 'running' this long has lost its
 *  execution, not merely a slow one. */
export const STUCK_DISPATCH_AGE_MS = 15 * 60_000
/** One stuck task is a recycled function; this many at once is systemic. */
export const STUCK_DISPATCH_ALARM_COUNT = 3

/** One `AGENT_GAS_TOPUP` (lib/onchain/account.ts) — below this the oracle
 *  cannot fund even one new agent's first transaction. */
export const ORACLE_DRY_WEI = 200_000_000_000_000n // 0.0002 ETH
/** Ten top-ups of headroom. */
export const ORACLE_LOW_WEI = 2_000_000_000_000_000n // 0.002 ETH

export function detectSelfOpsFindings(v: PlatformVitals): SelfOpsFinding[] {
  const findings: SelfOpsFinding[] = []

  if (v.lastFullCycleAt === null) {
    findings.push({
      id: 'heartbeat-never',
      severity: 'critical',
      detail:
        'No full ops cycle has ever been observed — delegation ticks, grading and lineage run there or nowhere. ' +
        'Check CRON_SECRET on the deployment and CRON_SECRET + PLATFORM_URL in the GitHub Actions repo settings.',
    })
  } else if (v.now - v.lastFullCycleAt > HEARTBEAT_STALE_MS) {
    const mins = Math.round((v.now - v.lastFullCycleAt) / 60_000)
    findings.push({
      id: 'heartbeat-stale',
      severity: 'critical',
      detail:
        `The full ops cycle last ran ${mins} minutes ago (scheduled every 5) — pipelines are stalling. ` +
        'Check the Vercel cron and the settle-heartbeat workflow secrets; a green workflow run of ~7 seconds is an unconfigured skip, not a beat.',
    })
  }

  if (v.onchainConfigured && v.oracleWei !== null) {
    if (v.oracleWei < ORACLE_DRY_WEI) {
      findings.push({
        id: 'oracle-dry',
        severity: 'critical',
        detail:
          'The oracle wallet cannot fund even one agent gas top-up — newly registered workers fail their first ' +
          'transaction and disputes cannot be resolved. Send ETH to the oracle address.',
      })
    } else if (v.oracleWei < ORACLE_LOW_WEI) {
      findings.push({
        id: 'oracle-low',
        severity: 'warning',
        detail: 'The oracle wallet is under ten gas top-ups of headroom — top it up before it decides an outcome.',
      })
    }
  }

  // Only a key-shaped failure (billing/auth — a STATE) alarms; a 429 or a
  // timeout is a moment and stays out of standing findings. Found live: the
  // heartbeat was healthy and every grading died on "credit balance is too
  // low" while this module said "all clear" — the exact silent-inert failure
  // this file exists to name.
  if (v.modelCall && !v.modelCall.ok && isKeyDeadReason(v.modelCall.reason)) {
    findings.push({
      id: 'model-key-dead',
      severity: 'critical',
      detail:
        'The platform model key is unusable — grading, assisted MCP writes and auto-replies all silently fail. ' +
        `Last error: "${(v.modelCall.reason ?? '').slice(0, 160)}". Top up API credits or replace the key.`,
    })
  }

  // A cloud/mcp dispatch bounds its own external call at 4 minutes and posts
  // a callback either way — success or a recorded failure. One task past 15
  // minutes is a recycled function (reapStuckTasks owns it); SEVERAL at once
  // is the systemic shape of 2026-08-31 (§60): dispatches dying with a
  // shared budget, or callbacks eaten by an edge auth wall. Nobody inside
  // the dead invocations can report it, which is why this sweep must.
  if (v.stuckDispatchTasks !== null && v.stuckDispatchTasks >= STUCK_DISPATCH_ALARM_COUNT) {
    findings.push({
      id: 'dispatches-vanishing',
      severity: 'critical',
      detail:
        `${v.stuckDispatchTasks} cloud/mcp dispatches have been 'running' with no callback for over ` +
        `${Math.round(STUCK_DISPATCH_AGE_MS / 60_000)} minutes — dispatch executions are dying without reporting. ` +
        'Check /api/runtime/execute reachability (an edge 401 means a protected host in a callback URL) and the runtime logs for the last sweep.',
    })
  }

  // Notice, not warning: closing every desk is a legitimate operator choice.
  // The finding exists because "deployed" quietly read as "open for business"
  // for months while every template reported closed (docs/office.md).
  if (v.openStorefronts === 0) {
    findings.push({
      id: 'storefront-all-closed',
      severity: 'notice',
      detail:
        'Every storefront is closed — nothing on this deployment is buyable, so zero orders is a fact about ' +
        'availability, not demand. Open one with set_storefront if that is unintended.',
    })
  }

  return findings
}

/** One log line per finding, worst first — what the ops report carries. */
export function formatSelfOpsReport(findings: SelfOpsFinding[]): string {
  if (findings.length === 0) return 'all clear'
  const order: Record<SelfOpsSeverity, number> = { critical: 0, warning: 1, notice: 2 }
  return [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((f) => `[${f.severity}] ${f.id}: ${f.detail}`)
    .join('\n')
}
