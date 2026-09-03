'use client'
/**
 * The office control room — what the office is doing, what it will do
 * next, and where it needs a person.
 *
 * Not a diorama: every number on this page is a live query, every row is a
 * real session, and every button is a lever the session runtime already
 * exposes (app/actions/office-session.ts). Order of the panels is the
 * order of the owner's questions: what needs me (inbox) → what is running
 * (sessions) → who can run it (workers) → what it may spend (policy,
 * budget) → what it learned (memory) → start something new.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, RefreshCw, Play, Pause, XCircle, Check, X, Plug, ShieldCheck, Brain, Wallet, Gauge, GitPullRequest } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  attachOfficeTool,
  startRepoCare,
  setOfficePolicyPreset,
  cancelSession,
  connectWorkspaceWorker,
  detachOfficeTool,
  decideSessionApproval,
  myLocalAgents,
  officeSessionOverview,
  pauseSession,
  resumeSession,
  saveOfficePolicy,
  startOfficeSession,
  type SessionOverview,
} from '@/app/actions/office-session'
import { useI18n } from '@/lib/i18n'
import { NOTIFIABLE_EVENTS, describeBinding } from '@/lib/session-tools'
import { POLICY_PRESETS, PRESET_BLURBS, type PolicyPreset } from '@/lib/approval-policy'
import { metricLines, metricsSentence } from '@/lib/office-metrics'
import { STATUS_META, type SessionKind, type SessionStatus } from '@/lib/office-session'

const TONE: Record<SessionStatus, string> = {
  draft: 'text-muted-foreground',
  planned: 'text-muted-foreground',
  awaiting_budget: 'text-warning',
  ready: 'text-primary',
  running: 'text-success',
  waiting_on_dependency: 'text-muted-foreground',
  waiting_on_worker: 'text-warning',
  waiting_on_review: 'text-primary',
  waiting_on_approval: 'text-warning',
  paused: 'text-muted-foreground',
  retrying: 'text-warning',
  partially_completed: 'text-warning',
  completed: 'text-success',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  expired: 'text-destructive',
}

const when = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleString())
const usd = (n: number) => `$${n.toFixed(2)}`

export default function OfficeSessionsPage() {
  const { t } = useI18n()
  const [view, setView] = useState<SessionOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [slot] = useState(1)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setView(await officeSessionOverview(slot))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('sess.readError'))
    } finally {
      setBusy(false)
    }
  }, [slot, t])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t('sess.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('sess.subtitle')}
            {view && (
              <>
                {' '}
                <span className={view.realMoney ? 'text-destructive' : 'text-muted-foreground'}>{view.realMoney ? t('sess.realMoney', { chain: view.chainName }) : t('sess.noValue', { chain: view.chainName })}</span>
              </>
            )}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={load} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!view && !error && <p className="text-sm text-muted-foreground">{t('sess.loading')}</p>}
      {view && (
        <>
          <Inbox view={view} reload={load} />
          <Metrics view={view} />
          <Sessions view={view} reload={load} />
          <div className="grid gap-4 md:grid-cols-2">
            <Workers view={view} reload={load} />
            <Tools view={view} reload={load} />
          <Budget view={view} />
          </div>
          <RepoCare view={view} reload={load} />
          <NewSession view={view} reload={load} />
          <div className="grid gap-4 md:grid-cols-2">
            <Policy view={view} reload={load} />
            <Memory view={view} />
          </div>
        </>
      )}
    </div>
  )
}

function Inbox({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const [acting, setActing] = useState<string | null>(null)
  const decide = async (sessionId: string, approvalId: string, granted: boolean) => {
    setActing(approvalId)
    try {
      const r = await decideSessionApproval(sessionId, approvalId, granted, granted ? undefined : 'denied by owner on the inbox')
      if (!r.ok) alert(r.error)
      await reload()
    } finally {
      setActing(null)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> {t('sess.inbox')} {view.inbox.length > 0 && <span className="rounded bg-warning/20 px-1.5 text-xs text-warning">{view.inbox.length}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {view.inbox.length === 0 && <p className="text-sm text-muted-foreground">{t('sess.inboxEmpty')}</p>}
        {view.inbox.map((i) => (
          <div key={i.approvalId} className="rounded border border-border p-3 text-sm space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{i.taskTitle}</span> <span className="text-muted-foreground">· {usd(i.amountUsd)} · {i.outcome}</span>
                <div className="text-xs text-muted-foreground">
                  <Link className="underline" href={`/office/sessions/${i.sessionId}`}>
                    {i.sessionGoal.slice(0, 80)}
                  </Link>{' '}
                  · {t('sess.asked', { at: when(i.requestedAt) })}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" type="button" disabled={acting === i.approvalId} onClick={() => decide(i.sessionId, i.approvalId, true)}>
                  <Check className="h-3.5 w-3.5" /> {t('sess.approve')}
                </Button>
                <Button size="sm" type="button" variant="outline" disabled={acting === i.approvalId} onClick={() => decide(i.sessionId, i.approvalId, false)}>
                  <X className="h-3.5 w-3.5" /> {t('sess.deny')}
                </Button>
              </div>
            </div>
            <ul className="list-disc pl-5 text-xs">
              {i.reasons.map((r, k) => (
                <li key={k}>{r}</li>
              ))}
            </ul>
            {i.changedFiles.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Files: {i.changedFiles.slice(0, 12).join(', ')}
                {i.changedFiles.length > 12 ? ` (+${i.changedFiles.length - 12})` : ''}
              </p>
            )}
            {i.diff && (
              <details>
                <summary className="cursor-pointer text-xs">Show diff</summary>
                <pre className="mt-1 max-h-72 overflow-auto rounded bg-secondary p-2 text-[11px]">{i.diff}</pre>
              </details>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function Sessions({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const act = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
    await reload()
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('sess.sessions')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {view.sessions.length === 0 && <p className="text-sm text-muted-foreground">{t('sess.sessionsEmpty')}</p>}
        {view.sessions.map((s) => {
          const live = !STATUS_META[s.status].terminal
          return (
            <div key={s.id} className="flex flex-wrap items-start justify-between gap-2 rounded border border-border p-3 text-sm">
              <div className="min-w-0 flex-1">
                <Link className="font-medium underline" href={`/office/sessions/${s.id}`}>
                  {s.goal.slice(0, 120)}
                </Link>
                <div className="text-xs text-muted-foreground">
                  <span className={TONE[s.status]}>{t(`sess.status.${s.status}`)}</span>
                  {s.statusReason ? ` — ${s.statusReason}` : ''} · {t(`sess.kindOf.${s.kind}`)} · {t('sess.wave', { n: s.wave })} · {t('sess.tasksOf', { done: s.tasksDone, total: s.tasksTotal })} ·{' '}
                  {t('sess.ofBudget', { spent: usd(s.spentUsd), budget: usd(s.budgetLimitUsd) })}
                  {s.liveRuns > 0 ? ` · ${t('sess.runsLive', { n: s.liveRuns })}` : ''}
                  {s.openApprovals > 0 ? ` · ${t('sess.awaitingYou', { n: s.openApprovals })}` : ''}
                  {live && s.nextWakeAt ? ` · ${t('sess.nextCheck', { at: when(s.nextWakeAt) })}` : ''}
                </div>
              </div>
              {live && (
                <div className="flex gap-1">
                  {s.status === 'paused' ? (
                    <Button size="sm" type="button" variant="outline" onClick={() => act(() => resumeSession(s.id))}>
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button size="sm" type="button" variant="outline" onClick={() => act(() => pauseSession(s.id))}>
                      <Pause className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button size="sm" type="button" variant="outline" onClick={() => confirm(t('sess.confirmCancel')) && act(() => cancelSession(s.id))}>
                    <XCircle className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function Workers({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const yn = (v: boolean) => (v ? t('sess.yes') : t('sess.no'))
  const [agents, setAgents] = useState<Array<{ id: string; name: string; runtimeType: string | null }>>([])
  const [agentId, setAgentId] = useState('')
  const [workdir, setWorkdir] = useState('')
  const [verify, setVerify] = useState('')
  const [shell, setShell] = useState(true)
  const [network, setNetwork] = useState(false)
  const [install, setInstall] = useState(false)
  const [gitPush, setGitPush] = useState(false)
  const [perTask, setPerTask] = useState('3')
  const [daily, setDaily] = useState('20')
  const [command, setCommand] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    myLocalAgents().then(setAgents).catch(() => setAgents([]))
  }, [])
  const connect = async () => {
    setBusy(true)
    try {
      const r = await connectWorkspaceWorker({
        agentId,
        slot: view.slot,
        workdir,
        verifyCommand: verify || null,
        grant: { write: true, shell, network, install, secrets: false, gitPush, externalPayments: false, perTaskLimitUsd: Number(perTask), dailyLimitUsd: Number(daily) },
      })
      if (!r.ok) alert(r.error)
      else setCommand(r.command)
      await reload()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Plug className="h-4 w-4" /> {t('sess.fleet')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {view.workers.length === 0 && <p className="text-muted-foreground">{t('sess.fleetEmpty')}</p>}
        {view.workers.map((w) => (
          <div key={w.agentId} className="rounded border border-border p-2">
            <div className="flex items-center justify-between">
              <span className="font-medium">{w.name}</span>
              <span className={w.alive ? 'text-success' : 'text-muted-foreground'}>{w.alive ? t('sess.online') : w.lastPollAt ? t('sess.offlineSince', { at: when(w.lastPollAt) }) : t('sess.neverPolled')}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {w.harnessId ?? t('sess.noHarness')} · {w.grant.workdir} ·{' '}
              {t('sess.grantLine', {
                write: yn(w.grant.write),
                shell: yn(w.grant.shell),
                network: yn(w.grant.network),
                install: yn(w.grant.install),
                push: yn(w.grant.gitPush),
              })}{' '}
              · {t('sess.perTask', { amount: usd(w.grant.perTaskLimitUsd) })} · {t('sess.perDay', { amount: usd(w.grant.dailyLimitUsd) })}
              {w.verifyCommand ? ` · ${t('sess.verifyIs', { command: w.verifyCommand })}` : ''}
            </div>
          </div>
        ))}
        <details className="rounded border border-dashed border-border p-2">
          <summary className="cursor-pointer">{t('sess.connectTitle')}</summary>
          <div className="mt-2 space-y-2">
            <label className="block text-xs">
              {t('sess.agent')}
              <select className="mt-1 w-full rounded border border-border bg-background p-1" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">{t('sess.choose')}</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.runtimeType ?? 'platform'})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              {t('sess.workdir')}
              <input className="mt-1 w-full rounded border border-border bg-background p-1" value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/home/me/code/my-repo" />
            </label>
            <label className="block text-xs">
              {t('sess.verifyCommand')}
              <input className="mt-1 w-full rounded border border-border bg-background p-1" value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="npm test" />
            </label>
            <div className="grid grid-cols-2 gap-1 text-xs">
              <label>
                <input type="checkbox" checked={shell} onChange={(e) => setShell(e.target.checked)} /> {t('sess.grantShell')}
              </label>
              <label>
                <input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} /> {t('sess.grantNetwork')}
              </label>
              <label>
                <input type="checkbox" checked={install} onChange={(e) => setInstall(e.target.checked)} /> {t('sess.grantInstall')}
              </label>
              <label>
                <input type="checkbox" checked={gitPush} onChange={(e) => setGitPush(e.target.checked)} /> {t('sess.grantPush')}
              </label>
              <label>
                $/task <input className="w-16 rounded border border-border bg-background p-0.5" value={perTask} onChange={(e) => setPerTask(e.target.value)} />
              </label>
              <label>
                $/day <input className="w-16 rounded border border-border bg-background p-0.5" value={daily} onChange={(e) => setDaily(e.target.value)} />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{t('sess.neverGranted')}</p>
            <Button size="sm" type="button" disabled={!agentId || !workdir || busy} onClick={connect}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />} {t('sess.connect')}
            </Button>
            {command && (
              <div className="space-y-1">
                <p className="text-xs">{t('sess.runOnce')}</p>
                <pre className="overflow-auto rounded bg-secondary p-2 text-[11px]">{command}</pre>
              </div>
            )}
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

function Budget({ view }: { view: SessionOverview }) {
  const { t } = useI18n()
  const live = view.sessions.filter((s) => !STATUS_META[s.status].terminal)
  const committed = live.reduce((n, s) => n + s.budgetLimitUsd, 0)
  const spent = view.sessions.reduce((n, s) => n + s.spentUsd, 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="h-4 w-4" /> {t('sess.budget')}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm space-y-1">
        <div>{t('sess.paidToday', { spent: usd(view.spentTodayUsd), cap: usd(view.policy.dailyBudgetUsd) })}</div>
        <div>{t('sess.ofWhichAuto', { amount: usd(view.autoApprovedTodayUsd) })}</div>
        <div>{t('sess.committed', { amount: usd(committed) })}</div>
        <div>{t('sess.spentAll', { amount: usd(spent) })}</div>
        <div className="text-xs text-muted-foreground">{t('sess.singleTaskNote', { amount: usd(view.policy.singleTaskLimitUsd) })}</div>
      </CardContent>
    </Card>
  )
}

function NewSession({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const [goal, setGoal] = useState('')
  const [kind, setKind] = useState<SessionKind>('local_coding')
  const [budget, setBudget] = useState('5')
  const [workerAgentId, setWorkerAgentId] = useState(view.workers[0]?.agentId ?? '')
  const [hours, setHours] = useState('')
  const [everyMin, setEveryMin] = useState('60')
  const [triggers, setTriggers] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const start = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await startOfficeSession({
        slot: view.slot,
        kind,
        goal,
        budgetLimitUsd: Number(budget),
        workerAgentId: workerAgentId || null,
        deadlineHours: hours ? Number(hours) : null,
        schedule: kind === 'scheduled' ? { kind: 'interval', everyMs: Math.max(1, Number(everyMin)) * 60_000 } : null,
        triggers: kind === 'event_driven' ? triggers.split(/[\n,]/).map((t) => t.trim()).filter(Boolean) : [],
      })
      if (!r.ok) setMsg(r.error)
      else {
        setMsg(t('sess.started', { id: r.session.id }))
        setGoal('')
      }
      await reload()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('sess.giveGoal')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <textarea className="w-full rounded border border-border bg-background p-2" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('sess.goalPlaceholder')} />
        <div className="flex flex-wrap gap-2 text-xs">
          <label>
            {t('sess.kind')}{' '}
            <select className="rounded border border-border bg-background p-1" value={kind} onChange={(e) => setKind(e.target.value as SessionKind)}>
              <option value="local_coding">{t('sess.kindLocalCoding')}</option>
              <option value="one_shot">{t('sess.kindOneShot')}</option>
              <option value="long_running">{t('sess.kindLongRunning')}</option>
              <option value="scheduled">{t('sess.kindScheduled')}</option>
              <option value="event_driven">{t('sess.kindEventDriven')}</option>
            </select>
          </label>
          <label>
            {t('sess.worker')}{' '}
            <select className="rounded border border-border bg-background p-1" value={workerAgentId} onChange={(e) => setWorkerAgentId(e.target.value)}>
              <option value="">{t('sess.none')}</option>
              {view.workers.map((w) => (
                <option key={w.agentId} value={w.agentId}>
                  {w.name} {w.alive ? t('sess.workerOnline') : t('sess.workerOffline')}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('sess.budgetField')} <input className="w-16 rounded border border-border bg-background p-1" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
          <label>
            {t('sess.deadlineField')} <input className="w-16 rounded border border-border bg-background p-1" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="—" />
          </label>
          {kind === 'scheduled' && (
            <label>
              {t('sess.everyField')} <input className="w-16 rounded border border-border bg-background p-1" value={everyMin} onChange={(e) => setEveryMin(e.target.value)} />
            </label>
          )}
        </div>
        {kind === 'event_driven' && (
          <label className="block text-xs">
            {t('sess.wakesOn')}
            <input
              className="mt-1 w-full rounded border border-border bg-background p-1 font-mono"
              value={triggers}
              onChange={(e) => setTriggers(e.target.value)}
              placeholder="github:owner/repo:issues.opened, github:owner/repo:ci.failed, http:nightly"
            />
            <span className="text-muted-foreground">{t('sess.triggerHelp')}</span>
          </label>
        )}
        <Button size="sm" type="button" disabled={busy || goal.trim().length < 10} onClick={start}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} {t('sess.start')}
        </Button>
        {msg && <p className="text-xs">{msg}</p>}
      </CardContent>
    </Card>
  )
}

function Policy({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [raw, setRaw] = useState(JSON.stringify(view.policy, null, 2))
  const [msg, setMsg] = useState<string | null>(null)
  const save = async () => {
    const r = await saveOfficePolicy(view.slot, raw)
    setMsg(r.ok ? t('sess.saved') : r.error)
    if (r.ok) {
      setEditing(false)
      await reload()
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> {t('sess.policy')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!editing && <Posture view={view} reload={reload} />}
        {editing && <textarea className="w-full rounded border border-border bg-background p-2 font-mono text-[11px]" rows={18} value={raw} onChange={(e) => setRaw(e.target.value)} />}
        <div className="flex gap-2">
          {!editing ? (
            <Button size="sm" type="button" variant="outline" onClick={() => setEditing(true)}>
              {t('sess.editJson')}
            </Button>
          ) : (
            <>
              <Button size="sm" type="button" onClick={save}>
                {t('sess.save')}
              </Button>
              <Button size="sm" type="button" variant="outline" onClick={() => setEditing(false)}>
                {t('sess.cancel')}
              </Button>
            </>
          )}
        </div>
        {msg && <p className="text-xs">{msg}</p>}
      </CardContent>
    </Card>
  )
}

function Memory({ view }: { view: SessionOverview }) {
  const { t } = useI18n()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Brain className="h-4 w-4" /> {t('sess.learned')}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {view.memory.length === 0 && <p className="text-muted-foreground">{t('sess.learnedEmpty')}</p>}
        <ul className="space-y-1 text-xs">
          {view.memory
            .slice()
            .reverse()
            .map((l, i) => (
              <li key={i}>
                <span className="rounded bg-secondary px-1">{l.kind}</span> {l.text}
              </li>
            ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function Tools({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const [label, setLabel] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [toolName, setToolName] = useState('')
  const [purpose, setPurpose] = useState<'consult' | 'notify'>('notify')
  const [authHeader, setAuthHeader] = useState('')
  const [events, setEvents] = useState<string[]>(['APPROVAL_REQUESTED', 'SESSION_COMPLETED'])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const attach = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await attachOfficeTool({ officeSlot: view.slot, label, serverUrl, toolName, purpose, events, authHeader: authHeader || null })
      setMsg(r.ok ? null : r.error)
      if (r.ok) {
        setLabel('')
        setServerUrl('')
        setToolName('')
        setAuthHeader('')
      }
      await reload()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Plug className="h-4 w-4" /> {t('sess.tools')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {view.tools.length === 0 && <p className="text-muted-foreground">{t('sess.toolsEmpty')}</p>}
        {view.tools.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-xs">
            <span className="min-w-0">{describeBinding(b)}</span>
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={async () => {
                await detachOfficeTool(b.id)
                await reload()
              }}
            >
              {t('sess.toolDetach')}
            </Button>
          </div>
        ))}
        <details className="rounded border border-dashed border-border p-2">
          <summary className="cursor-pointer text-xs">{t('sess.toolsAttach')}</summary>
          <div className="mt-2 space-y-2 text-xs">
            <label className="block">
              {t('sess.toolPurpose')}
              <select className="mt-1 w-full rounded border border-border bg-background p-1" value={purpose} onChange={(e) => setPurpose(e.target.value as 'consult' | 'notify')}>
                <option value="notify">{t('sess.toolNotify')}</option>
                <option value="consult">{t('sess.toolConsult')}</option>
              </select>
            </label>
            <label className="block">
              {t('sess.toolLabel')}
              <input className="mt-1 w-full rounded border border-border bg-background p-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Pager" />
            </label>
            <label className="block">
              {t('sess.toolServer')}
              <input className="mt-1 w-full rounded border border-border bg-background p-1 font-mono" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
            </label>
            <label className="block">
              {t('sess.toolName')}
              <input className="mt-1 w-full rounded border border-border bg-background p-1 font-mono" value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder="send_message" />
            </label>
            <label className="block">
              {t('sess.toolAuth')}
              <input className="mt-1 w-full rounded border border-border bg-background p-1 font-mono" type="password" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} placeholder="Bearer …" />
            </label>
            {purpose === 'notify' && (
              <div>
                {t('sess.toolEvents')}
                <div className="mt-1 grid grid-cols-2 gap-1">
                  {NOTIFIABLE_EVENTS.map((e) => (
                    <label key={e}>
                      <input
                        type="checkbox"
                        checked={events.includes(e)}
                        onChange={(ev) => setEvents((prev) => (ev.target.checked ? [...prev, e] : prev.filter((x) => x !== e)))}
                      />{' '}
                      {t(`sess.status.${e === 'APPROVAL_REQUESTED' ? 'waiting_on_approval' : e === 'SESSION_COMPLETED' ? 'completed' : e === 'SESSION_FAILED' ? 'failed' : e === 'SESSION_EXPIRED' ? 'expired' : 'running'}`)}{' '}
                      <code className="text-[10px] text-muted-foreground">{e}</code>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <p className="text-muted-foreground">{t('sess.toolNever')}</p>
            <Button size="sm" type="button" disabled={busy || !label || !serverUrl || !toolName} onClick={attach}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />} {t('sess.toolAttach')}
            </Button>
            {msg && <p className="text-destructive">{msg}</p>}
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

function Metrics({ view }: { view: SessionOverview }) {
  const { t } = useI18n()
  const lines = metricLines(view.metrics)
  const tone = (x: string) => (x === 'good' ? 'text-success' : x === 'warn' ? 'text-warning' : x === 'bad' ? 'text-destructive' : '')
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="h-4 w-4" /> {t('sess.metrics')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-5">
          {lines.map((l) => (
            <div key={l.key} className="bg-card px-3 py-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{t(`sess.m.${l.key}`)}</div>
              <div className={`text-lg font-semibold ${tone(l.tone)}`}>{l.value}</div>
              <div className="text-[10px] text-muted-foreground">{l.sub}</div>
            </div>
          ))}
        </div>
        <p className="text-sm">{metricsSentence(view.metrics)}</p>
        <p className="text-xs text-muted-foreground">{t('sess.metricsNote')}</p>
      </CardContent>
    </Card>
  )
}

function Posture({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const current = view.policyWords.preset
  const pick = async (p: PolicyPreset) => {
    setBusy(p)
    try {
      await setOfficePolicyPreset(view.slot, p)
      await reload()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium">
        {t('sess.posture')}: {current ? t(`sess.posture${current.charAt(0).toUpperCase()}${current.slice(1)}`) : t('sess.postureEdited')}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {POLICY_PRESETS.map((p) => (
          <div key={p} className={`rounded border p-2 text-xs ${current === p ? 'border-primary' : 'border-border'}`}>
            <div className="font-medium">{t(`sess.posture${p.charAt(0).toUpperCase()}${p.slice(1)}`)}</div>
            <p className="mt-1 text-muted-foreground">{PRESET_BLURBS[p]}</p>
            {current !== p && (
              <Button className="mt-2" size="sm" type="button" variant="outline" disabled={busy !== null} onClick={() => pick(p)}>
                {busy === p ? <Loader2 className="h-3 w-3 animate-spin" /> : null} {t('sess.useThis')}
              </Button>
            )}
          </div>
        ))}
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <PolicyList title={t('sess.settlesItself')} items={view.policyWords.allowed} tone="text-success" />
        <PolicyList title={t('sess.comesToYou')} items={view.policyWords.asks} tone="text-warning" />
        <PolicyList title={t('sess.neverAllowed')} items={view.policyWords.never} tone="text-destructive" />
      </div>
      <p className="text-xs text-muted-foreground">
        {t('sess.policyBudget')}: {view.policyWords.budget}
      </p>
    </div>
  )
}

function PolicyList({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div>
      <div className={`font-medium ${tone}`}>{title}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
        {items.map((i, k) => (
          <li key={k}>{i}</li>
        ))}
      </ul>
    </div>
  )
}

function RepoCare({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const [repo, setRepo] = useState('')
  const [labels, setLabels] = useState('')
  const [perWave, setPerWave] = useState('3')
  const [every, setEvery] = useState('720')
  const [openPrs, setOpenPrs] = useState(true)
  const [worker, setWorker] = useState(view.workers[0]?.agentId ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const start = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await startRepoCare({
        slot: view.slot,
        repoFullName: repo,
        workerAgentId: worker,
        labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
        maxPerWave: Number(perWave),
        verifyCommand: view.workers.find((w) => w.agentId === worker)?.verifyCommand ?? null,
        openPrs,
        budgetLimitUsd: 5,
        everyMinutes: Number(every),
      })
      setMsg(r.ok ? t('sess.started', { id: r.session.id }) : r.error)
      if (r.ok) setRepo('')
      await reload()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <GitPullRequest className="h-4 w-4" /> {t('sess.repoCare')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">{t('sess.repoCareBlurb')}</p>
        {view.workers.length === 0 ? (
          <p className="text-warning">{t('sess.repoNeedsWorker')}</p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs">
                {t('sess.repo')}
                <input className="mt-1 w-full rounded border border-border bg-background p-1 font-mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="acme/api" />
              </label>
              <label className="block text-xs">
                {t('sess.worker')}
                <select className="mt-1 w-full rounded border border-border bg-background p-1" value={worker} onChange={(e) => setWorker(e.target.value)}>
                  {view.workers.map((w) => (
                    <option key={w.agentId} value={w.agentId}>
                      {w.name} {w.alive ? t('sess.workerOnline') : t('sess.workerOffline')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                {t('sess.repoLabels')}
                <input className="mt-1 w-full rounded border border-border bg-background p-1" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="good first issue, docs" />
              </label>
              <div className="flex gap-2 text-xs">
                <label>
                  {t('sess.repoPerWave')} <input className="mt-1 w-14 rounded border border-border bg-background p-1" value={perWave} onChange={(e) => setPerWave(e.target.value)} />
                </label>
                <label>
                  {t('sess.repoEvery')} <input className="mt-1 w-20 rounded border border-border bg-background p-1" value={every} onChange={(e) => setEvery(e.target.value)} />
                </label>
              </div>
            </div>
            <label className="block text-xs">
              <input type="checkbox" checked={openPrs} onChange={(e) => setOpenPrs(e.target.checked)} /> {t('sess.repoPrs')}
            </label>
            <p className="text-xs text-muted-foreground">{t('sess.repoNeedsApp')}</p>
            <Button size="sm" type="button" disabled={busy || !repo.includes('/') || !worker} onClick={start}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitPullRequest className="h-3.5 w-3.5" />} {t('sess.repoStart')}
            </Button>
            {msg && <p className="text-xs">{msg}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}
