import { ShieldCheck, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { VERIFIED_CONNECTORS, verifiedConnectorToolId, type VerifiedConnector } from '@/lib/verified-connectors'
import { describeRecord, type ToolRecord } from '@/lib/tool-record'

/**
 * Handsel's own curated middle tier, between the graded receipts above it
 * and the passive ClawHub mirror below it on /directory.
 *
 * The distinction from both neighbours is the whole point: ClawHub below is
 * a MIRROR — somebody else's self-reported list, ranked by their stars. The
 * receipts above are EVIDENCE — whatever tools happened to get hired and
 * graded, ranked by outcome. This section is neither: it is Handsel's own
 * editorial claim, earned by an end-to-end probe run from this repo's own
 * client before an entry is added (`docs/office-connectors.md`), the same
 * shape as ClawHub's or skills-market's "curated, high-quality" pitch — but
 * grounded in a real test run rather than a submission form. A card here
 * also shows its live `ToolRecord` when one exists, so "we checked it works"
 * and "it has actually been graded N times" are never confused for the same
 * claim.
 */

function ConnectorCard({ connector, record }: { connector: VerifiedConnector; record: ToolRecord | null }) {
  return (
    <div className="flex flex-col rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold leading-snug">{connector.label}</h3>
        <span
          className="flex shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
          title={`probed end-to-end on ${connector.verifiedOn}`}
        >
          <ShieldCheck className="size-3" /> verified
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{connector.blurb}</p>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Probed {connector.verifiedOn} · {connector.mode === 'assisted' ? 'assisted mode (a worker reads and writes the result itself)' : 'proxy mode'}
      </p>
      {record && (
        <p className="mt-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
          On real paid jobs: {describeRecord(record)}
        </p>
      )}
    </div>
  )
}

export function VerifiedConnectorGrid({ records }: { records: readonly ToolRecord[] }) {
  const byToolId = new Map(records.map((r) => [r.toolId, r]))
  return (
    <section className="border-t border-border pt-8">
      <h2 className="text-lg font-semibold tracking-tight">Handsel&rsquo;s own verified connectors</h2>
      <p className="mt-2 max-w-[62ch] text-pretty text-sm leading-relaxed text-muted-foreground">
        A short, hand-probed list — each one actually called end-to-end from this repo&rsquo;s own MCP client before
        being listed here, not self-submitted. One click attaches any of these to one of your agents as a worker; the
        line under a card is its real graded-job record, once it has one.
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {VERIFIED_CONNECTORS.map((c) => {
          const id = verifiedConnectorToolId(c)
          const record = id ? (byToolId.get(id) ?? null) : null
          return <ConnectorCard key={c.id} connector={c} record={record} />
        })}
      </div>
      <Link
        href="/profile"
        className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        Sign in, then attach one from your agent&rsquo;s Runtime card <ArrowRight className="size-3.5" />
      </Link>
    </section>
  )
}
