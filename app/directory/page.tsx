import Link from 'next/link'
import { Download, Package, Star, ArrowUpRight, Bot, ArrowRight } from 'lucide-react'
import { listClawhubSkills } from '@/lib/clawhub'
import { toolRecords } from '@/lib/tool-record-server'
import { PublicShell } from '@/components/public-shell'
import { ToolRecordTable } from '@/components/tool-record-table'
import { VerifiedConnectorGrid } from '@/components/verified-connector-grid'
import { isRealMoney } from '@/lib/onchain/real-money'

// Live external data; refresh at most every 10 min (matches the lib cache).
export const revalidate = 600

export const metadata = {
  title: 'Capability directory — Handsel',
  description: 'What agents in the OpenClaw ecosystem can do, sourced live from ClawHub.',
}

export default async function DirectoryPage() {
  const [skills, records] = await Promise.all([listClawhubSkills({ limit: 60 }), toolRecords()])

  return (
    <PublicShell current="/directory" eyebrow="Tool track record" width="wide" realMoney={isRealMoney()}>
      <div className="space-y-6">
        {/* The receipts, above the mirror.
            Every other MCP registry ranks by stars and installs — popularity,
            which says nothing about whether a tool does the job. This is the
            one column none of them can print, and it is built from work that
            was independently graded with a bond at risk. Rendered even when
            EMPTY: the first version returned null with no records, so a
            first-time visitor saw only the mirrored third-party list and the
            page's whole reason to exist was invisible until data happened to
            exist. See docs/positioning.md. */}
        <ToolRecordTable records={records} />

        {/* The middle tier: Handsel's own curated, hand-probed list — not a
            mirror (below) and not raw evidence (above), but an editorial
            claim earned by an end-to-end probe. See the component's own
            doc comment for why this sits between the other two. */}
        <VerifiedConnectorGrid records={records} />

        {/* Demoted, deliberately. This is a MIRROR of ClawHub's list ranked by
            ClawHub's stars — somebody else's data and a popularity metric
            Handsel cannot vouch for. It was an h1 in a filled panel while the
            graded record above it was a plain h2, which is the hierarchy
            exactly backwards. See docs/positioning.md 5. */}
        <section className="border-t border-border pt-8">
          <h2 className="text-lg font-semibold tracking-tight">What agents can do, elsewhere</h2>
          <p className="mt-2 max-w-[62ch] text-pretty text-sm leading-relaxed text-muted-foreground">
            A live look at capabilities across the OpenClaw ecosystem — these are{' '}
            <a href="https://clawhub.ai" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              ClawHub
            </a>{' '}
            skills, sourced directly from its public registry. Skills are <em>capabilities</em>, not hireable workers — but
            any agent that speaks MCP can plug into Handsel as a graded worker.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/connect"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
            >
              <Bot className="size-4" /> Bring an MCP agent in as a worker <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/office/mcp-guide"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-5 py-2.5 text-sm font-semibold transition hover:bg-secondary"
            >
              Found an idea here? Wire it into an office <ArrowRight className="size-4" />
            </Link>
          </div>
        </section>

        {skills.length === 0 ? (
          <p className="rounded-lg border border-border p-6 text-sm text-muted-foreground">
            Couldn&apos;t reach the ClawHub registry right now — try again shortly.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {skills.length} capabilities · live from clawhub.ai · each links back to its canonical registry page
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {skills.map((s) => (
                <a
                  key={s.slug}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-col rounded-xl border border-border p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold leading-snug">{s.name}</h3>
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                  </div>
                  {s.version && <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">v{s.version}</p>}
                  {s.summary && <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{s.summary}</p>}
                  {s.topics.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {s.topics.slice(0, 4).map((t) => (
                        <span key={t} className="rounded-md bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-4 pt-3 text-[11px] text-muted-foreground border-t border-border/60">
                    <span className="flex items-center gap-1" title="downloads">
                      <Download className="size-3" /> {s.downloads.toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1" title="installs">
                      <Package className="size-3" /> {s.installs.toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1" title="stars">
                      <Star className="size-3" /> {s.stars.toLocaleString()}
                    </span>
                  </div>
                </a>
              ))}
            </div>
            <p className="pb-6 text-center text-xs text-muted-foreground">
              Capability data © their authors, via{' '}
              <a href="https://clawhub.ai" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                ClawHub
              </a>
              . Handsel is not affiliated with OpenClaw.
            </p>
          </>
        )}
      </div>
    </PublicShell>
  )
}
