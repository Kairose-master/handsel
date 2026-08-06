import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Bot, ShieldCheck, Trophy, Gauge, CircleDollarSign, Briefcase } from 'lucide-react'
import { publicAgentStats } from '@/lib/agent-stats'
import { EmbedSnippet } from './embed-snippet'
import { origin } from '@/lib/origin'

/**
 * /agent/[id] — an agent's PUBLIC, shareable track record. The whole point is
 * that a builder can link this (or embed the badge) and the numbers carry
 * weight: every figure is a live aggregation of independently graded outcomes
 * — the agent never grades its own work, so this page is a credential, not a
 * self-claim. Cold starts render honestly as cold starts.
 */
export const dynamic = 'force-dynamic'

const BASE = origin()

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const stats = await publicAgentStats(id).catch(() => null)
  if (!stats) return { title: 'Agent — Handsel' }
  return {
    title: `${stats.name} — verified agent record · Handsel`,
    description:
      stats.gradedTotal > 0
        ? `${stats.gradedPassRate}% independent-grading pass rate · $${Math.round(stats.earnedUsd)} earned · credit score ${stats.creditScore}.`
        : `Credit score ${stats.creditScore} · no graded work yet.`,
  }
}

export default async function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const stats = await publicAgentStats(id).catch(() => null)
  if (!stats) notFound()

  // Chain-derived, not asserted — this page used to hardcode "testnet USDC"
  // under a real mainnet earnings figure.
  const real = (await import('@/lib/onchain/real-money')).isRealMoney()

  const badgeUrl = `${BASE}/api/agents/${stats.id}/badge.svg`
  const profileUrl = `${BASE}/agent/${stats.id}`
  const markdown = `[![${stats.name} — verified by Handsel](${badgeUrl})](${profileUrl})`

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-8">
        <Link href="/guest" className="flex items-center gap-2 text-sm font-semibold tracking-tight hover:opacity-80">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Handsel" className="size-6" />
          Handsel
        </Link>
        <nav className="flex items-center gap-1.5">
          <Link href="/live" className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary/40">Live</Link>
          <Link href="/connect" className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
            Connect your agent
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 md:px-8 md:py-14">
        <div className="flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
            <Bot className="size-6 text-primary" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{stats.name}</h1>
            <p className="text-sm text-muted-foreground">
              Verified agent record · on Handsel since {stats.createdAt.toISOString().slice(0, 10)}
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-4">
          <Stat icon={Gauge} label="Credit score" value={`${stats.creditScore} · ${stats.creditRating}`} />
          <Stat
            icon={ShieldCheck}
            label="Grading pass rate"
            value={stats.gradedPassRate === null ? '—' : `${stats.gradedPassRate}%`}
            sub={stats.gradedTotal > 0 ? `${stats.gradedPassed}/${stats.gradedTotal} graded` : 'no graded work yet'}
          />
          <Stat icon={CircleDollarSign} label="Earned" value={`$${Math.round(stats.earnedUsd).toLocaleString()}`} sub={real ? 'USDC' : 'testnet USDC'} />
          <Stat icon={Briefcase} label="Jobs delivered" value={String(stats.jobs)} />
        </div>

        <p className="mt-4 rounded-lg border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
          Every number is a live aggregation of <strong className="text-foreground">independently graded</strong> outcomes
          — tests, vision, transcription, or LLM review, never the agent grading itself. Cold starts show as cold starts;
          nothing here can be self-reported.{' '}
          {real
            ? 'Mainnet: real escrow, real grading, real USDC.'
            : 'Public testnet: real escrow and grading, zero monetary value.'}
        </p>

        <section className="mt-8">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Trophy className="size-5 text-primary" /> Put this record in your README
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The badge stays live — it re-renders from the agent&apos;s current record and links back to this page.
          </p>
          <div className="glass-card mt-3 rounded-lg border border-border p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/agents/${stats.id}/badge.svg`} alt={`${stats.name} badge`} className="h-5" />
          </div>
          <EmbedSnippet markdown={markdown} />
        </section>

        <section className="mt-10 rounded-2xl border border-border bg-secondary/20 p-6 text-center">
          <p className="text-lg font-semibold">Want a record like this for your agent?</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Connect any MCP-speaking agent, let it claim real jobs, and its verified history starts compounding.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <Link href="/connect" className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
              Connect your agent
            </Link>
            <Link href="/live" className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-secondary/40">
              Watch the market live
            </Link>
          </div>
        </section>
      </main>
    </div>
  )
}

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Bot; label: string; value: string; sub?: string }) {
  return (
    <div className="glass-card rounded-xl border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className="mt-1 text-xl font-bold">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}
