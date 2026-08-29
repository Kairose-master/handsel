'use server'

/**
 * The lineage dry run, from the dashboard. Read-only by construction —
 * lib/agent-lineage-server.ts's report changes nothing, and there is
 * deliberately no action here that acts on it. Replication spends real USDC
 * and mints an on-chain account; retirement stops an agent its owner may
 * still want. Those get their own explicitly granted, revocable, budgeted
 * mandate, the way lib/office-automaton.ts did, and not before the rules
 * have been read against real data.
 */
import { getSession } from '@/lib/get-session'
import { buildLineageReport } from '@/lib/agent-lineage-server'
// The return type is NOT re-exported here: a 'use server' module turns a
// re-exported type into a runtime reference (tests/server-action-type-reexport
// guards this). Callers import LineageReport from '@/lib/agent-lineage', the
// pure module that declares it.
import type { LineageReport } from '@/lib/agent-lineage'

/** Whether this office's lineage mandate is on, and whether this deployment
 *  will honour it at all. The gate is reported separately from the switch on
 *  purpose: "you turned it on but this is a real-money deployment" and "it is
 *  off" are completely different facts, and collapsing them into one boolean
 *  is how someone concludes the feature is broken. */
export type LineageMandateView = {
  enabled: boolean
  /** False on a real-money deployment without the explicit env opt-in. */
  allowedHere: boolean
  realMoney: boolean
}

export async function myLineageMandate(slot: number): Promise<LineageMandateView> {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  const { getLineageMandate, lineageMandateAllowed } = await import('@/lib/lineage-mandate')
  const { isRealMoney } = await import('@/lib/onchain/real-money')
  const realMoney = isRealMoney()
  const [mandate] = await Promise.all([getLineageMandate(session.user.id, slot)])
  return {
    enabled: mandate?.enabled ?? false,
    allowedHere: lineageMandateAllowed({
      realMoney,
      allowRealMoneyEnv: process.env.LINEAGE_MANDATE_ALLOW_REAL_MONEY,
    }).allowed,
    realMoney,
  }
}

/** Grant or revoke this office's lineage mandate. Allowed to be set even
 *  where the deployment gate would refuse it — so an owner can configure the
 *  rehearsal and mainnet identically and let the gate, not their memory, be
 *  what stops it. */
export async function setMyLineageMandate(slot: number, enabled: boolean): Promise<{ ok: true }> {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  const { setLineageMandate } = await import('@/lib/lineage-mandate')
  await setLineageMandate(session.user.id, slot, enabled)
  return { ok: true }
}

/** What selection would do to my agents right now. `slot` scopes it to one
 *  office; omit for the whole account. */
export async function myLineageReport(slot?: number): Promise<LineageReport> {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return buildLineageReport(session.user.id, slot)
}
