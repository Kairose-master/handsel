'use client'

/**
 * The platform ledger.
 *
 * Three balances that had no shared surface: the uncollected protocol fee, the
 * house agent that fronts external escrow, and the x402 receiving address.
 * Nothing here signs anything — the fee key stays cold and its four manual
 * commands in docs/fee-withdrawal.md stay the only way to move it.
 *
 * A number that could not be read says so. It is never rendered as $0.00,
 * because on this page a zero is the alarm that external posting is about to
 * fail and a false one would train the reader to ignore the real one.
 */
import { useEffect, useState } from 'react'
import { PageHead, Panel, Readout, Chip } from '@/components/deck'
import { getPlatformTreasury } from '@/app/actions/platform-treasury'
import type { Treasury } from '@/lib/platform-treasury'

const money = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`)
const short = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—')

export default function PlatformTreasuryPage() {
  const [data, setData] = useState<Treasury | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getPlatformTreasury()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-5">
      <PageHead
        title="Platform ledger"
        subtitle="Where the platform's own money sits, read live. This page signs nothing — collecting the protocol fee is still four manual commands with a cold key, deliberately."
      />

      {loading ? (
        <p className="text-sm text-muted-foreground">Reading balances…</p>
      ) : error ? (
        <p className="text-sm text-[var(--destructive)]">{error}</p>
      ) : !data ? null : (
        <>
          {data.alerts.length > 0 && (
            <Panel title="Needs attention">
              <ul className="space-y-2">
                {data.alerts.map((a, i) => (
                  <li key={i} className="text-sm text-[var(--warning,orange)]">
                    {a}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="Balances">
            <ul className="divide-y divide-border">
              {data.balances.map((b) => (
                <li key={b.label} className="flex flex-wrap items-start gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-[16rem] flex-1">
                    <div className="text-sm font-medium">{b.label}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{b.hint}</div>
                    {b.unavailable && <div className="mt-1 text-xs text-[var(--warning,orange)]">Not read — {b.unavailable}</div>}
                  </div>
                  <Readout label="Address" value={<span className="font-mono text-xs">{short(b.address)}</span>} />
                  <Readout label="Balance" value={money(b.usd)} tone={b.usd === null ? 'idle' : 'ok'} />
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Market contract">
            <div className="flex flex-wrap gap-6">
              <Readout label="Owed to everyone" value={money(data.escrow.owedUsd)} hint="Open escrow plus credited-but-uncollected payouts." />
              <Readout label="Actually held" value={money(data.escrow.heldUsd)} />
              <Readout
                label="Surplus"
                value={money(data.escrow.surplusUsd)}
                tone={data.escrow.surplusUsd === null ? 'idle' : data.escrow.surplusUsd < 0 ? 'bad' : 'ok'}
                hint="Held minus owed. Negative means the contract cannot pay what it owes — that should be impossible."
              />
            </div>
          </Panel>

          <Panel title="External revenue">
            <div className="flex flex-wrap items-center gap-6">
              <Readout label="Charged to date" value={money(data.chargedUsd)} hint="From the x402 ledger — what was billed, not what is held." />
              <Readout label="Payments" value={data.chargedCount === null ? '—' : String(data.chargedCount)} />
              <Readout label="Collectable now" value={money(data.collectableUsd)} hint="The protocol fee credit. Pull, not push — see docs/fee-withdrawal.md." />
              <Chip tone="idle">read-only</Chip>
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}
