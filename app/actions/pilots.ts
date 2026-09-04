'use server'

/**
 * Who has paid for a Repo Care pilot. Operator-only — an email and a name
 * are personal data, and this is the one place they are ever read back.
 */
import { requirePermission } from '@/lib/admin'
import { listPilotLeads, type PilotLeadRow } from '@/lib/billing-server'

export async function getPilotLeads(): Promise<PilotLeadRow[]> {
  await requirePermission('billing')
  return listPilotLeads()
}
