"use client"

import type React from "react"
import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  LayoutDashboard,
  Bot,
  Gauge,
  ArrowLeftRight,
  Briefcase,
  GitBranch,
  Pickaxe,
  FlaskConical,
  ShieldAlert,
  Umbrella,
  Settings,
  BookOpen,
  MessageSquare,
  Menu,
  X,
  LogOut,
  Heart,
  Copy,
  Check,
  Vote,
  Gamepad2,
  Boxes,
  Building2,
  ChevronDown,
  Network,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { getShellStatus } from "@/app/actions/shell"
import { RiskBanner } from "@/components/risk-banner"
import { SiteFooter } from "@/components/site-footer"
import { ThemeToggle } from "@/components/theme-toggle"
import { LanguageSwitcher, useI18n } from "@/lib/i18n"
import { Readout, StatusDot } from "@/components/deck"

type ShellStatus = Awaited<ReturnType<typeof getShellStatus>>

const DONATION_ADDRESS = "0xe274231b7d91dDa77cdbD150B7b5E4fA6F5140ae"

function SupportCard() {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(DONATION_ADDRESS)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="glass-card rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Heart className="size-3.5 text-primary" />
        {t('shell.supportProject')}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        {t('shell.supportBody')}
      </p>
      <button
        onClick={handleCopy}
        className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-sidebar-border bg-background px-2 py-1.5 text-left font-mono text-[10px] text-sidebar-foreground hover:bg-sidebar-accent/50"
        title={t('shell.copyAddress')}
      >
        <span className="min-w-0 flex-1 truncate">{DONATION_ADDRESS}</span>
        {copied ? (
          <Check className="size-3 shrink-0 text-success" />
        ) : (
          <Copy className="size-3 shrink-0 text-muted-foreground" />
        )}
      </button>
    </div>
  )
}

// The essentials a first-timer needs — the rest is folded into "Advanced"
// (collapsed by default) so a new/guest user isn't hit with 16 items. Nothing
// is removed; the door is just narrower.
const coreNav = [
  { labelKey: "nav.dashboard", href: "/", icon: LayoutDashboard },
  { labelKey: "nav.guide", href: "/guide", icon: BookOpen },
  { labelKey: "nav.agents", href: "/agents", icon: Bot },
  { labelKey: "nav.office", href: "/office", icon: Building2 },
  { labelKey: "nav.network", href: "/office/network", icon: Network },
  { labelKey: "nav.autonomy", href: "/autonomy", icon: Bot },
  { labelKey: "nav.laborMarket", href: "/jobs", icon: Briefcase },
  { labelKey: "nav.delegate", href: "/delegate", icon: GitBranch },
  { labelKey: "nav.workerConsole", href: "/mine", icon: Pickaxe },
  { labelKey: "nav.settings", href: "/settings", icon: Settings },
]

const advancedNav = [
  { labelKey: "nav.creditScores", href: "/credit-scores", icon: Gauge },
  { labelKey: "nav.transactions", href: "/transactions", icon: ArrowLeftRight },
  { labelKey: "nav.messages", href: "/messages", icon: MessageSquare },
  { labelKey: "nav.provingGround", href: "/verify", icon: FlaskConical },
  { labelKey: "nav.riskAnalytics", href: "/risk", icon: ShieldAlert },
  { labelKey: "nav.insurance", href: "/insurance", icon: Umbrella },
  { labelKey: "nav.governance", href: "/governance", icon: Vote },
  { labelKey: "nav.world", href: "/world", icon: Gamepad2 },
  { labelKey: "nav.directory", href: "/directory", icon: Boxes },
]

