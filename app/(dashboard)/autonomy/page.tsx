'use client'

/**
 * Autonomy — what is running on this account without anyone watching.
 *
 * Four automations act on their own now (gas pool, office Automaton, lineage
 * mandate, auto-mine) and each shipped with its switch next to the thing it
 * governs. That is right for a control and wrong for an overview, so this
 * page is the overview and nothing more: it reads, it never flips. Each row
 * links to where its switch actually lives.
 *
 * The page leads with the log rather than the switches, because "what did it
 * do" is the question an owner opens this for; "what could it do" is the
 * context for reading that answer.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, RefreshCw, Fuel, Coins, GitBranch, Pickaxe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { myAutonomy } from '@/app/actions/autonomy'
import type { AutonomyLogEntry, AutonomyView, MandateBudget } from '@/lib/autonomy-console'

const SOURCE_STYLE: Record<AutonomyLogEntry['source'], { label: string; cls: string }> = {
  gas: { label: 'GAS', cls: 'text-muted-foreground' },
  bond: { label: 'BOND', cls: 'text-primary' },
  birth: { label: 'BIRTH', cls: 'text-success' },
  retirement: { label: 'RETIRE', cls: 'text-warning' },
}

/** Spend against a budget. Shows the unit, never a bare number: gas is ETH
 *  and everything else is USD, and a bar that blurred the two would be worse
 *  than no bar. */
function BudgetBar({ budget }: { budget: MandateBudget }) {
  const pct = budget.budget > 0 ? Math.min(100, (budget.spent / budget.budget) * 100) : 0
  const fmt = (n: number) => (budget.unit === 'eth' ? `${n.toFixed(4)} ETH` : `$${n.toFixed(2)}`)
  return (
    <div className="min-w-[9rem] flex-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
        {fmt(budget.spent)} / {fmt(budget.budget)} today
      </p>
    </div>
  )
}

function Dot({ on, muted }: { on: boolean; muted?: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        muted ? 'bg-warning' : on ? 'bg-success' : 'bg-muted-foreground/40'
      }`}
    />
  )
}

export default function AutonomyPage() {
  const [view, setView] = useState<AutonomyView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setView(await myAutonomy())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read it.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Autonomy</h1>
          <p className="text-sm text-muted-foreground">
            What runs on this account without anyone watching — and what it has actually done. Read-only: every switch
            stays where it is governed.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={load} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!view && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

      {view && (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 py-4">
              <Dot on={view.anyActive} />
              <span className="font-mono text-sm">
                {view.anyActive ? 'SOMETHING IS RUNNING' : 'NOTHING IS RUNNING BY ITSELF'}
              </span>
              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                  view.deployment.realMoney ? 'border-destructive/50 text-destructive' : 'border-border text-muted-foreground'
                }`}
              >
                {view.deployment.chainName} · {view.deployment.realMoney ? 'REAL MONEY' : 'test tokens'}
              </span>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">What they did</CardTitle>
              <p className="text-xs text-muted-foreground">
                Every autonomous action, newest first — gas sponsorships, bond top-ups, births and retirements in one
                timeline.
              </p>
            </CardHeader>
            <CardContent>
              {view.log.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing yet. An empty log with something switched on means it has had no reason to act.
                </p>
              ) : (
                <ul className="space-y-1">
                  {view.log.map((e, i) => {
                    const style = SOURCE_STYLE[e.source]
                    return (
                      <li
                        key={`${e.at}-${i}`}
                        className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] tabular-nums text-muted-foreground"
                      >
                        <span className="opacity-70">{new Date(e.at).toLocaleString()}</span>
                        <span className={style.cls}>{style.label}</span>
                        <span>{e.what}</span>
                        {e.amount && <span className="text-foreground">{e.amount}</span>}
                        {e.ok ? (
                          e.txHash && <span className="text-success">✓ {e.txHash.slice(0, 10)}…</span>
                        ) : (
                          <span className="text-destructive">✗ failed</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">What they may do</CardTitle>
              <p className="text-xs text-muted-foreground">
                Each mandate&apos;s bounds and today&apos;s spend against them.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Fuel className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-[12rem] flex-1">
                  <div className="flex items-center gap-2">
                    <Dot on={!!view.gasPool?.enabled} />
                    <span className="text-sm font-medium">Gas pool</span>
                    <span className="text-xs text-muted-foreground">
                      {view.gasPool
                        ? `${view.gasPool.sourceAgentName} → anyone who runs dry, to ${view.gasPool.targetEth} ETH`
                        : 'not set — an agent that runs out of ETH simply stops'}
                    </span>
                  </div>
                </div>
                {view.gasPool && <BudgetBar budget={view.gasPool} />}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Pickaxe className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex items-center gap-2">
                  <Dot on={view.autoMine.enabled > 0} />
                  <span className="text-sm font-medium">Auto-mine</span>
                  <span className="text-xs text-muted-foreground">
                    {view.autoMine.enabled} of {view.autoMine.total} agents claim jobs on their own
                  </span>
                </div>
              </div>

              {view.offices.map((o) => (
                <div key={o.slot} className="space-y-3 rounded-md border border-border p-3">
                  <p className="text-sm font-medium">
                    {o.name}{' '}
                    <Link href="/office" className="text-xs font-normal text-primary underline">
                      switches →
                    </Link>
                  </p>

                  <div className="flex flex-wrap items-center gap-3">
                    <Coins className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-[12rem] flex-1 items-center gap-2">
                      <Dot on={o.automaton.enabled} />
                      <span className="text-sm">Automaton</span>
                      <span className="text-xs text-muted-foreground">
                        keeps workers at ${o.automaton.floorUsd.toFixed(2)} bond float
                      </span>
                    </div>
                    <BudgetBar budget={o.automaton} />
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-[12rem] flex-1 items-center gap-2">
                      <Dot on={o.lineage.enabled && o.lineage.allowedHere} muted={o.lineage.enabled && !o.lineage.allowedHere} />
                      <span className="text-sm">Lineage</span>
                      <span className="text-xs text-muted-foreground">
                        {o.lineage.enabled && !o.lineage.allowedHere
                          ? 'on, but refused here — this deployment handles real money'
                          : o.lineage.enabled
                            ? 'copies proven agents, retires failing ones'
                            : 'off — nothing is copied or retired'}
                      </span>
                    </div>
                    <p className="min-w-[9rem] flex-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {o.lineage.birthsToday}/{o.lineage.maxBirthsPerWindow} births · $
                      {o.lineage.seededTodayUsd.toFixed(2)} seeded · {o.lineage.retirementsToday} retired today
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
