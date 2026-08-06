'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, FlaskConical, Play, CheckCircle2, XCircle, Check, X } from 'lucide-react'
import {
  getVerifiedTasks,
  startVerifiedTask,
  reclaimVerifiedTask,
  acceptVerifiedTaskProposal,
  rejectVerifiedTaskProposal,
} from '@/app/actions/verified'
import { useI18n } from '@/lib/i18n'

type Task = {
  id: string
  solver: string
  requester: string
  iAmSolver: boolean
  iAmRequester: boolean
  difficulty: number
  problem: string
  bountyUsd: number
  status: string
  submittedAnswer: string | null
  answer: string | null
  postTxHash: string | null
  settleTxHash: string | null
  error: string | null
  createdAt: string | Date
}

type MyAgent = { id: string; name: string; provisioned: boolean }

const ACTIVE = new Set(['posting', 'awaiting_solver', 'solving', 'settling'])

const STATUS_STYLE: Record<string, string> = {
  posting: 'bg-warning/15 text-warning',
  awaiting_solver: 'bg-warning/15 text-warning',
  solving: 'bg-primary/15 text-primary',
  settling: 'bg-chart-2/15 text-chart-2',
  completed: 'bg-success/15 text-success',
  failed: 'bg-destructive/15 text-destructive',
  declined: 'bg-muted text-muted-foreground',
  error: 'bg-muted text-muted-foreground',
}

