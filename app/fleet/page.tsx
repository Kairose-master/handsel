'use client'
/**
 * /fleet — the big picture as a page a buyer can act on.
 *
 * The hero is the map: a business drawn as boxes, each box an agent with a
 * wallet (lib/fleet-map.ts). Under it, the three numbers the network can
 * defend today (live, null-safe), the six steps a box goes through to be
 * filled, the Notion table the owner actually edits, and three steps to
 * start. Design notes and references: docs/fleet-landing-design.md.
 *
 * Every figure on this page is a live read or a dash. The map's boxes are
 * the reel's boxes; what fills each is read from OFFICE_TEMPLATES, so the
 * page cannot advertise a desk the code does not ship.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Wallet, ShieldCheck, FileCheck2, Bot, Table2, Play } from 'lucide-react'
import { getFleetOverview, type FleetOverview } from '@/app/actions/fleet'
import { SiteFooter } from '@/components/site-footer'
import { ThemeToggle } from '@/components/theme-toggle'
import { LanguageSwitcher, useI18n } from '@/lib/i18n'
import {
  BOX_H,
  BOX_W,
  FLEET_BOXES,
  MAP_H,
  MAP_W,
  PIPELINE_STEPS,
  boxPosition,
  templateNameFor,
  type FleetBox,
} from '@/lib/fleet-map'
import { REQUIRED_PROPERTIES, OPTIONAL_PROPERTIES, STATUS, MAX_ROW_BOUNTY_USD_DEFAULT } from '@/lib/notion-desk'

/** The public "duplicate this template" link, once the operator has published
 *  the desk table from Notion (Share → Publish → allow duplicating). Notion
 *  has no API for publishing, so this is set by hand; until it is, step one
 *  offers the create path instead of a link that does not exist. */
const TEMPLATE_URL = process.env.NEXT_PUBLIC_NOTION_DESK_TEMPLATE_URL?.trim() || null

/* The map is deliberately one-theme: a dark canvas like the reel's monitor,
   whatever the page theme. Its colours live here, not in tokens. */
const MAP = {
  canvas: '#070a0f',
  grid: '#0f1720',
  box: '#0d151d',
  boxHover: '#13202b',
  border: '#1f2d3a',
  text: '#dff4ff',
  dim: '#7f97ab',
  thread: '#2fa190',
  wallet: '#e0b34a',
}

function Metric({ label, value, failed }: { label: string; value: string | null; failed: boolean }) {
  return (
    <div className="bg-background px-5 py-4">
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-2xl tabular-nums">{value ?? (failed ? '—' : '…')}</dd>
    </div>
  )
}

