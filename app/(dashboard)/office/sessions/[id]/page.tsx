'use client'
/**
 * One session: its timeline (the event log, verbatim), the live run (the
 * harness's own lines as they arrive on the poll), the task graph with
 * every verdict, the approvals with the evidence they were decided on, and
 * the artifacts by hash. Nothing here is derived from anything but the
 * record; the "integrity" line says whether replaying that record gives
 * the state shown.
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2, RefreshCw, Check, X, Pause, Play, XCircle, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cancelSession, decideSessionApproval, officeSessionDetail, pauseSession, resumeSession, tickSessionNow, type SessionDetail } from '@/app/actions/office-session'
import { STATUS_META, sessionSentence } from '@/lib/office-session'
import { useI18n } from '@/lib/i18n'

const when = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleString())
const usd = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`)

export default function OfficeSessionDetailPage() {
  const { t: tr } = useI18n()
  const params = useParams<{ id: string }>()
  const id = params.id
  const [d, setD] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await officeSessionDetail(id)
      if (!r) setError('No such session on this account.')
      else setD(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the session.')
    } finally {
      setBusy(false)
    }
  }, [id])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5_000)
    return () => clearInterval(t)
  }, [load])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!d) return <p className="text-sm text-muted-foreground">{tr('sess.loading')}</p>
  const s = d.state.session
  const terminal = STATUS_META[s.status].terminal
  const tasks = Object.values(d.state.tasks).sort((a, b) => a.createdAt - b.createdAt)
  const runs = Object.values(d.state.runs).sort((a, b) => b.dispatchedAt - a.dispatchedAt)
  const liveRun = runs.find((r) => r.status === 'dispatched' || r.status === 'started' || r.status === 'running') ?? runs[0] ?? null
  const approvals = Object.values(d.state.approvals).sort((a, b) => b.requestedAt - a.requestedAt)
  const artifacts = Object.values(d.state.artifacts).sort((a, b) => b.createdAt - a.createdAt)
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
    await load()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href="/office/sessions" className="text-xs text-muted-foreground underline">
            ← {tr('sess.sessions')}
          </Link>
          <h1 className="text-lg font-semibold">{s.goal.slice(0, 160)}</h1>
          <p className="text-sm">
            <span className="font-medium">{tr(`sess.status.${s.status}`)}</span> — {sessionSentence(s)}
          </p>
          <p className="text-xs text-muted-foreground">
            {tr(`sess.kindOf.${s.kind}`)} · {tr('sess.wave', { n: s.wave })} · created {when(s.createdAt)} · started {when(s.startedAt)} · last heartbeat {when(s.lastHeartbeatAt)} · next wake {when(s.nextWakeAt)} · deadline {when(s.deadlineAt)} ·{' '}
            {tr('sess.ofBudget', { spent: usd(s.spentUsd), budget: usd(s.budgetLimitUsd) })} · checkpoint {s.checkpointId ?? '—'} · policy {s.approvalPolicyId} ·{' '}
            {d.integrity ? (d.integrity.ok ? 'replay matches' : `INTEGRITY: ${d.integrity.violations.join('; ') || 'materialized state is behind the log'}`) : 'integrity unchecked'}
          </p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" type="button" variant="outline" onClick={load} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          {!terminal && (
            <>
              <Button size="sm" type="button" variant="outline" title="Run one heartbeat now" onClick={() => act(() => tickSessionNow(id))}>
                <Zap className="h-3.5 w-3.5" />
              </Button>
              {s.status === 'paused' ? (
                <Button size="sm" type="button" variant="outline" onClick={() => act(() => resumeSession(id))}>
                  <Play className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button size="sm" type="button" variant="outline" onClick={() => act(() => pauseSession(id))}>
                  <Pause className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button size="sm" type="button" variant="outline" onClick={() => confirm(tr('sess.confirmCancel')) && act(() => cancelSession(id))}>
                <XCircle className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>

      {approvals.some((a) => a.decidedAt === null && (a.policyOutcome === 'REQUIRE_OWNER' || a.policyOutcome === 'REQUIRE_REVIEWER')) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tr('sess.yourDecision')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {approvals
              .filter((a) => a.decidedAt === null)
              .map((a) => {
                const t = d.state.tasks[a.taskId]
                return (
                  <div key={a.id} className="rounded border border-border p-2 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="font-medium">{t?.title ?? a.taskId}</span> · {usd(a.amountUsd)} · {a.policyOutcome}
                      </span>
                      <div className="flex gap-2">
                        <Button size="sm" type="button" onClick={() => act(() => decideSessionApproval(id, a.id, true))}>
                          <Check className="h-3.5 w-3.5" /> {tr('sess.approve')}
                        </Button>
                        <Button size="sm" type="button" variant="outline" onClick={() => act(() => decideSessionApproval(id, a.id, false, 'denied by owner'))}>
                          <X className="h-3.5 w-3.5" /> {tr('sess.deny')}
                        </Button>
                      </div>
                    </div>
                    <ul className="list-disc pl-5 text-xs">
                      {a.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                    {t?.outcome?.diff && (
                      <details>
                        <summary className="cursor-pointer text-xs">{tr('sess.diff')}</summary>
                        <pre className="max-h-80 overflow-auto rounded bg-secondary p-2 text-[11px]">{t.outcome.diff.slice(0, 40_000)}</pre>
                      </details>
                    )}
                  </div>
                )
              })}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tr('sess.tasks')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {tasks.map((t) => (
              <div key={t.id} className="rounded border border-border p-2">
                <div className="flex flex-wrap justify-between gap-1">
                  <span className="font-medium">{t.title}</span>
                  <span className="text-xs">
                    {t.status.replace(/_/g, ' ')}
                    {t.statusReason ? ` — ${t.statusReason}` : ''}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {tr('sess.wave', { n: t.wave })} · {t.kind} · {t.settlement} · {usd(t.bountyUsd)} · risk {t.riskTier} · attempt {t.attempts}/{t.maxAttempts}
                  {t.dependsOn.length ? ` · after ${t.dependsOn.join(', ')}` : ''}
                  {t.verify.command ? ` · verify: ${t.verify.command}` : ''}
                  {t.specHash ? ` · job ${t.onchainJobId ?? t.specHash.slice(0, 10)}` : ''}
                </div>
                {t.outcome && (
                  <div className="mt-1 text-xs">
                    {t.outcome.tests && (
                      <div>
                        tests: <span className={t.outcome.tests.passed ? 'text-success' : t.outcome.tests.passed === false ? 'text-destructive' : ''}>{t.outcome.tests.passed === null ? 'not run' : t.outcome.tests.passed ? 'pass' : 'FAIL'}</span> (`{t.outcome.tests.command}` exit {t.outcome.tests.exitCode})
                      </div>
                    )}
                    {t.outcome.review && (
                      <div>
                        review ({t.outcome.review.reviewer}): {t.outcome.review.approve === null ? 'no answer' : t.outcome.review.approve ? 'APPROVE' : 'REVISE'} — {t.outcome.review.note.slice(0, 300)}
                      </div>
                    )}
                    {t.outcome.changedFiles.length > 0 && <div>files: {t.outcome.changedFiles.slice(0, 15).join(', ')}</div>}
                    {t.outcome.contentHash && <div>sha256 {t.outcome.contentHash.slice(0, 16)}…</div>}
                    {t.outcome.costUsd !== null && <div>harness cost ${t.outcome.costUsd.toFixed(4)}</div>}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {tr('sess.liveRun')} {liveRun ? `· ${liveRun.id}` : ''}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {!liveRun && <p className="text-muted-foreground">{tr('sess.noRunYet')}</p>}
            {liveRun && (
              <div className="text-xs text-muted-foreground">
                {liveRun.status} · worker {liveRun.workerAgentId} · {liveRun.harnessId ?? 'harness ?'} · attempt {liveRun.attempt} · dispatched {when(liveRun.dispatchedAt)} · started {when(liveRun.startedAt)} · heartbeat {when(liveRun.lastHeartbeatAt)}
                {liveRun.finishedAt ? ` · finished ${when(liveRun.finishedAt)} exit ${liveRun.exitCode}` : ''}
                {liveRun.resumedFromCheckpointId ? ` · resumed from ${liveRun.resumedFromCheckpointId}` : ''}
                {liveRun.checkpointId ? ` · checkpoint ${liveRun.checkpointId}` : ''}
                {liveRun.changedFiles.length ? ` · ${liveRun.changedFiles.length} file(s)` : ''}
                {liveRun.costUsd !== null ? ` · $${liveRun.costUsd.toFixed(4)}` : ''}
                {liveRun.tokensUsed !== null ? ` · ${liveRun.tokensUsed} tokens` : ''}
              </div>
            )}
            <pre className="max-h-96 overflow-auto rounded bg-secondary p-2 text-[11px]">
              {d.runLog
                .filter((l) => !liveRun || l.runId === liveRun.id)
                .slice(-200)
                .map((l) => `${new Date(l.at).toLocaleTimeString()} [${l.kind}] ${l.text}${l.path ? `  (${l.path})` : ''}`)
                .join('\n') || 'nothing reported yet'}
            </pre>
            {runs.length > 1 && (
              <details>
                <summary className="cursor-pointer text-xs">All runs ({runs.length})</summary>
                <ul className="text-xs">
                  {runs.map((r) => (
                    <li key={r.id}>
                      {r.id} · {r.status} · attempt {r.attempt} · {when(r.dispatchedAt)}
                      {r.failureCode ? ` · ${r.failureCode}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tr('sess.timeline')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="max-h-[32rem] space-y-1 overflow-auto text-xs">
              {d.events
                .slice()
                .reverse()
                .map((e) => (
                  <li key={e.id}>
                    <span className="text-muted-foreground">{new Date(e.occurredAt).toLocaleTimeString()}</span> <span className="font-medium">{e.type}</span>{' '}
                    <span className="text-muted-foreground">
                      {e.actorType}
                      {summary(e.payload)}
                    </span>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tr('sess.approvalsArtifacts')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {approvals.map((a) => (
              <div key={a.id} className="rounded border border-border p-2">
                <div>
                  <span className="font-medium">{d.state.tasks[a.taskId]?.title ?? a.taskId}</span> · policy {a.policyId} v{a.policyVersion} → {a.policyOutcome} · decided by {a.decidedBy ?? 'nobody yet'}
                  {a.decidedAt ? ` (${a.granted ? 'granted' : 'denied'}, ${when(a.decidedAt)})` : ''} · {usd(a.amountUsd)}
                  {a.moved ? ` · moved ${usd(a.moved.amountUsd)}${a.moved.txHash ? ` ${a.moved.txHash.slice(0, 12)}…` : ''}` : ' · nothing moved'}
                </div>
                <details>
                  <summary className="cursor-pointer">{tr('sess.evidenceRead')}</summary>
                  <pre className="overflow-auto rounded bg-secondary p-1">{JSON.stringify(a.evidence, null, 1)}</pre>
                </details>
              </div>
            ))}
            {artifacts.map((a) => (
              <div key={a.id} className="rounded border border-border p-2">
                <div>
                  {a.kind} · {a.name} · {a.bytes} bytes · sha256 {a.sha256.slice(0, 16)}… · {when(a.createdAt)}
                </div>
                {a.inline && (
                  <details>
                    <summary className="cursor-pointer">{tr('sess.show')}</summary>
                    <pre className="max-h-64 overflow-auto rounded bg-secondary p-1">{a.inline.slice(0, 20_000)}</pre>
                  </details>
                )}
              </div>
            ))}
            {approvals.length === 0 && artifacts.length === 0 && <p className="text-muted-foreground">{tr('sess.noneYet')}</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function summary(p: Record<string, unknown>): string {
  const keys = ['taskId', 'runId', 'reason', 'status', 'policyOutcome', 'ok', 'plannedUsd', 'amountUsd', 'at', 'checkpointId', 'kind', 'name']
  const parts: string[] = []
  for (const k of keys) {
    if (p[k] === undefined || p[k] === null) continue
    const v = p[k]
    parts.push(`${k}=${typeof v === 'number' && k === 'at' ? new Date(v).toLocaleTimeString() : String(v).slice(0, 80)}`)
  }
  return parts.length ? ` — ${parts.join(' · ')}` : ''
}
