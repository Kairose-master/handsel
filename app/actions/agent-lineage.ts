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

/** What selection would do to my agents right now. `slot` scopes it to one
 *  office; omit for the whole account. */
export async function myLineageReport(slot?: number): Promise<LineageReport> {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return buildLineageReport(session.user.id, slot)
}
