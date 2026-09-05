'use client'

/**
 * Who has paid for a Repo Care pilot, and who is on a recurring office
 * subscription (`docs/billing.md`).
 *
 * This page reads `pilot_lead` and `office_subscription`, which Lemon
 * Squeezy's webhook writes — onboarding the person listed here, and wiring
 * a subscriber's plan limits to their actual account, is still a human's
 * job (`lib/billing.ts`'s `repoCareWithinTierLimits` is pure and unwired
 * for exactly that reason).
 */
import { useEffect, useState } from 'react'
import { PageHead, Panel, Chip } from '@/components/deck'
import { getOfficeSubscriptions, getPilotLeads } from '@/app/actions/pilots'
import type { OfficeSubscriptionRow, PilotLeadRow } from '@/lib/billing-server'

const when = (ms: number) => new Date(ms).toLocaleString()

export default function PilotsAdminPage() {
  const [leads, setLeads] = useState<PilotLeadRow[] | null>(null)
  const [subs, setSubs] = useState<OfficeSubscriptionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getPilotLeads()
      .then(setLeads)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    getOfficeSubscriptions()
      .then(setSubs)
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

      <PageHead
        title="Office subscriptions"
        subtitle="Everyone on a recurring plan (lib/billing.ts's OFFICE_SUBSCRIPTION_TIERS), newest event first. Plan limits are not yet wired to any account."
      />

      {!error && subs === null && <p className="text-sm text-muted-foreground">Reading…</p>}
      {subs && subs.length === 0 && <p className="text-sm text-muted-foreground">No subscription yet.</p>}

      {subs && subs.length > 0 && (
        <Panel>
          <div className="divide-y divide-border">
            {subs.map((s) => (
              <div key={s.subscriptionId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <div className="font-medium">
                    {s.email} {s.testMode && <Chip tone="warn">test mode</Chip>}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {s.tierId ?? s.variantName ?? 'unknown plan'} · {s.status}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    subscription {s.subscriptionId} · updated {when(s.updatedAt)}
                    {s.renewsAt ? ` · renews ${when(s.renewsAt)}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}
