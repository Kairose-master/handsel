'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, Loader2, Play, Trash2, CheckCircle2, XCircle, Clock } from 'lucide-react'
import {
  createDelegationPlan,
  confirmDelegation,
  discardDelegation,
  getMyDelegations,
  getDelegationAgents,
} from '@/app/actions/delegate'
import { useI18n } from '@/lib/i18n'
import { graphToDsl } from '@/lib/collab-dsl'

type Delegations = Awaited<ReturnType<typeof getMyDelegations>>
type Delegation = Delegations[number]
type AgentOption = Awaited<ReturnType<typeof getDelegationAgents>>[number]

/**
 * Delegate — hand one big task to a prime agent; it decomposes the work,
 * subcontracts each piece as a real escrowed Labor Market job, verifies
 * what comes back, and assembles the final deliverable. The demand-side
 * twin of the Worker Console: /mine sells your machine's labor, this
 * page BUYS the market's labor at one remove.
 */
export default function DelegatePage() {
  const { t } = useI18n()
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [rows, setRows] = useState<Delegations>([])
  const [loading, setLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    // Fetched independently on purpose: one failing (e.g. delegations
    // table missing until migration) must not blank the other.
    try {
      setAgents(await getDelegationAgents())
    } catch {
      /* signed out mid-poll etc. */
    }
    try {
      setRows(await getMyDelegations())
    } catch {
      /* ignore */
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
    // The status read doubles as the verification/finalization tick, so
    // polling IS the orchestrator's heartbeat while this page is open.
    pollRef.current = setInterval(refresh, 8000)
    // Safety net: a slow first response must degrade to "show what we
    // have" (the next poll will fill in), never an indefinite spinner.
    const failsafe = setTimeout(() => setLoading(false), 10_000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      clearTimeout(failsafe)
    }
  }, [refresh])

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <GitBranch className="size-6" /> {t('delegate.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('delegate.subtitle')}</p>
      </div>

      <NewDelegationForm agents={agents} onCreated={refresh} />

      {loading ? (
        <div className="flex justify-center p-10">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        rows.map((d) => <DelegationCard key={d.id} d={d} onChanged={refresh} />)
      )}
    </div>
  )
}

function NewDelegationForm({ agents, onCreated }: { agents: AgentOption[]; onCreated: () => void }) {
  const { t } = useI18n()
  const [task, setTask] = useState('')
  const [budget, setBudget] = useState('20')
  const [agentId, setAgentId] = useState('')
  const [autoVerify, setAutoVerify] = useState(true)
  const [planning, setPlanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const provisioned = agents.filter((a) => a.provisioned)
  const effectiveAgentId = agentId || provisioned[0]?.id || ''

  const plan = async () => {
    setPlanning(true)
    setError(null)
    try {
      const r = await createDelegationPlan({
        primeAgentId: effectiveAgentId,
        task,
        budgetUsd: Number(budget),
        autoVerify,
      })
      if ('error' in r) {
        setError(r.error ?? 'Planning failed')
      } else {
        setTask('')
        onCreated()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanning(false)
    }
  }

  return (
    <div className="glass-card rounded-lg border border-border p-6">
      <p className="font-semibold">{t('delegate.form.title')}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t('delegate.form.description')}</p>

      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder={t('delegate.form.taskPlaceholder')}
        rows={3}
        className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          {t('delegate.form.agent')}
          <select
            value={effectiveAgentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="mt-1 block rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            {provisioned.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          {t('delegate.form.budget')}
          <input
            type="number"
            min="2"
            max="500"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="mt-1 block w-28 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={autoVerify} onChange={(e) => setAutoVerify(e.target.checked)} />
          {t('delegate.form.autoVerify')}
        </label>
        <button
          onClick={plan}
          disabled={planning || !task.trim() || !effectiveAgentId}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {planning ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />}
          {planning ? t('delegate.form.planning') : t('delegate.form.plan')}
        </button>
      </div>

      {provisioned.length === 0 && <p className="mt-2 text-sm text-warning">{t('delegate.form.noAgents')}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

function statusIcon(st: { failed?: boolean; output?: string | null; jobStatus: string | null }) {
  if (st.failed) return <XCircle className="size-4 text-destructive" />
  if (st.output != null) return <CheckCircle2 className="size-4 text-success" />
  return <Clock className="size-4 text-muted-foreground" />
}

function DelegationCard({ d, onChanged }: { d: Delegation; onChanged: () => void }) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOutput, setShowOutput] = useState(false)
  const [showDsl, setShowDsl] = useState(false)

  const confirm = async () => {
    setConfirming(true)
    setError(null)
    try {
      const r = await confirmDelegation(d.id)
      if ('error' in r && r.error) {
        setError(r.error)
      } else {
        onChanged()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConfirming(false)
    }
  }

  const discard = async () => {
    try {
      await discardDelegation(d.id)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const statusLabel =
    d.status === 'planned'
      ? t('delegate.status.planned')
      : d.status === 'posted'
        ? t('delegate.status.posted')
        : d.status === 'completed'
          ? t('delegate.status.completed')
          : d.status

  return (
    <div className="glass-card rounded-lg border border-border p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{d.task.length > 80 ? `${d.task.slice(0, 80)}…` : d.task}</span>
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-medium ${
            d.status === 'completed'
              ? 'bg-success/15 text-success'
              : d.status === 'posted'
                ? 'bg-primary/15 text-primary'
                : 'bg-secondary text-muted-foreground'
          }`}
        >
          {statusLabel}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {d.primeAgentName} · ${d.budgetUsd}
        </span>
      </div>

      {d.status !== 'planned' && d.cost && (
        <p className="mt-1 text-xs text-muted-foreground">
          ${d.cost.escrowedUsd.toFixed(2)} escrowed — paid ${d.cost.releasedUsd.toFixed(2)}, refunded ${d.cost.refundedUsd.toFixed(2)}, locked ${d.cost.lockedUsd.toFixed(2)}
          {' · '}gas $0 (sponsored) · fee $0
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {d.subtasks.map((st, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            {statusIcon(st)}
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {st.title} <span className="font-normal text-muted-foreground">— ${st.bountyUsd}</span>
                {st.payerLabel && (
                  <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    paid by {st.payerLabel}
                  </span>
                )}
                {st.jobStatus && (
                  <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                    {st.onchainJobId !== undefined ? `#${st.onchainJobId} · ` : ''}
                    {st.jobStatus}
                    {st.workerLabel ? ` · ${st.workerLabel}` : ''}
                  </span>
                )}
              </p>
              {st.reviewOf ? (
                <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <GitBranch className="size-3" />
                  peer review of “{st.reviewOf}”
                </p>
              ) : st.synthesizes?.length ? (
                <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <GitBranch className="size-3" />
                  assembles {st.synthesizes.join(', ')}
                </p>
              ) : st.parentTitle ? (
                <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <GitBranch className="size-3" />
                  subcontracted from “{st.parentTitle}”
                </p>
              ) : st.dependsOn?.length ? (
                <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <GitBranch className="size-3" />
                  builds on {st.dependsOn.join(', ')}
                  {st.output == null && !st.failed && st.onchainJobId === undefined && (
                    <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">waiting for upstream</span>
                  )}
                </p>
              ) : null}
              {st.revising && (
                <p className="mt-0.5 text-xs text-warning">
                  revision {st.revisionRound} — back with the worker, same job and same escrow
                </p>
              )}
              {st.awaitingReview && (
                <p className="mt-0.5 text-xs text-warning">
                  {st.reviewRerunTaskId
                    ? `revision ${st.revisionRound} back with the reviewer — escrow held`
                    : 'awaiting peer review — escrow held'}
                </p>
              )}
              {st.reviewVerdict === 'approve' && (
                <p className="mt-0.5 text-xs text-success">
                  peer-approved{st.revisionRound ? ` after ${st.revisionRound} revision${st.revisionRound === 1 ? '' : 's'}` : ''} — escrow released
                </p>
              )}
              {st.reviewVerdict === 'revise' && (
                <p className="mt-0.5 text-xs text-destructive">
                  {st.revisionRound
                    ? `still not approved after ${st.revisionRound} revision${st.revisionRound === 1 ? '' : 's'} — your call`
                    : 'peer requested revision'}
                  {st.reviewNote ? ` — ${st.reviewNote}` : ''}
                </p>
              )}
              {/* The conversation itself, oldest first — what was actually
                  asked for each round, so the owner deciding at the end can
                  see whether the reviewer kept moving the goalposts. */}
              {st.revisionNotes && st.revisionNotes.length > 0 && (
                <ol className="mt-1 space-y-0.5 border-l border-border pl-2 text-xs text-muted-foreground">
                  {st.revisionNotes.map((n, ri) => (
                    <li key={ri}>
                      <span className="font-mono tabular-nums">R{ri + 1}</span> {n}
                    </li>
                  ))}
                </ol>
              )}
              {st.failed && <p className="text-xs text-destructive">{st.failReason}</p>}
            </div>
          </li>
        ))}
      </ul>

      {d.subtasks.filter((s) => !s.isIntegration).length > 1 && (
        <div className="mt-3">
          <button
            onClick={() => setShowDsl(!showDsl)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <GitBranch className="size-3.5" />
            {showDsl ? 'Hide plan' : 'View as plan'}
            <span className="text-muted-foreground/60">— the collaboration each worker reads</span>
          </button>
          {showDsl && (
            <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-secondary/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
              {graphToDsl({ task: d.task, budgetUsd: d.budgetUsd, subtasks: d.subtasks })}
            </pre>
          )}
        </div>
      )}

      {d.status === 'planned' && (
        <div className="mt-4 flex gap-2">
          <button
            onClick={confirm}
            disabled={confirming}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {confirming ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            {confirming ? t('delegate.confirming') : t('delegate.confirm')}
          </button>
          <button
            onClick={discard}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-secondary"
          >
            <Trash2 className="size-3.5" /> {t('delegate.discard')}
          </button>
        </div>
      )}

      {d.finalOutput && (
        <div className="mt-4">
          <button onClick={() => setShowOutput(!showOutput)} className="text-sm font-medium text-primary hover:underline">
            {showOutput ? t('delegate.hideOutput') : t('delegate.showOutput')}
          </button>
          {showOutput && (
            <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-secondary/30 p-3 text-xs">
              {d.finalOutput}
            </pre>
          )}
        </div>
      )}

      {(error || d.error) && <p className="mt-2 text-sm text-destructive">{error ?? d.error}</p>}
    </div>
  )
}