function FleetMap({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const { t } = useI18n()
  const core = FLEET_BOXES.filter((b) => b.ring === 'core')
  const centre = { x: MAP_W / 2, y: MAP_H / 2 }
  return (
    <svg
      viewBox={`0 0 ${MAP_W} ${MAP_H}`}
      role="img"
      aria-label={t('fleet.map.aria')}
      className="block h-auto w-full"
      style={{ background: MAP.canvas }}
    >
      <defs>
        <pattern id="fleet-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke={MAP.grid} strokeWidth="1" />
        </pattern>
      </defs>
      <rect width={MAP_W} height={MAP_H} fill="url(#fleet-grid)" />
      {/* threads: every outer box to the nearest edge of the core block */}
      {FLEET_BOXES.filter((b) => b.ring === 'outer').map((b) => {
        const p = boxPosition(b)
        const from = { x: p.x + BOX_W / 2, y: p.y + BOX_H / 2 }
        const on = selected === b.id
        return (
          <line
            key={`thread-${b.id}`}
            x1={from.x}
            y1={from.y}
            x2={centre.x}
            y2={centre.y}
            stroke={MAP.thread}
            strokeOpacity={on ? 0.9 : 0.18}
            strokeWidth={on ? 2 : 1}
            strokeDasharray={on ? undefined : '3 6'}
          />
        )
      })}
      {/* the core block's halo */}
      {(() => {
        const first = boxPosition(core[0])
        const last = boxPosition(core[core.length - 1])
        const x = Math.min(first.x, boxPosition(core[3]).x) - 16
        const y = first.y - 16
        const w = boxPosition(core[2]).x + BOX_W - x + 16
        const h = last.y + BOX_H - y + 16
        return <rect x={x} y={y} width={w} height={h} rx="14" fill={MAP.thread} fillOpacity="0.06" stroke={MAP.thread} strokeOpacity="0.35" />
      })()}
      {FLEET_BOXES.map((b) => (
        <MapBox key={b.id} box={b} selected={selected === b.id} onSelect={onSelect} />
      ))}
      <text x={MAP_W / 2} y={MAP_H - 18} textAnchor="middle" fill={MAP.dim} fontSize="12" fontFamily="var(--font-mono)">
        {t('fleet.map.caption')}
      </text>
    </svg>
  )
}

function MapBox({ box, selected, onSelect }: { box: FleetBox; selected: boolean; onSelect: (id: string) => void }) {
  const { t } = useI18n()
  const p = boxPosition(box)
  const fill = box.fill.kind === 'template' ? templateNameFor(box.fill) : box.fill.kind === 'worker' ? t('fleet.fill.worker') : t('fleet.fill.market')
  return (
    <g
      transform={`translate(${p.x} ${p.y})`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(box.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(box.id)
        }
      }}
      style={{ cursor: 'pointer', outline: 'none' }}
    >
      <rect
        width={BOX_W}
        height={BOX_H}
        rx="8"
        fill={selected ? MAP.boxHover : MAP.box}
        stroke={selected ? MAP.thread : MAP.border}
        strokeWidth={selected ? 1.5 : 1}
      />
      <text x="12" y="24" fill={MAP.text} fontSize="14" fontWeight="600" fontFamily="var(--font-sans)">
        {t(box.labelKey)}
      </text>
      <text x="12" y="44" fill={MAP.dim} fontSize="11" fontFamily="var(--font-mono)">
        {fill}
      </text>
      {/* the wallet glyph: the one thing every box has */}
      <circle cx={BOX_W - 16} cy="16" r="6" fill={MAP.wallet} fillOpacity="0.9" />
      <title>{`${t(box.labelKey)} — ${fill}`}</title>
    </g>
  )
}

