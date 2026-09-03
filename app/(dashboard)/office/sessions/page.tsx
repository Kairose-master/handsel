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
import { Loader2, RefreshCw, Play, Pause, XCircle, Check, X, Plug, ShieldCheck, Brain, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  cancelSession,
  connectWorkspaceWorker,
  decideSessionApproval,
  myLocalAgents,
  officeSessionOverview,
  pauseSession,
  resumeSession,
  saveOfficePolicy,
  startOfficeSession,
  type SessionOverview,
} from '@/app/actions/office-session'
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
      setError(e instanceof Error ? e.message : 'Could not read the office.')
    } finally {
      setBusy(false)
    }
  }, [slot])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Office sessions</h1>
          <p className="text-sm text-muted-foreground">
            What this office is doing, what it does next, and where it needs you.
            {view && (
              <>
                {' '}
                <span className={view.realMoney ? 'text-destructive' : 'text-muted-foreground'}>{view.realMoney ? `REAL MONEY (${view.chainName})` : `${view.chainName} — no monetary value`}</span>
              </>
            )}
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
          <Inbox view={view} reload={load} />
          <Sessions view={view} reload={load} />
          <div className="grid gap-4 md:grid-cols-2">
            <Workers view={view} reload={load} />
            <Budget view={view} />
          </div>
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
          <ShieldCheck className="h-4 w-4" /> Needs your decision {view.inbox.length > 0 && <span className="rounded bg-warning/20 px-1.5 text-xs text-warning">{view.inbox.length}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {view.inbox.length === 0 && <p className="text-sm text-muted-foreground">Nothing is waiting on you. Sessions inside their policy settle by themselves and appear in the timeline as done.</p>}
        {view.inbox.map((i) => (
          <div key={i.approvalId} className="rounded border border-border p-3 text-sm space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{i.taskTitle}</span> <span className="text-muted-foreground">· {usd(i.amountUsd)} · {i.outcome}</span>
                <div className="text-xs text-muted-foreground">
                  <Link className="underline" href={`/office/sessions/${i.sessionId}`}>
                    {i.sessionGoal.slice(0, 80)}
                  </Link>{' '}
                  · asked {when(i.requestedAt)}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" type="button" disabled={acting === i.approvalId} onClick={() => decide(i.sessionId, i.approvalId, true)}>
                  <Check className="h-3.5 w-3.5" /> Approve
                </Button>
                <Button size="sm" type="button" variant="outline" disabled={acting === i.approvalId} onClick={() => decide(i.sessionId, i.approvalId, false)}>
                  <X className="h-3.5 w-3.5" /> Deny
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
        <CardTitle className="text-base">Sessions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {view.sessions.length === 0 && <p className="text-sm text-muted-foreground">No session yet. Connect a worker below and give the office a goal.</p>}
        {view.sessions.map((s) => {
          const live = !STATUS_META[s.status].terminal
          return (
            <div key={s.id} className="flex flex-wrap items-start justify-between gap-2 rounded border border-border p-3 text-sm">
              <div className="min-w-0 flex-1">
                <Link className="font-medium underline" href={`/office/sessions/${s.id}`}>
                  {s.goal.slice(0, 120)}
                </Link>
                <div className="text-xs text-muted-foreground">
                  <span className={TONE[s.status]}>{s.status.replace(/_/g, ' ')}</span>
                  {s.statusReason ? ` — ${s.statusReason}` : ''} · {s.kind.replace(/_/g, ' ')} · wave {s.wave} · {s.tasksDone}/{s.tasksTotal} tasks · {usd(s.spentUsd)} of {usd(s.budgetLimitUsd)}
                  {s.liveRuns > 0 ? ` · ${s.liveRuns} run live` : ''}
                  {s.openApprovals > 0 ? ` · ${s.openApprovals} awaiting you` : ''}
                  {live && s.nextWakeAt ? ` · next check ${when(s.nextWakeAt)}` : ''}
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
                  <Button size="sm" type="button" variant="outline" onClick={() => confirm('Cancel this session? Live runs are told to stop.') && act(() => cancelSession(s.id))}>
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
          <Plug className="h-4 w-4" /> Worker fleet
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {view.workers.length === 0 && <p className="text-muted-foreground">No worker is connected to this office with a workspace.</p>}
        {view.workers.map((w) => (
          <div key={w.agentId} className="rounded border border-border p-2">
            <div className="flex items-center justify-between">
              <span className="font-medium">{w.name}</span>
              <span className={w.alive ? 'text-success' : 'text-muted-foreground'}>{w.alive ? '● online' : w.lastPollAt ? `offline (last ${when(w.lastPollAt)})` : 'never polled'}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {w.harnessId ?? 'no harness reported'} · {w.grant.workdir} · edit {w.grant.write ? 'yes' : 'no'} · shell {w.grant.shell ? 'yes' : 'no'} · network {w.grant.network ? 'yes' : 'no'} · install{' '}
              {w.grant.install ? 'yes' : 'no'} · push {w.grant.gitPush ? 'yes' : 'no'} · {usd(w.grant.perTaskLimitUsd)}/task · {usd(w.grant.dailyLimitUsd)}/day
              {w.verifyCommand ? ` · verify: ${w.verifyCommand}` : ''}
            </div>
          </div>
        ))}
        <details className="rounded border border-dashed border-border p-2">
          <summary className="cursor-pointer">Connect Claude Code on your machine</summary>
          <div className="mt-2 space-y-2">
            <label className="block text-xs">
              Agent
              <select className="mt-1 w-full rounded border border-border bg-background p-1" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">— choose —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.runtimeType ?? 'platform'})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              Working directory (absolute path on your machine — the boundary of everything a run may touch)
              <input className="mt-1 w-full rounded border border-border bg-background p-1" value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/home/me/code/my-repo" />
            </label>
            <label className="block text-xs">
              Verification command (run after every task; exit 0 = pass)
              <input className="mt-1 w-full rounded border border-border bg-background p-1" value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="npm test" />
            </label>
            <div className="grid grid-cols-2 gap-1 text-xs">
              <label>
                <input type="checkbox" checked={shell} onChange={(e) => setShell(e.target.checked)} /> shell / tests (E2)
              </label>
              <label>
                <input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} /> network (E3)
              </label>
              <label>
                <input type="checkbox" checked={install} onChange={(e) => setInstall(e.target.checked)} /> install packages (E3)
              </label>
              <label>
                <input type="checkbox" checked={gitPush} onChange={(e) => setGitPush(e.target.checked)} /> git push (E3)
              </label>
              <label>
                $/task <input className="w-16 rounded border border-border bg-background p-0.5" value={perTask} onChange={(e) => setPerTask(e.target.value)} />
              </label>
              <label>
                $/day <input className="w-16 rounded border border-border bg-background p-0.5" value={daily} onChange={(e) => setDaily(e.target.value)} />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">Secrets and external payments are never granted from here. Money movement, deploys and production changes always wait for you.</p>
            <Button size="sm" type="button" disabled={!agentId || !workdir || busy} onClick={connect}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />} Connect
            </Button>
            {command && (
              <div className="space-y-1">
                <p className="text-xs">Run this once on the machine that holds the working directory (the token is shown once):</p>
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
  const live = view.sessions.filter((s) => !STATUS_META[s.status].terminal)
  const committed = live.reduce((n, s) => n + s.budgetLimitUsd, 0)
  const spent = view.sessions.reduce((n, s) => n + s.spentUsd, 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="h-4 w-4" /> Budget
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm space-y-1">
        <div>
          Paid out today: <span className="font-medium">{usd(view.spentTodayUsd)}</span> of {usd(view.policy.dailyBudgetUsd)} daily
        </div>
        <div>
          Of which auto-approved by policy: <span className="font-medium">{usd(view.autoApprovedTodayUsd)}</span>
        </div>
        <div>Budget committed to live sessions: {usd(committed)}</div>
        <div>Spent across all sessions: {usd(spent)}</div>
        <div className="text-xs text-muted-foreground">
          Single task limit {usd(view.policy.singleTaskLimitUsd)}. Internal tasks (your own worker on your own machine) cost nothing here; their harness cost is recorded on the task when the harness reports it.
        </div>
      </CardContent>
    </Card>
  )
}

function NewSession({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
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
        setMsg(`Session ${r.session.id} started.`)
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
        <CardTitle className="text-base">Give the office a goal</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <textarea className="w-full rounded border border-border bg-background p-2" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Find and fix the auth bug in the refresh endpoint, add a regression test, and make npm test pass." />
        <div className="flex flex-wrap gap-2 text-xs">
          <label>
            Kind{' '}
            <select className="rounded border border-border bg-background p-1" value={kind} onChange={(e) => setKind(e.target.value as SessionKind)}>
              <option value="local_coding">local coding (Claude Code on your machine)</option>
              <option value="one_shot">one shot</option>
              <option value="long_running">long running</option>
              <option value="scheduled">scheduled</option>
              <option value="event_driven">event driven</option>
            </select>
          </label>
          <label>
            Worker{' '}
            <select className="rounded border border-border bg-background p-1" value={workerAgentId} onChange={(e) => setWorkerAgentId(e.target.value)}>
              <option value="">— none —</option>
              {view.workers.map((w) => (
                <option key={w.agentId} value={w.agentId}>
                  {w.name} {w.alive ? '(online)' : '(offline)'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Budget $ <input className="w-16 rounded border border-border bg-background p-1" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
          <label>
            Deadline (h) <input className="w-16 rounded border border-border bg-background p-1" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="—" />
          </label>
          {kind === 'scheduled' && (
            <label>
              Every (min) <input className="w-16 rounded border border-border bg-background p-1" value={everyMin} onChange={(e) => setEveryMin(e.target.value)} />
            </label>
          )}
        </div>
        {kind === 'event_driven' && (
          <label className="block text-xs">
            Wakes on (comma-separated)
            <input
              className="mt-1 w-full rounded border border-border bg-background p-1 font-mono"
              value={triggers}
              onChange={(e) => setTriggers(e.target.value)}
              placeholder="github:owner/repo:issues.opened, github:owner/repo:ci.failed, http:nightly"
            />
            <span className="text-muted-foreground">
              GitHub names fire from the App&apos;s webhook (issues.opened · issues.labeled:&lt;label&gt; · pull_request.opened · ci.failed · ci.passed · push); an{' '}
              <code>http:</code> name fires from <code>POST /api/office/sessions/trigger</code> with a worker token.
            </span>
          </label>
        )}
        <Button size="sm" type="button" disabled={busy || goal.trim().length < 10} onClick={start}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Start session
        </Button>
        {msg && <p className="text-xs">{msg}</p>}
      </CardContent>
    </Card>
  )
}

function Policy({ view, reload }: { view: SessionOverview; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [raw, setRaw] = useState(JSON.stringify(view.policy, null, 2))
  const [msg, setMsg] = useState<string | null>(null)
  const save = async () => {
    const r = await saveOfficePolicy(view.slot, raw)
    setMsg(r.ok ? 'Saved.' : r.error)
    if (r.ok) {
      setEditing(false)
      await reload()
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Approval policy
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!editing && <pre className="overflow-auto rounded bg-secondary p-2 text-[11px] whitespace-pre-wrap">{view.policyText}</pre>}
        {editing && <textarea className="w-full rounded border border-border bg-background p-2 font-mono text-[11px]" rows={18} value={raw} onChange={(e) => setRaw(e.target.value)} />}
        <div className="flex gap-2">
          {!editing ? (
            <Button size="sm" type="button" variant="outline" onClick={() => setEditing(true)}>
              Edit as JSON
            </Button>
          ) : (
            <>
              <Button size="sm" type="button" onClick={save}>
                Save
              </Button>
              <Button size="sm" type="button" variant="outline" onClick={() => setEditing(false)}>
                Cancel
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Brain className="h-4 w-4" /> What this office learned
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {view.memory.length === 0 && <p className="text-muted-foreground">Nothing yet. Lessons are derived from finished sessions — which worker delivered, what it cost, where a person had to step in — and fold into the next session&apos;s brief.</p>}
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
