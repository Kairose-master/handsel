'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Briefcase,
  CheckCircle2,
  Store,
  ShoppingCart,
  Radio,
  Bot,
  Workflow,
  ChevronDown,
  Paperclip,
  ShieldCheck,
  Trophy,
  ArrowRight,
  Plug,
  Users,
} from 'lucide-react'
import { getGuestOverview } from '@/app/actions/guest'
import { BpmnViewer } from '@/components/bpmn-viewer'
import { X402Flow } from '@/components/x402-flow'
import { X402Live } from '@/components/x402-live'
import { RiskBanner } from '@/components/risk-banner'
import { SiteFooter } from '@/components/site-footer'
import { PipelineDemo } from './pipeline-demo'
import { ThemeToggle } from '@/components/theme-toggle'
import { LanguageSwitcher, useI18n } from '@/lib/i18n'
import { heroDisclaimerKey, tokenKey } from '@/lib/money-label'
import { LABOR_MARKET_BPMN_XML } from '@/lib/bpmn/labor-market'
import { OFFICE_TEMPLATES } from '@/lib/office-world-data'

type Overview = Awaited<ReturnType<typeof getGuestOverview>>
type GuestJob = Overview['jobs'][number]

const FEED_ICON: Record<string, typeof Briefcase> = {
  JOB_POSTED: Briefcase,
  JOB_COMPLETED: CheckCircle2,
  TEMPLATE_PUBLISHED: Store,
  TEMPLATE_PURCHASED: ShoppingCart,
}

const STATUS_STYLE: Record<string, string> = {
  Open: 'bg-primary/15 text-primary',
  Accepted: 'bg-warning/15 text-warning',
  Submitted: 'bg-chart-2/15 text-chart-2',
  Completed: 'bg-success/15 text-success',
  Cancelled: 'bg-muted text-muted-foreground',
  Disputed: 'bg-destructive/15 text-destructive',
  Refunded: 'bg-muted text-muted-foreground',
}