function Sidebar({
  pathname,
  onNavigate,
  status,
}: {
  pathname: string
  onNavigate?: () => void
  status: ShellStatus | null
}) {
  const { t } = useI18n()
  const initials = (status?.user?.name ?? "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()

  // Advanced starts collapsed, but opens itself if the current page lives in it
  // (so the active item is never hidden).
  const [advOpen, setAdvOpen] = useState(() => advancedNav.some((i) => pathname.startsWith(i.href)))

  const renderItem = (item: { labelKey: string; href: string; icon: typeof LayoutDashboard }) => {
    const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
    const Icon = item.icon
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
        )}
      >
        <Icon className="size-4 shrink-0" />
        {t(item.labelKey)}
        {active && <span className="pulse-dot ml-auto size-1.5 rounded-full bg-primary" />}
      </Link>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 border-b border-sidebar-border px-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="Handsel" className="size-8 shrink-0" />
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight text-sidebar-foreground">Handsel</p>
          <p className="text-[11px] text-muted-foreground">{t('shell.tagline')}</p>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
        <p className="px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('shell.platform')}
        </p>
        {coreNav.map(renderItem)}

        <button
          type="button"
          onClick={() => setAdvOpen((o) => !o)}
          className="mt-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
          aria-expanded={advOpen}
        >
          <ChevronDown className={cn("size-4 shrink-0 transition-transform", advOpen ? "" : "-rotate-90")} />
          Advanced
          <span className="ml-auto text-[10px] text-muted-foreground">{advancedNav.length}</span>
        </button>
        {advOpen && advancedNav.map(renderItem)}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        {/* Real network status — live chain + block from the RPC, or an
            honest "off-chain mode" label. Never a made-up number. Links to
            /market-health: the same numbers, in full, published unflattering —
            this card is the natural door into that page (surface-audit.md
            flagged /market-health as unreachable from inside the app). */}
        <Link
          href="/market-health"
          onClick={onNavigate}
          className="lift glass-card block rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-3 transition-colors hover:bg-sidebar-accent/60"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">{t('shell.network')}</span>
            {status?.chain ? (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-success">
                <span className="pulse-dot size-1.5 rounded-full bg-success" />{' '}
                {status.chain.realMoney ? t('shell.mainnetLive') : t('shell.testnetLive')}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className="size-1.5 rounded-full bg-muted-foreground" /> {t('shell.offchainMode')}
              </span>
            )}
          </div>
          {status?.chain && (
            <p className="mt-2 font-mono text-xs tabular-nums text-sidebar-foreground">
              {status.chain.name} · #{status.chain.block.toLocaleString()}
            </p>
          )}
        </Link>
        <div className="mt-3">
          <SupportCard />
        </div>
        {status?.user && (
          <div className="mt-3 flex w-full items-center gap-2.5 rounded-md px-2 py-2">
            <div className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
              {initials || "?"}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-medium text-sidebar-foreground">{status.user.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">{status.user.email}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n()
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [status, setStatus] = useState<ShellStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => getShellStatus().then((s) => !cancelled && setStatus(s)).catch(() => {})
    load()
    const t = setInterval(load, 30_000) // keep the block number honest
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const handleLogout = async () => {
    // auth_session is httpOnly by design, so it can only be cleared
    // server-side — this also deletes the session row itself.
    await fetch('/api/signout', { method: 'POST' }).catch(() => {})
    router.push('/sign-in')
    router.refresh()
  }

  const initials = (status?.user?.name ?? "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()

  return (
    <div className="min-h-svh bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] border-r border-sidebar-border bg-sidebar shadow-[2px_0_16px_-8px_var(--glass-throw)] lg:block">
        <Sidebar pathname={pathname} status={status} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-sidebar-border bg-sidebar">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-4 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent"
              aria-label={t('shell.closeNav')}
            >
              <X className="size-4" />
            </button>
            <Sidebar pathname={pathname} onNavigate={() => setMobileOpen(false)} status={status} />
          </aside>
        </div>
      )}

      <div className="lg:pl-[232px]">
        {/* Above the header, not inside it: a warning that scrolls away is a
            warning the user reads once. */}
        <RiskBanner realMoney={status?.chain?.realMoney ?? null} />
        <header className="sticky top-0 z-20 flex h-[52px] items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-6">
          <button
            onClick={() => setMobileOpen(true)}
            className="flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-secondary lg:hidden"
            aria-label={t('shell.openNav')}
          >
            <Menu className="size-4" />
          </button>

          {/* Environment disclosure — every credible financial UI labels its
              environment. DERIVED from the configured chain, never asserted:
              this used to hardcode "Testnet", which became a false label the
              day the deployment moved to Base mainnet. Until the chain status
              loads there is nothing honest to claim, so nothing renders. */}
          {status?.chain &&
            (status.chain.realMoney ? (
              <span className="rounded-md border border-success/40 bg-success/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-success">
                {t('shell.mainnetBadge', { chain: status.chain.name })}
              </span>
            ) : (
              <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-warning">
                {t('shell.testnetBadge')}
              </span>
            ))}

          {/* Instrument readouts, not chips.

              Both are live queries (app/actions/shell.ts) and both render
              NOTHING when the read failed — a console whose gauges keep
              showing the last good number, or a zero, is worse than one with
              a gap in it. There is deliberately no burn-rate readout beside
              them however good it would look: nothing on this platform
              measures one, and a figure invented to fill a slot is the exact
              defect this header was rebuilt once already to remove. */}
          <div className="ml-auto flex items-center gap-4 md:gap-5">
            {status?.vaultUsd !== null && status?.vaultUsd !== undefined && (
              <div className="hidden sm:block">
                <Readout
                  label={t('shell.vaultLabel')}
                  value={`$${status.vaultUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                  tone="ok"
                  hint={t('shell.vaultTooltip')}
                />
              </div>
            )}
            {status?.chain && (
              <div className="hidden md:block">
                <Readout label={t('shell.blockLabel')} value={`#${status.chain.block.toLocaleString()}`} />
              </div>
            )}
            <LanguageSwitcher />
            <ThemeToggle />
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex size-9 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary hover:opacity-80"
              >
                {initials || "…"}
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-40 rounded-md border border-border bg-background shadow-lg">
                  <button
                    onClick={handleLogout}
                    className="flex w-full items-center gap-2 px-4 py-2 text-sm text-foreground hover:bg-secondary"
                  >
                    <LogOut className="size-4" />
                    {t('shell.signOut')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1400px] p-4 md:p-6">
          {children}
          <SiteFooter realMoney={status?.chain?.realMoney ?? null} />
        </main>
      </div>
    </div>
  )
}
