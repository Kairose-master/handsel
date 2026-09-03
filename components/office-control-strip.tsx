'use client'
/**
 * The first thing an office owner sees: what the office is doing right now,
 * what it does next, and where it needs them — one strip, every number a
 * live query (app/actions/office-session.ts officeSessionOverview), no
 * decoration. Mounted at the top of the dashboard home and of /office; the
 * full control room is /office/sessions and every line here links into it.
 *
 * Three states, all real: nothing connected yet (say what to do first), a
 * connected office with no session (say what to do next), and the live
 * picture — sessions with their current task and worker, the inbox with
 * approve/deny inline, today's spend split by who approved it, retries and
 * failures, the latest artifact, and the memory the briefs opened with.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, X, Loader2, Workflow, Plug, ShieldCheck } from 'lucide-react'
import { decideSessionApproval, officeSessionOverview, type SessionOverview } from '@/app/actions/office-session'
import { STATUS_META } from '@/lib/office-session'
import { useI18n } from '@/lib/i18n'

const usd = (n: number) => `$${n.toFixed(2)}`
const when = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleTimeString())

export function OfficeControlStrip({ slot = 1 }: { slot?: number }) {
  const [view, setView] = useState<SessionOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const { t } = useI18n()
  const load = useCallback(async () => {
    try {
      setView(await officeSessionOverview(slot))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('strip.readError'))
    }
  }, [slot, t])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [load])

  if (error) return <p className="text-xs text-destructive">{error}</p>
  if (!view) return <p className="text-xs text-muted-foreground">{t('strip.reading')}</p>

  const live = view.sessions.filter((s) => !STATUS_META[s.status].terminal)
  const onlineWorkers = view.workers.filter((w) => w.alive)
  const running = live.filter((s) => s.liveRuns > 0)
  const retries = live.reduce((n, s) => n + s.retries, 0)
  const failed = live.reduce((n, s) => n + s.tasksFailed, 0)
  const lastArtifact = view.sessions.map((s) => s.lastArtifact).filter((a): a is NonNullable<typeof a> => a !== null).sort((a, b) => b.at - a.at)[0] ?? null
  const decide = async (sessionId: string, approvalId: string, granted: boolean) => {
    setActing(approvalId)
    try {
      const r = await decideSessionApproval(sessionId, approvalId, granted, granted ? undefined : 'denied by owner')
      if (!r.ok) alert(r.error)
      await load()
    } finally {
      setActing(null)
    }
  }

  return (
    <section className="rounded-md border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Workflow className="h-4 w-4" />
          {t('strip.title')}
          <span className="text-xs font-normal text-muted-foreground">
            {view.realMoney ? t('strip.realMoney', { chain: view.chainName }) : t('strip.noValue', { chain: view.chainName })}
          </span>
        </div>
        <Link href="/office/sessions" className="text-xs underline">
          {t('strip.controlRoom')}
        </Link>
      </header>

      {/* the counters the spec asks for on the first screen */}
      <div className="grid grid-cols-2 gap-px border-b border-border bg-border text-xs sm:grid-cols-4 lg:grid-cols-7">
        <Stat label={t('strip.needsYou')} value={String(view.inbox.length)} tone={view.inbox.length ? 'warn' : undefined} />
        <Stat label={t('strip.sessionsLive')} value={String(live.length)} />
        <Stat label={t('strip.runningNow')} value={String(running.length)} tone={running.length ? 'ok' : undefined} />
        <Stat label={t('strip.workersOnline')} value={`${onlineWorkers.length}/${view.workers.length}`} tone={view.workers.length && !onlineWorkers.length ? 'warn' : undefined} />
        <Stat label={t('strip.paidToday')} value={usd(view.spentTodayUsd)} sub={t('strip.paidTodaySub', { auto: usd(view.autoApprovedTodayUsd), cap: usd(view.policy.dailyBudgetUsd) })} />
        <Stat label={t('strip.retriesFailed')} value={`${retries} / ${failed}`} tone={failed ? 'bad' : undefined} />
        <Stat label={t('strip.memoryUsed')} value={String(view.memory.length)} sub={t('strip.memorySub')} />
      </div>

      <div className="space-y-2 p-3 text-sm">
        {view.inbox.length > 0 && (
          <div className="space-y-1">
            {view.inbox.map((i) => (
              <div key={i.approvalId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/40 bg-warning/5 px-2 py-1.5">
                <div className="min-w-0">
                  <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-warning" />
                  <Link href={`/office/sessions/${i.sessionId}`} className="font-medium underline">
                    {i.taskTitle}
                  </Link>{' '}
                  <span className="text-xs text-muted-foreground" title={i.reasons.join('\n')}>
                    · {usd(i.amountUsd)} · {i.reasons[0].length > 110 ? `${i.reasons[0].slice(0, 110)}…` : i.reasons[0]}
                  </span>
                </div>
                <div className="flex gap-1">
                  <button type="button" disabled={acting === i.approvalId} onClick={() => decide(i.sessionId, i.approvalId, true)} className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-secondary">
                    {acting === i.approvalId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} {t('strip.approve')}
                  </button>
                  <button type="button" disabled={acting === i.approvalId} onClick={() => decide(i.sessionId, i.approvalId, false)} className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-secondary">
                    <X className="h-3 w-3" /> {t('strip.deny')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {live.length === 0 && view.workers.length === 0 && (
          <p className="text-muted-foreground">
            <Plug className="mr-1 inline h-3.5 w-3.5" />
            {t('strip.nothingRunning')}{' '}
            <Link href="/office/sessions" className="underline">
              {t('strip.twoSteps')}
            </Link>
            .
          </p>
        )}
        {live.length === 0 && view.workers.length > 0 && (
          <p className="text-muted-foreground">
            {onlineWorkers.length ? t('strip.onlineIdle', { names: onlineWorkers.map((w) => w.name).join(', ') }) : t('strip.connectedOffline', { names: view.workers.map((w) => w.name).join(', ') })}{' '}
            <Link href="/office/sessions" className="underline">
              {t('strip.giveGoal')}
            </Link>
            .
          </p>
        )}

        {live.slice(0, 4).map((s) => (
          <div key={s.id} className="rounded border border-border px-2 py-1.5">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <Link href={`/office/sessions/${s.id}`} className="min-w-0 truncate font-medium underline">
                {s.goal.slice(0, 100)}
              </Link>
              <span className="text-xs">
                <span className={s.liveRuns ? 'text-success' : s.status === 'waiting_on_approval' ? 'text-warning' : ''}>{s.status.replace(/_/g, ' ')}</span>
                {s.statusReason ? ` — ${s.statusReason.slice(0, 80)}` : ''}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {s.currentTask
                ? t('strip.nowTask', {
                    task: s.currentTask.title.slice(0, 60),
                    status: s.currentTask.status.replace(/_/g, ' '),
                    attempt: s.currentTask.attempt,
                    on: s.currentTask.workerAgentId ? t('strip.onWorker', { worker: view.workers.find((w) => w.agentId === s.currentTask!.workerAgentId)?.name ?? s.currentTask.workerAgentId }) : '',
                  })
                : t('strip.tasksDone', { done: s.tasksDone, total: s.tasksTotal })}
              {' · '}
              {t('strip.next', { step: s.nextStep.replace(/\.$/, '').toLowerCase() })}
              {s.nextWakeAt ? ` ${t('strip.checksAgain', { at: when(s.nextWakeAt) })}` : ''}
              {' · '}
              {t('strip.ofBudget', { spent: usd(s.spentUsd), budget: usd(s.budgetLimitUsd) })}
            </div>
          </div>
        ))}
        {live.length > 4 && (
          <Link href="/office/sessions" className="text-xs underline">
            {t('strip.more', { n: live.length - 4 })}
          </Link>
        )}

        {lastArtifact && (
          <p className="text-xs text-muted-foreground">
            {t('strip.latestArtifact', { kind: lastArtifact.kind, name: lastArtifact.name, sha: lastArtifact.sha256.slice(0, 12), at: when(lastArtifact.at) })}
          </p>
        )}
      </div>
    </section>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : tone === 'bad' ? 'text-destructive' : ''
  return (
    <div className="bg-card px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  )
}
