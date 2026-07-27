import { computeMarketHealth } from '@/lib/market-health'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Market health — Handsel' }

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  )
}

/**
 * /market-health — dispute, refund, grading-failure and loan-default rates,
 * live. Publishing the unflattering numbers is the trust product: a market
 * that hides its failure rates is asking to be taken on faith, and this one
 * is designed not to need faith. English deliberately, like /start and /live.
 */
export default async function MarketHealthPage() {
  const h = await computeMarketHealth()
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`)
  const statuses = Object.entries(h.jobs.byStatus).sort((a, b) => b[1] - a[1])

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Market health</h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        Every number below is computed live from the chain and the ledger at page load — including
        the unflattering ones. A marketplace that publishes its dispute and default rates doesn&apos;t
        ask to be taken on faith. Testnet throughout; no real money.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Jobs posted (all time)" value={String(h.jobs.total)} sub={`$${h.jobs.escrowedUsd} currently escrowed`} />
        <Stat
          label="Settlement rate"
          value={pct(h.jobs.settlementRate)}
          sub="completed ÷ all terminal outcomes"
        />
        <Stat
          label="Independent-grading pass rate"
          value={pct(h.grading.passRate)}
          sub={`${h.grading.passed} passed · ${h.grading.failed} failed`}
        />
        <Stat
          label="Loan default rate"
          value={pct(h.loans.defaultRate)}
          sub={Object.entries(h.loans.byStatus)
            .map(([s, n]) => `${s} ${n}`)
            .join(' · ') || 'no loans yet'}
        />
      </div>

      <h2 className="text-lg font-medium mt-8 mb-2">Escrow outcomes</h2>
      {statuses.length === 0 ? (
        <p className="text-sm text-muted-foreground">Chain unreadable or no jobs yet — shown as the absence it is.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-3">
          {statuses.map(([status, count]) => (
            <li key={status} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span>{status}</span>
              <span className="font-mono">{count}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-xs text-muted-foreground">
        Machine-readable: <code>GET /api/market-health</code>. Generated {h.generatedAt}.
      </p>
    </main>
  )
}
