'use client'

/**
 * Who has paid for a Repo Care pilot (`docs/billing.md`).
 *
 * This page reads `pilot_lead`, which Lemon Squeezy's webhook writes —
 * onboarding the person listed here is still a human's job (an email, a
 * repo connect, a live watch of the first night), the "still owed" piece
 * `docs/positioning.md` §8 named on purpose rather than guessed at.
 */
import { useEffect, useState } from 'react'
import { PageHead, Panel, Chip } from '@/components/deck'
import { getPilotLeads } from '@/app/actions/pilots'
import type { PilotLeadRow } from '@/lib/billing-server'

const when = (ms: number) => new Date(ms).toLocaleString()

export default function PilotsAdminPage() {
  const [leads, setLeads] = useState<PilotLeadRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getPilotLeads()
      .then(setLeads)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <div className="space-y-5">
      <PageHead
        title="Pilot leads"
        subtitle="Everyone who has paid for the Repo Care pilot (lib/billing-server.ts), newest first. Onboarding each one is still by hand."
      />

      {error && <p className="text-sm text-[var(--destructive)]">{error}</p>}
      {!error && leads === null && <p className="text-sm text-muted-foreground">Reading…</p>}
      {leads && leads.length === 0 && <p className="text-sm text-muted-foreground">No pilot has been bought yet.</p>}

      {leads && leads.length > 0 && (
        <Panel>
          <div className="divide-y divide-border">
            {leads.map((l) => (
              <div key={l.orderId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <div className="font-medium">
                    {l.name ?? l.email} {l.testMode && <Chip tone="warn">test mode</Chip>}
                  </div>
                  <div className="text-sm text-muted-foreground">{l.email}</div>
                  <div className="text-xs text-muted-foreground">order {l.orderId} · {when(l.createdAt)}</div>
                </div>
                <div className="text-right font-medium">${l.totalUsd.toFixed(2)}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}