export default function FleetPage() {
  const { t } = useI18n()
  const [data, setData] = useState<FleetOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    getFleetOverview()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  const box = FLEET_BOXES.find((b) => b.id === selected) ?? null
  const failed = !loading && !data
  const n = (v: number | null | undefined) => (v === null || v === undefined ? null : v.toLocaleString())

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/guest" className="font-semibold tracking-tight">
            Handsel
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/live" className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
              {t('guest.nav.live')}
            </Link>
            <Link href="/try" className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
              {t('guest.nav.try')}
            </Link>
            <Link href="/participation" className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
              {t('fleet.nav.terms')}
            </Link>
            <LanguageSwitcher />
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4">
        {/* ── The thesis, then the map ─────────────────────────────── */}
        <section className="pb-8 pt-12 md:pt-16">
          <div className="max-w-3xl">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/[0.07] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
              <Wallet className="size-3.5" /> {t('fleet.hero.badge')}
            </span>
            <h1 className="mt-6 text-[clamp(2.4rem,5.2vw,4rem)] font-semibold leading-[1.05] text-balance">{t('fleet.hero.title')}</h1>
            <p className="mt-5 max-w-[62ch] text-[1.0625rem] leading-[1.65] text-muted-foreground md:text-lg">{t('fleet.hero.body')}</p>
            <div className="mt-7 flex flex-wrap items-center gap-2.5">
              <a
                href="#start"
                className="group inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-all hover:opacity-90 hover:shadow-md active:translate-y-px"
              >
                {t('fleet.hero.ctaStart')}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </a>
              <a href="#how" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-5 py-2.5 text-sm font-semibold transition-all hover:border-primary/40 hover:bg-secondary active:translate-y-px">
                {t('fleet.hero.ctaHow')}
              </a>
            </div>
          </div>

          <div className="mt-10 overflow-hidden rounded-[var(--radius-xl)] border border-border">
            <FleetMap selected={selected} onSelect={(id) => setSelected((s) => (s === id ? null : id))} />
          </div>
          <div className="mt-3 min-h-[3.5rem] rounded-lg border border-border bg-card px-4 py-3 text-sm">
            {box ? (
              <p>
                <span className="font-semibold">{t(box.labelKey)}</span>
                <span className="text-muted-foreground"> — </span>
                {box.fill.kind === 'template'
                  ? t('fleet.map.filledByTemplate', { name: templateNameFor(box.fill) ?? box.fill.templateId })
                  : box.fill.kind === 'worker'
                    ? t('fleet.map.filledByWorker')
                    : t('fleet.map.filledByMarket')}{' '}
                <span className="text-muted-foreground">{t('fleet.map.always')}</span>
              </p>
            ) : (
              <p className="text-muted-foreground">{t('fleet.map.hint')}</p>
            )}
          </div>

          {/* Live readout — the only numbers on the page, and each may be a dash. */}
          <dl className="mt-8 grid max-w-3xl grid-cols-1 gap-px border-y border-border bg-border sm:grid-cols-3">
            <Metric label={t('fleet.stat.agents')} value={data ? n(data.agents) : null} failed={failed || data?.agents === null} />
            <Metric label={t('fleet.stat.delivered')} value={data ? n(data.jobsDelivered) : null} failed={failed || data?.jobsDelivered === null} />
            <Metric label={t('fleet.stat.proofs')} value={data ? n(data.proofs) : null} failed={failed || data?.proofs === null} />
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            {failed
              ? t('fleet.stat.failed')
              : data?.realMoney === true
                ? t('fleet.stat.realMoney', { chain: data.chainName ?? '' })
                : data?.realMoney === false
                  ? t('fleet.stat.testMoney', { chain: data.chainName ?? '' })
                  : t('fleet.stat.reading')}
          </p>
        </section>

        {/* ── How a box gets filled ────────────────────────────────── */}
        <section id="how" className="scroll-mt-20 border-t border-border py-12">
          <h2 className="text-[clamp(1.6rem,3vw,2.35rem)] font-semibold text-balance">{t('fleet.how.title')}</h2>
          <p className="mt-3 max-w-[62ch] text-muted-foreground">{t('fleet.how.body')}</p>
          <ol className="mt-8 grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3 lg:grid-cols-6">
            {PIPELINE_STEPS.map((s, i) => (
              <li key={s.id} className="bg-background p-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                  <StepIcon id={s.id} />
                </div>
                <h3 className="mt-2 text-sm font-semibold">{t(s.labelKey)}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(s.bodyKey)}</p>
                <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">{s.source}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-muted-foreground">{t('fleet.how.rule')}</p>
        </section>

        {/* ── The table you actually edit ──────────────────────────── */}
        <section className="border-t border-border py-12">
          <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <h2 className="flex items-center gap-2 text-[clamp(1.6rem,3vw,2.35rem)] font-semibold text-balance">
                <Table2 className="size-6 text-primary" /> {t('fleet.table.title')}
              </h2>
              <p className="mt-3 text-muted-foreground">{t('fleet.table.body')}</p>
              <ul className="mt-5 space-y-2 text-sm">
                <li className="flex gap-2">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" /> {t('fleet.table.cap', { cap: String(MAX_ROW_BOUNTY_USD_DEFAULT) })}
                </li>
                <li className="flex gap-2">
                  <FileCheck2 className="mt-0.5 size-4 shrink-0 text-primary" /> {t('fleet.table.writeback')}
                </li>
                <li className="flex gap-2">
                  <Bot className="mt-0.5 size-4 shrink-0 text-primary" /> {t('fleet.table.worker')}
                </li>
              </ul>
            </div>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="bg-secondary/60 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    {Object.keys(REQUIRED_PROPERTIES).map((c) => (
                      <th key={c} className="px-3 py-2 font-medium">
                        {c}
                      </th>
                    ))}
                    <th className="px-3 py-2 font-medium">Agent</th>
                    <th className="px-3 py-2 font-medium">{Object.keys(OPTIONAL_PROPERTIES).filter((k) => ['Job', 'Result', 'Proof'].includes(k)).join(' · ')}</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  <tr className="border-t border-border">
                    <td className="px-3 py-2">{t('fleet.table.exampleName')}</td>
                    <td className="px-3 py-2">
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300">{STATUS.ready}</span>
                    </td>
                    <td className="max-w-[16ch] truncate px-3 py-2">{t('fleet.table.exampleBrief')}</td>
                    <td className="max-w-[16ch] truncate px-3 py-2">{t('fleet.table.exampleCriteria')}</td>
                    <td className="px-3 py-2">$5</td>
                    <td className="px-3 py-2">{t('fleet.table.exampleAgent')}</td>
                    <td className="px-3 py-2 text-muted-foreground">{t('fleet.table.writtenBack')}</td>
                  </tr>
                  {[STATUS.posted, STATUS.working, STATUS.delivered].map((s) => (
                    <tr key={s} className="border-t border-border text-muted-foreground">
                      <td className="px-3 py-2">…</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            s === STATUS.delivered
                              ? 'rounded-full bg-success/15 px-2 py-0.5 text-success'
                              : 'rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-700 dark:text-sky-300'
                          }
                        >
                          {s}
                        </span>
                      </td>
                      <td className="px-3 py-2" colSpan={5}>
                        {s === STATUS.posted ? t('fleet.table.rowPosted') : s === STATUS.working ? t('fleet.table.rowWorking') : t('fleet.table.rowDelivered')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">{t('fleet.table.exampleNote')}</p>
            </div>
          </div>
        </section>

        {/* ── Start ────────────────────────────────────────────────── */}
        <section id="start" className="scroll-mt-20 border-t border-border py-12">
          <h2 className="text-[clamp(1.6rem,3vw,2.35rem)] font-semibold text-balance">{t('fleet.start.title')}</h2>
          <ol className="mt-6 grid gap-4 md:grid-cols-3">
            {(['one', 'two', 'three'] as const).map((k, i) => (
              <li key={k} className="rounded-xl border border-border bg-card p-5">
                <span className="font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="mt-2 font-semibold">{t(k === 'one' && !TEMPLATE_URL ? 'fleet.start.oneCreate' : `fleet.start.${k}`)}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t(k === 'one' && !TEMPLATE_URL ? 'fleet.start.oneCreateBody' : `fleet.start.${k}Body`)}</p>
                {k === 'one' && TEMPLATE_URL && (
                  <a href={TEMPLATE_URL} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                    {t('fleet.start.oneLink')} <ArrowRight className="size-3.5" />
                  </a>
                )}
              </li>
            ))}
          </ol>
          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <Link href="/start" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
              <Play className="size-4" /> {t('fleet.start.cta')}
            </Link>
            <a href="mailto:hello@handsel.dev?subject=Fleet%20pilot" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:border-primary/40 hover:bg-secondary">
              {t('fleet.start.pilot')}
            </a>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">{t('fleet.start.honest')}</p>
        </section>
      </main>
      <SiteFooter realMoney={data?.realMoney ?? null} />
    </div>
  )
}

function StepIcon({ id }: { id: string }) {
  const cls = 'size-4 text-primary'
  switch (id) {
    case 'row':
      return <Table2 className={cls} />
    case 'escrow':
      return <Wallet className={cls} />
    case 'work':
      return <Bot className={cls} />
    case 'grade':
      return <ShieldCheck className={cls} />
    case 'pay':
      return <Wallet className={cls} />
    default:
      return <FileCheck2 className={cls} />
  }
}
