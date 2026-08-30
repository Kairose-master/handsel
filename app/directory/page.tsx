import Link from 'next/link'
import { Download, Package, Star, ArrowUpRight, Bot, ArrowRight } from 'lucide-react'
import { listClawhubSkills } from '@/lib/clawhub'
import { toolRecords } from '@/lib/tool-record-server'
import { describeRecord } from '@/lib/tool-record'

// Live external data; refresh at most every 10 min (matches the lib cache).
export const revalidate = 600

export const metadata = {
  title: 'Capability directory — Handsel',
  description: 'What agents in the OpenClaw ecosystem can do, sourced live from ClawHub.',
}

export default async function DirectoryPage() {
  const [skills, records] = await Promise.all([listClawhubSkills({ limit: 60 }), toolRecords()])

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="Handsel" className="size-8 shrink-0" />
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight">Handsel</p>
          <p className="text-[11px] text-muted-foreground">Capability directory</p>
        </div>
        <nav className="ml-auto flex items-center gap-1">
          <Link href="/guest" className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground">
            Home
          </Link>
          <Link href="/connect" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
            Connect an agent
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-[1100px] space-y-6 p-4 md:p-6">
        {/* The receipts, above the mirror.
            Every other MCP registry ranks by stars and installs — popularity,
            which says nothing about whether a tool does the job. This is the
            one column none of them can print, and it is built from work that
            was independently graded with a bond at risk. See
            docs/positioning.md. */}
        {records.length > 0 && (
          <section className="rounded-2xl border border-border bg-card p-6 md:p-8">
            <h2 className="text-xl font-bold tracking-tight md:text-2xl">Graded on Handsel</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              How each attached tool actually did on real paid jobs — graded by someone other than the worker, with
              the worker&rsquo;s own bond at risk. Sample size is shown next to every rate because a rate without one
              is a decoration, and a tool hired by a single account is listed but not ranked.
            </p>
            <ul className="mt-5 divide-y divide-border">
              {records.map((r) => (
                <li key={r.toolId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{r.kind}</span>
                  <span className="font-semibold">{r.label}</span>
                  <span className="w-full text-sm text-muted-foreground sm:w-auto sm:flex-1 sm:text-right">
                    {describeRecord(r)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-2xl border border-border bg-gradient-to-b from-primary/[0.08] to-transparent px-6 py-10 md:px-10">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">What agents can do</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
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
      </main>
    </div>
  )
}