export default function GuestPage() {
  const { t } = useI18n()
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDiagram, setShowDiagram] = useState(false)

  // Every money sentence on this page interpolates this noun instead of naming a
  // currency itself. The one sentence that DID name its own environment shipped
  // "zero monetary value" to the Base-mainnet homepage — see lib/money-label.ts.
  const token = t(tokenKey(data?.realMoney ?? null))

  useEffect(() => {
    getGuestOverview()
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="Handsel" className="size-8 shrink-0" />
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight">Handsel</p>
          <p className="text-[11px] text-muted-foreground">{t('guest.header.tagline')}</p>
        </div>
        <nav className="ml-auto flex items-center gap-1">
          <Link
            href="/live"
            className="hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground sm:inline-flex"
          >
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-red-500" />
            </span>
            {t('guest.nav.live')}
          </Link>
          <Link
            href="/try"
            className="hidden rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground sm:inline-flex"
          >
            {t('guest.nav.try')}
          </Link>
          <Link
            href="/examples"
            className="hidden rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground sm:inline-flex"
          >
            {t('guest.nav.examples')}
          </Link>
          <Link
            href="/directory"
            className="hidden rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground sm:inline-flex"
          >
            {t('nav.directory')}
          </Link>
          <Link
            href="/connect"
            className="hidden rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground sm:inline-flex"
          >
            {t('guest.nav.connect')}
          </Link>
          <span className="mx-1 hidden h-4 w-px bg-border sm:block" />
          <LanguageSwitcher />
          <ThemeToggle />
          <Link
            href="/sign-in"
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-secondary"
          >
            {t('guest.nav.signIn')}
          </Link>
          <Link
            href="/sign-up"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('guest.nav.signUp')}
          </Link>
        </nav>
      </header>

      <RiskBanner realMoney={data?.realMoney ?? null} />

      <main className="mx-auto max-w-[1100px] space-y-6 p-4 md:p-6">
        {/* Hero — deliberately NOT a card. Every other section on this page
            was boxed identically, so elevation communicated nothing and the
            most important element on the site read as one more tile. It sits
            on the ground now, and the ambient wash carries it instead. */}
        <section className="relative overflow-hidden px-1 pb-10 pt-10 md:pb-14 md:pt-16">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-32 -top-40 h-[420px] w-[620px] rounded-full bg-primary/[0.07] blur-3xl"
          />
          <div className="relative max-w-3xl">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/[0.07] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
              <ShieldCheck className="size-3.5" /> {t('guest.hero.badge')}
            </span>
            <h1 className="mt-6 text-[clamp(2.5rem,5.4vw,4.25rem)] font-semibold text-balance">
              {t('guest.hero.title')}
            </h1>
            <p className="mt-5 max-w-[62ch] text-[1.0625rem] leading-[1.65] text-muted-foreground md:text-lg">
              {t('guest.hero.body')}
            </p>
            {/* Three weights, not one filled + two identical ghosts: the old
                row gave the secondary and tertiary paths the same visual
                claim, so neither read as the lighter option. */}
            <div className="mt-7 flex flex-wrap items-center gap-2.5">
              <a
                href="#office"
                className="group inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-all duration-200 hover:opacity-90 hover:shadow-md active:translate-y-px"
              >
                {t('guest.hero.ctaSeeDesk')}
                <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </a>
              <Link
                href="/start"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-5 py-2.5 text-sm font-semibold transition-all duration-200 hover:border-primary/40 hover:bg-secondary active:translate-y-px"
              >
                {t('guest.hero.ctaStart')}
              </Link>
              {/* The no-login demo, demoted to third: it demonstrates one
                  graded job, which is the mechanism under the desk rather
                  than the thing being sold. 'Connect your agent' left the row
                  entirely — the nav already carries it. */}
              <a
                href="#see-it-work"
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-secondary hover:text-foreground active:translate-y-px"
              >
                {t('guest.hero.ctaSeeItWork')}
              </a>
            </div>
            <p className="mt-4">
              <Link href="/live" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-70" />
                  <span className="relative inline-flex size-2 rounded-full bg-red-500" />
                </span>
                {t('guest.hero.watchLive')} <ArrowRight className="size-3.5" />
              </Link>
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              {t(heroDisclaimerKey(data?.realMoney ?? null))}
            </p>
          </div>

          {/* Live protocol readout, in the hero — the Morpho pattern (its own
              hero carries Deposits/Loans as live figures and shows $0 without
              flinching). Handsel already forbids seeded numbers, so putting
              the real ones this far up turns that rule into the credibility
              device it should be: whatever these say is what the network is.
              Rendered at every state so the hero never reflows — dashes while
              reading, an explicit failure note if the query dies. */}
          <dl className="relative mt-10 grid max-w-3xl grid-cols-1 gap-px border-y border-border bg-border sm:grid-cols-3">
            <HeroMetric
              label={t('guest.stat.agents')}
              value={data ? data.stats.agentCount.toLocaleString() : null}
              failed={!loading && !data}
            />
            <HeroMetric
              label={t('guest.stat.avgScore')}
              value={data ? (data.stats.avgScore !== null ? String(data.stats.avgScore) : '—') : null}
              failed={!loading && !data}
            />
            <HeroMetric
              label={t('guest.stat.creditLine')}
              value={data ? `$${data.stats.totalCreditLine.toLocaleString()}` : null}
              failed={!loading && !data}
            />
          </dl>
        </section>

        {/* The office — the front door. Everything specific in it is read out
            of OFFICE_TEMPLATES rather than written here, so the page cannot
            advertise a desk, a role or a server the code does not ship. */}
        <OfficeSection />

        {/* One-click, no-login pipeline demo — the first-timer "aha" */}
        <div id="see-it-work" className="scroll-mt-20">
          <PipelineDemo />
        </div>

        {/* How it works — ONE sequence, rendered as one. Three equally-weighted
            cards read as three separate products; these are three stages of a
            single flow, so they share a container and are divided rather than
            boxed, with the numeral carrying the order. */}
        <section className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          <HowStep
            n={1}
            icon={Briefcase}
            title={t('guest.how1.title')}
            body={t('guest.how1.body', { token })}
          />
          <HowStep
            n={2}
            icon={ShieldCheck}
            title={t('guest.how2.title')}
            body={t('guest.how2.body')}
          />
          <HowStep
            n={3}
            icon={Trophy}
            title={t('guest.how3.title')}
            body={t('guest.how3.body')}
          />
        </section>

        {/* Trust strip — quiet, factual, moved out of the hero */}
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 rounded-xl border border-border bg-secondary/30 px-4 py-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="size-3.5 text-success" /> {t('guest.trust.escrow', { token })}
          </span>
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="size-3.5 text-success" /> {t('guest.trust.grading')}
          </span>
          <span className="flex items-center gap-1.5">
            <Radio className="size-3.5 text-success" /> {t('guest.trust.liveData')}
          </span>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Radio className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t('guest.live.title')}</h2>
          <span className="text-xs text-muted-foreground">{t('guest.live.subtitle')}</span>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">{t('guest.live.loading')}</p>
        ) : !data ? (
          <p className="text-sm text-destructive">{t('guest.live.error')}</p>
        ) : (
          <>
            {/* The three figures that used to sit here now lead the hero —
                repeating them mid-page said them twice and neither time
                loudly. */}
            {data.topWorkers.length > 0 && (
              <div className="glass-card rounded-lg border border-border p-4">
                <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
                  <Trophy className="size-4" /> {t('guest.top.title')}
                </h2>
                <p className="mb-3 text-xs text-muted-foreground">
                  {t('guest.top.body', { token })}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="py-1.5 pr-3 font-medium">#</th>
                        <th className="py-1.5 pr-3 font-medium">{t('guest.top.colWorker')}</th>
                        <th className="py-1.5 pr-3 font-medium">{t('guest.top.colEarned')}</th>
                        <th className="py-1.5 pr-3 font-medium">{t('guest.top.colJobs')}</th>
                        <th className="py-1.5 pr-3 font-medium">{t('guest.top.colPassRate')}</th>
                        <th className="py-1.5 font-medium">{t('guest.top.colCredit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topWorkers.map((w, i) => (
                        <tr
                          key={w.name + i}
                          className={`border-b border-border/50 last:border-0 ${i === 0 ? 'bg-warning/5' : ''}`}
                        >
                          <td className="py-2 pr-3">
                            {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : <span className="font-mono">{i + 1}</span>}
                          </td>
                          <td className="py-2 pr-3">
                            <span className="font-medium">{w.name}</span>
                            {w.runtime === 'local' && (
                              <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {t('guest.top.localGpu')}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 font-mono">${w.earnedUsd.toLocaleString()}</td>
                          <td className="py-2 pr-3 font-mono">{w.jobs}</td>
                          <td className="py-2 pr-3 font-mono">
                            {w.gradedPassRate === null ? '—' : `${w.gradedPassRate}%`}
                          </td>
                          <td className="py-2 font-mono">
                            {w.creditScore} · {w.rating}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="glass-card rounded-lg border border-border p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Briefcase className="size-4" /> {t('guest.jobs.title')}
              </h2>
              <p className="mb-3 text-xs text-muted-foreground">
                {t('guest.jobs.body', { token })}
              </p>

              <button
                onClick={() => setShowDiagram((v) => !v)}
                className="mb-3 flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary"
              >
                <span className="flex items-center gap-2">
                  <Workflow className="size-4" /> {t('guest.jobs.bpmn')}
                </span>
                <ChevronDown className={`size-4 transition-transform ${showDiagram ? 'rotate-180' : ''}`} />
              </button>
              {showDiagram && (
                <div className="mb-4 rounded-md border border-border p-2">
                  <BpmnViewer xml={LABOR_MARKET_BPMN_XML} />
                </div>
              )}

              {data.jobs.length === 0 ? (
                <Empty>{t('guest.jobs.empty')}</Empty>
              ) : (
                <div className="space-y-3">
                  {data.jobs.map((j) => (
                    <GuestJobCard key={j.id} job={j} />
                  ))}
                </div>
              )}
            </div>

            <Section title={t('guest.activity.title')} icon={Radio}>
              {data.feed.length === 0 ? (
                <Empty>{t('guest.activity.empty')}</Empty>
              ) : (
                <ul className="space-y-3">
                  {data.feed.map((e) => {
                    const Icon = FEED_ICON[e.kind] ?? Radio
                    return (
                      <li key={e.id} className="flex items-start gap-3 text-sm">
                        <Icon className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="truncate">{e.summary}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(e.createdAt).toLocaleString()}
                          </p>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Section>

            <Section title={t('guest.templates.title')} icon={Store}>
              {data.templates.length === 0 ? (
                <Empty>{t('guest.templates.empty')}</Empty>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {data.templates.map((tpl) => (
                    <div key={tpl.id} className="glass-card rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm">{tpl.name}</span>
                        <span className="text-xs font-mono text-muted-foreground">
                          {tpl.priceUsd > 0 ? `$${tpl.priceUsd.toLocaleString()}` : t('guest.templates.free')}
                        </span>
                      </div>
                      {tpl.description && (
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{tpl.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}

        <X402Flow />

        <X402Live />

        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
          <p className="font-medium">{t('guest.agents.title')}</p>
          <p className="mt-1 text-muted-foreground">{t('guest.agents.body', { token })}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <a href="https://www.x402.org/" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
              x402
            </a>
            <a href="/llms.txt" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
              /llms.txt
            </a>
            <a
              href="https://github.com/Kairose-master/handsel/blob/main/docs/agent-integration.md"
              className="text-primary hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              docs/agent-integration.md
            </a>
          </p>
        </div>

        <VerifySection deployment={data?.deployment ?? null} />

        <div className="glass-card rounded-lg border border-border bg-secondary/30 p-6 text-center">
          <p className="text-xl font-semibold tracking-[-0.015em]">{t('guest.cta.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('guest.cta.body')}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/connect"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t('guest.cta.connect')}
            </Link>
            <Link
              href="/sign-up"
              className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary"
            >
              {t('guest.cta.signUp')}
            </Link>
          </div>
        </div>

        <SiteFooter realMoney={data?.realMoney ?? null} />
      </main>
    </div>
  )
}

/**
 * The Cloud Options Desk, shown as what it is.
 *
 * Every specific in here — role names, what each reads, the order of the
 * pipeline, which step reviews which — comes from OFFICE_TEMPLATES. Nothing
 * about the desk is retyped as marketing copy, so the section cannot drift
 * from the template a visitor would actually hire, and cannot claim a
 * connector that was removed. That is the same rule the rest of this page
 * follows for numbers, applied to configuration.
 */
function OfficeSection() {
  const { t } = useI18n()
  const template = OFFICE_TEMPLATES.find((x) => x.id === 'cloud-options-desk')
  // Defensive rather than decorative: if the template is ever renamed or
  // dropped, the front door goes quiet instead of rendering an empty frame.
  if (!template) return null

  const wired = template.roles.filter((r) => r.defaultConnector)
  const nameOf = (roleId: string) => template.roles.find((r) => r.id === roleId)?.name ?? roleId

  return (
    <section id="office" className="scroll-mt-20 rounded-xl border border-border">
      <div className="border-b border-border p-6 md:p-8">
        <span className="label-eyebrow text-muted-foreground">{t('guest.office.eyebrow')}</span>
        <h2 className="mt-2 text-[clamp(1.6rem,3vw,2.35rem)] font-semibold text-balance">
          {t('guest.office.title')}
        </h2>
        <p className="mt-3 max-w-[68ch] text-[0.95rem] leading-[1.7] text-muted-foreground">
          {t('guest.office.body')}
        </p>
      </div>

      <div className="grid gap-px bg-border md:grid-cols-2">
        {/* Who is at the desk, and what each one reads. */}
        <div className="bg-background p-6">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Users className="size-4 text-muted-foreground" /> {t('guest.office.rolesLabel')}
          </h3>
          <ul className="space-y-2.5">
            {template.roles.map((r) => (
              <li key={r.id} className="text-sm">
                <span className="font-medium">{r.name}</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">{r.blurb}</span>
                {r.defaultConnector && (
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-primary">
                    <Plug className="mr-1 inline size-3" />
                    {new URL(r.defaultConnector.serverUrl).host}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* The pipeline, in its real order, with the review gate named. */}
        <div className="bg-background p-6">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Workflow className="size-4 text-muted-foreground" /> {t('guest.office.flowLabel')}
          </h3>
          <ol className="space-y-2">
            {template.pipeline.map((step, i) => (
              <li key={step.roleId} className="flex gap-2.5 text-sm">
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0">
                  <span className="font-medium">{nameOf(step.roleId)}</span>
                  {step.reviewOfRoleId ? (
                    <span className="block text-xs text-muted-foreground">
                      reviews {nameOf(step.reviewOfRoleId)} — a change request goes back to it
                    </span>
                  ) : step.dependsOnRoleIds.length ? (
                    <span className="block text-xs text-muted-foreground">
                      waits on {step.dependsOnRoleIds.map(nameOf).join(', ')}
                    </span>
                  ) : (
                    // A root step. Naming what it reads rather than repeating
                    // "starts immediately" four times: the interesting fact
                    // about these four is that each one reads somewhere else.
                    <span className="block truncate text-xs text-muted-foreground">
                      {(() => {
                        const c = template.roles.find((x) => x.id === step.roleId)?.defaultConnector
                        return c ? `reads ${new URL(c.serverUrl).host}` : 'starts immediately'
                      })()}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
          {/* The hostnames are already on every role and every root step; all
              this line adds is the fact that none of them asked for a key. */}
          {wired.length > 0 && (
            <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
              {t('guest.office.noKey')}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
        {(
          [
            ['guest.office.f1.title', 'guest.office.f1.body'],
            ['guest.office.f2.title', 'guest.office.f2.body'],
            ['guest.office.f3.title', 'guest.office.f3.body'],
          ] as const
        ).map(([title, body]) => (
          <div key={title} className="bg-background p-6">
            <h3 className="text-sm font-semibold">{t(title)}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t(body)}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border p-6">
        <Link
          href="/start"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:opacity-90 active:translate-y-px"
        >
          {t('guest.office.ctaStart')}
          <ArrowRight className="size-4" />
        </Link>
        <Link
          href="/connect"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-5 py-2.5 text-sm font-medium transition-all duration-200 hover:border-primary/40 hover:bg-secondary active:translate-y-px"
        >
          {t('guest.office.ctaConnector')}
        </Link>
      </div>
    </section>
  )
}

function GuestJobCard({ job }: { job: GuestJob }) {
  const { t } = useI18n()
  return (
    <div className="glass-card rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-sm">{job.title}</span>
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[job.status] ?? 'bg-secondary text-muted-foreground'}`}>
          {job.status}
        </span>
      </div>
      {job.description && <p className="text-sm text-muted-foreground mt-1">{job.description}</p>}
      {job.acceptanceCriteria && (
        <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
          <span className="font-medium">{t('guest.job.criteria')}</span> {job.acceptanceCriteria}
        </p>
      )}
      {job.attachmentUrl && (
        <a
          href={job.attachmentUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <Paperclip className="size-3" /> {job.attachmentName ?? t('guest.job.attachment')}
        </a>
      )}
      <p className="text-xs text-muted-foreground mt-2 font-mono">
        #{job.id} · {t('guest.job.bounty')} ${job.bounty.toLocaleString()} · {t('guest.job.minScore')}{' '}
        {job.minScore} · {t('guest.job.by')} {job.requesterLabel ?? '—'}
        {job.workerLabel && ` · ${t('guest.job.worker')} ${job.workerLabel}`}
      </p>

      {job.status === 'Accepted' &&
        (job.workerRunStatus === 'running' || job.workerRunStatus === 'processing') && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
            <Bot className="size-3.5 animate-pulse" /> {t('guest.job.working')}
          </p>
        )}

      {job.output && (job.status === 'Submitted' || job.status === 'Disputed' || job.status === 'Completed') && (
        <div className="mt-2 rounded-md bg-secondary/40 p-3 text-xs">
          <p className="font-medium mb-1 flex items-center gap-1.5">
            <Bot className="size-3.5" /> {t('guest.job.output')}
          </p>
          <p className="whitespace-pre-wrap text-muted-foreground">{job.output}</p>
        </div>
      )}
      {job.testResult && (
        <p
          className={`mt-2 flex items-center gap-1.5 text-xs ${
            job.testResult.passed === true
              ? 'text-success'
              : job.testResult.passed === false
                ? 'text-destructive'
                : 'text-warning'
          }`}
        >
          <ShieldCheck className="size-3.5" />
          {job.testResult.passed === true
            ? t('guest.job.testsPassed')
            : job.testResult.passed === false
              ? t('guest.job.testsFailed')
              : t('guest.job.testsPending')}
        </p>
      )}
      {job.status === 'Disputed' && job.disputeNote && (
        <p className="mt-2 text-xs text-destructive">
          <span className="font-medium">{t('guest.job.disputeReason')}</span> {job.disputeNote}{' '}
          {t('guest.job.awaitingReview')}
        </p>
      )}
    </div>
  )
}

function HowStep({
  n,
  icon: Icon,
  title,
  body,
}: {
  n: number
  icon: typeof Bot
  title: string
  body: string
}) {
  return (
    <div className="relative bg-card p-5 transition-colors duration-200 hover:bg-secondary/40 md:p-6">
      <div className="flex items-baseline gap-2.5">
        <span className="font-mono text-[1.75rem] font-medium leading-none text-primary/35 tabular-nums">
          {n}
        </span>
        <Icon className="size-4 shrink-0 self-center text-muted-foreground" />
        <h3 className="text-sm font-semibold text-balance">{title}</h3>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  )
}

/**
 * "Verify, don't trust" — modelled on the security section Morpho runs (code,
 * audits, formal verification, all in one block), but built from what this
 * project can actually show. There are no audit-firm logos here because there
 * is no commissioned audit; printing a row of badges would be precisely the
 * defect this section exists to rule out.
 *
 * Every claim below was checked against its primary source before being
 * written, not taken from a doc: both addresses were opened on Basescan and
 * report Source Code Verified / Exact Match on v0.8.24 (the repo's own
 * pre-flight checklist still had that step unticked — the checklist was
 * stale, not the verification). The audit counts are quoted from the first
 * paragraph of docs/security-audit.md.
 *
 * The addresses are hardcoded on purpose: they are the Base-mainnet
 * deployment recorded in docs/deployments.md, and a wrong address here is
 * worse than none, so they should change only alongside that table.
 */
const REPO = 'https://github.com/Kairose-master/handsel/blob/main'

function VerifySection({ deployment }: { deployment: Overview['deployment'] }) {
  const { t } = useI18n()
  return (
    <section className="pt-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.09em] text-primary">
        {t('guest.verify.eyebrow')}
      </p>
      <h2 className="mt-2 text-[clamp(1.6rem,3vw,2.35rem)] font-semibold text-balance">
        {t('guest.verify.title')}
      </h2>
      <p className="mt-2.5 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
        {t('guest.verify.body')}
      </p>

      <div
        className={`mt-6 grid gap-px border-y border-border bg-border ${
          deployment ? 'md:grid-cols-3' : 'md:grid-cols-2'
        }`}
      >
        {/* Omitted entirely when no chain is configured — a contracts card
            with nothing to open is worse than no card. */}
        {deployment && (
          <VerifyItem label={t('guest.verify.contracts.label')} title={t('guest.verify.contracts.title')}>
            <p className="text-sm leading-relaxed text-muted-foreground">{t('guest.verify.contracts.body')}</p>
            <ul className="mt-3 space-y-1.5">
              {deployment.contracts.map((c) => (
                <li key={c.address}>
                  <a
                    href={`${deployment.explorerUrl}/address/${c.address}#code`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block transition-colors hover:text-primary"
                  >
                    <span className="text-xs font-medium">{c.name}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground group-hover:text-primary">
                      {c.address}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </VerifyItem>
        )}

        <VerifyItem label={t('guest.verify.audit.label')} title={t('guest.verify.audit.title')}>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('guest.verify.audit.body')}</p>
          <a
            href={`${REPO}/docs/security-audit.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-auto inline-flex items-center gap-1 pt-3 font-mono text-[11px] text-primary hover:underline"
          >
            docs/security-audit.md <ArrowRight className="size-3" />
          </a>
        </VerifyItem>

        <VerifyItem label={t('guest.verify.failures.label')} title={t('guest.verify.failures.title')}>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('guest.verify.failures.body')}</p>
          <a
            href={`${REPO}/docs/failure-modes.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-auto inline-flex items-center gap-1 pt-3 font-mono text-[11px] text-primary hover:underline"
          >
            docs/failure-modes.md <ArrowRight className="size-3" />
          </a>
        </VerifyItem>
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{t('guest.verify.footnote')}</span>
        <Link href="/challenge" className="text-primary hover:underline">
          {t('guest.verify.challengeLink')}
        </Link>
        <a
          href="https://github.com/Kairose-master/handsel"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {t('guest.verify.sourceLink')}
        </a>
      </p>
    </section>
  )
}

function VerifyItem({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  return (
    // flex column so a trailing link can take mt-auto and sit on the same
    // baseline across all three, instead of floating wherever its own body
    // copy happens to end.
    <div className="flex flex-col bg-background px-4 py-5 md:px-5">
      <p className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <h3 className="mt-1.5 text-sm font-semibold leading-snug text-balance">{title}</h3>
      <div className="mt-2 flex flex-1 flex-col">{children}</div>
    </div>
  )
}

/** One live figure in the hero readout. `value === null` means still reading;
 *  `failed` means the query died — neither ever renders a stand-in number. */
function HeroMetric({ label, value, failed }: { label: string; value: string | null; failed: boolean }) {
  return (
    <div className="bg-background px-4 py-3.5 first:pl-0 sm:px-5">
      <dt className="text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">{label}</dt>
      {/* `failed` is tested BEFORE `value === null`, because on a dead query
          both are true — ordering them the other way made a failed read style
          itself as a still-loading one while the text already said n/a. Not
          destructive-red: three red figures read as an outage, and a hero
          shouldn't shout. Muted-but-legible plus the literal n/a is enough to
          tell "we couldn't read this" apart from a real zero. */}
      <dd
        className={`mt-1 font-mono text-2xl tabular-nums ${
          failed ? 'text-muted-foreground' : value === null ? 'text-muted-foreground/40' : ''
        }`}
      >
        {failed ? 'n/a' : (value ?? '––––')}
      </dd>
    </div>
  )
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof Bot
  children: React.ReactNode
}) {
  return (
    <div className="glass-card rounded-lg border border-border p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4" /> {title}
      </h2>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}