export default function VerifyPage() {
  const { t } = useI18n()
  const [configured, setConfigured] = useState(true)
  const [explorer, setExplorer] = useState('https://sepolia.etherscan.io')
  const [tasks, setTasks] = useState<Task[]>([])
  const [myAgents, setMyAgents] = useState<MyAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [solverId, setSolverId] = useState('')
  const [requesterId, setRequesterId] = useState('')
  const [difficulty, setDifficulty] = useState('3')
  const [bounty, setBounty] = useState('25')

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    const data = await getVerifiedTasks()
    setConfigured(data.configured)
    if (data.explorer) setExplorer(data.explorer)
    setTasks(data.tasks as Task[])
    setMyAgents(data.myAgents)
    return data.tasks as Task[]
  }, [])

  // Poll while any task is in flight.
  const schedulePoll = useCallback(
    (current: Task[]) => {
      if (pollRef.current) clearTimeout(pollRef.current)
      if (current.some((t) => ACTIVE.has(t.status))) {
        pollRef.current = setTimeout(async () => {
          try {
            schedulePoll(await refresh())
          } catch {
            /* transient */
          }
        }, 4000)
      }
    },
    [refresh],
  )

  useEffect(() => {
    refresh()
      .then(schedulePoll)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [refresh, schedulePoll])

  const provisioned = myAgents.filter((a) => a.provisioned)

  useEffect(() => {
    if (!solverId && provisioned[0]) setSolverId(provisioned[0].id)
    if (!requesterId && provisioned[1]) setRequesterId(provisioned[1].id)
  }, [provisioned, solverId, requesterId])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await startVerifiedTask({
        solverAgentId: solverId,
        requesterAgentId: requesterId,
        difficulty: parseInt(difficulty, 10) as 1 | 2 | 3 | 4 | 5,
        bountyUsd: parseFloat(bounty),
      })
      schedulePoll(await refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const accept = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await acceptVerifiedTaskProposal(id)
      schedulePoll(await refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const decline = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await rejectVerifiedTaskProposal(id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const reclaim = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await reclaimVerifiedTask(id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="p-8">{t('verify.loading')}</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <FlaskConical className="size-7" /> {t('verify.title')}
        </h1>
        <p className="text-muted-foreground mt-1">
          {t('verify.subtitle')}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="glass-card rounded-lg border border-border p-6">
        <h2 className="font-bold text-lg mb-3">{t('verify.runTask')}</h2>
        {!configured ? (
          <p className="text-sm text-muted-foreground">
            {t('verify.notConfiguredDeploy')} <code className="rounded bg-secondary px-1">VERIFIED_TASK_ESCROW_ADDRESS</code>{' '}
            {t('verify.notConfiguredEnable')} <code>contracts/README.md</code>.
          </p>
        ) : provisioned.length < 1 ? (
          <p className="text-sm text-muted-foreground">
            {t('verify.provisionHint')}
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <input
                list="verify-solver-agents"
                value={solverId}
                onChange={(e) => setSolverId(e.target.value)}
                placeholder={t('verify.solverIdPlaceholder')}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
              />
              <datalist id="verify-solver-agents">
                {provisioned.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </datalist>
              <p className="mt-1 text-[11px] text-muted-foreground">{t('verify.crossUserHint')}</p>
            </div>
            <select value={requesterId} onChange={(e) => setRequesterId(e.target.value)} className="h-9 rounded-md border border-border bg-background px-3 text-sm">
              {provisioned.map((a) => (
                <option key={a.id} value={a.id}>{t('verify.requesterOption', { name: a.name })}</option>
              ))}
            </select>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className="h-9 rounded-md border border-border bg-background px-3 text-sm">
              {[1, 2, 3, 4, 5].map((d) => (
                <option key={d} value={d}>{t('verify.difficultyOption', { level: d })}</option>
              ))}
            </select>
            <input value={bounty} onChange={(e) => setBounty(e.target.value)} type="number" min="1" placeholder={t('verify.bountyPlaceholder')} className="h-9 rounded-md border border-border bg-background px-3 text-sm" />
            <button
              onClick={start}
              disabled={busy || !solverId || !requesterId || solverId === requesterId || !bounty}
              className="md:col-span-4 inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {t('verify.escrowAndSolve')}
            </button>
            {solverId === requesterId && (
              <p className="md:col-span-4 text-xs text-warning">{t('verify.differentAgents')}</p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        {tasks.length === 0 && <p className="text-sm text-muted-foreground">{t('verify.noTasks')}</p>}
        {tasks.map((task) => (
          <div key={task.id} className="glass-card rounded-lg border border-border p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {task.status === 'completed' ? (
                    <CheckCircle2 className="size-4 text-success" />
                  ) : task.status === 'failed' || task.status === 'error' || task.status === 'declined' ? (
                    <XCircle className="size-4 text-destructive" />
                  ) : (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  )}
                  <span className="font-medium">{task.problem}</span>
                  <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[task.status] ?? ''}`}>
                    {task.status}
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground font-mono">
                  {t('verify.metaLine', { difficulty: task.difficulty, bounty: task.bountyUsd.toLocaleString(), solver: task.solver, requester: task.requester })}
                  {task.submittedAnswer !== null && ` ${t('verify.metaSubmitted', { answer: task.submittedAnswer })}`}
                  {task.answer !== null && ` ${t('verify.metaTruth', { answer: task.answer })}`}
                </p>
                {task.error && <p className="mt-1 text-xs text-destructive">{task.error}</p>}
                {task.status === 'awaiting_solver' && task.iAmSolver && (
                  <p className="mt-1 text-xs text-warning">{t('verify.awaitingYourResponse')}</p>
                )}
                <p className="mt-1 flex gap-3 text-xs">
                  {task.postTxHash && (
                    <a className="text-primary hover:underline" target="_blank" rel="noopener noreferrer" href={`${explorer}/tx/${task.postTxHash}`}>
                      {t('verify.escrowTx')}
                    </a>
                  )}
                  {task.settleTxHash && (
                    <a className="text-primary hover:underline" target="_blank" rel="noopener noreferrer" href={`${explorer}/tx/${task.settleTxHash}`}>
                      {t('verify.payoutTx')}
                    </a>
                  )}
                </p>
              </div>
              {task.status === 'awaiting_solver' && task.iAmSolver ? (
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => accept(task.id)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    <Check className="size-3.5" /> {t('verify.accept')}
                  </button>
                  <button
                    onClick={() => decline(task.id)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded bg-secondary px-3 py-1 text-xs font-medium hover:bg-secondary/70 disabled:opacity-50"
                  >
                    <X className="size-3.5" /> {t('verify.decline')}
                  </button>
                </div>
              ) : (
                (task.status === 'failed' || task.status === 'declined') && task.iAmRequester && (
                  <button
                    onClick={() => reclaim(task.id)}
                    disabled={busy}
                    className="shrink-0 rounded bg-secondary px-3 py-1 text-xs font-medium hover:bg-secondary/70 disabled:opacity-50"
                  >
                    {t('verify.reclaimEscrow')}
                  </button>
                )
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
