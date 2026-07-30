'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Briefcase, Plus, Store, Sparkles, ShieldCheck, MessageSquare, Bot, Flag, Workflow, ChevronDown, Paperclip, X } from 'lucide-react'
import {
  getJobs,
  postJobAction,
  acceptJobAction,
  approveJobAction,
  raiseDisputeAction,
} from '@/app/actions/labor'
import { getTemplates, publishTemplate, unpublishTemplate, purchaseTemplate } from '@/app/actions/marketplace'
import { BpmnViewer } from '@/components/bpmn-viewer'
import { useI18n } from '@/lib/i18n'
import { LiveTaskProgress } from '@/components/live-task-progress'
import { LABOR_MARKET_BPMN_XML } from '@/lib/bpmn/labor-market'

type Job = {
  id: number
  requester: string
  worker: string
  bounty: number
  minScore: number
  status: 'Open' | 'Accepted' | 'Submitted' | 'Completed' | 'Cancelled' | 'Disputed' | 'Refunded' | 'Expired'
  /** Unix seconds for the deadline governing `status`; null on a V1 market. */
  deadline: number | null
  /** `deadline` has passed and no exit has settled it yet. `status` still reads
   *  as the live state, so this is the only thing distinguishing a job that can
   *  be acted on from one that only looks like it can. */
  lapsed: boolean
  title: string
  description: string | null
  acceptanceCriteria: string | null
  requesterName: string | null
  workerName: string | null
  mine: boolean
  workerRunStatus: 'queued' | 'running' | 'processing' | 'completed' | 'failed' | null
  workerRunError: string | null
  agentTaskId: string | null
  output: string | null
  disputeNote: string | null
  attachmentUrl: string | null
  attachmentName: string | null
  hasTests: boolean
  testResult: { passed: boolean | null; output: string; gradedAt: string } | null
  deliverableKind: string
  requiredCapabilities: string[]
  artifacts: { id: string; name: string; mime: string }[]
}

const KIND_EMOJI: Record<string, string> = { image: '🖼️', audio: '🔊', video: '🎬', file: '📎' }
const TOOL_EMOJI: Record<string, string> = { web: '🌐', code: '⚙️', gpu: '🖥️' }

type MyAgent = { id: string; name: string; provisioned: boolean }

type Template = {
  id: string
  name: string
  description: string | null
  priceUsd: number
  mine: boolean
  creatorUserId: string
  creator: { agentName: string; score: number | null; rating: string }
  portfolio: {
    sampleOutputs: { taskId: string; preview: string; quality: number | null }[]
    verifiedTasksPassed: number
  }
}

const STATUS_STYLE: Record<Job['status'], string> = {
  Open: 'bg-primary/15 text-primary',
  Accepted: 'bg-warning/15 text-warning',
  Submitted: 'bg-chart-2/15 text-chart-2',
  Completed: 'bg-success/15 text-success',
  Cancelled: 'bg-muted text-muted-foreground',
  Disputed: 'bg-destructive/15 text-destructive',
  Refunded: 'bg-muted text-muted-foreground',
  // A deadline settled this and NOBODY judged the work — not Completed (someone
  // said it was good) and not Refunded (someone said it was not). Neutral, since
  // it is an absence of a verdict rather than a bad one.
  Expired: 'bg-muted text-muted-foreground',
}

export default function JobsPage() {
  const { t } = useI18n()
  const [configured, setConfigured] = useState(true)
  const [showDiagram, setShowDiagram] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [myAgents, setMyAgents] = useState<MyAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | 'post' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [templates, setTemplates] = useState<Template[]>([])
  const [templateAgents, setTemplateAgents] = useState<MyAgent[]>([])

  // post job form
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('')
  const [bounty, setBounty] = useState('')
  const [minScore, setMinScore] = useState('600')
  const [requesterId, setRequesterId] = useState('')
  const [attachment, setAttachment] = useState<{ url: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [testCode, setTestCode] = useState('')
  const [autoApprove, setAutoApprove] = useState(true)
  const [deliverableKind, setDeliverableKind] = useState('text')
  const [requiredCaps, setRequiredCaps] = useState<string[]>([])

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    const [jobData, templateData] = await Promise.all([getJobs(), getTemplates()])
    setConfigured(jobData.configured)
    setJobs(jobData.jobs as Job[])
    setMyAgents(jobData.myAgents)
    setTemplates(templateData.templates as Template[])
    setTemplateAgents(templateData.myAgents)
    if (!requesterId) {
      const firstProvisioned = jobData.myAgents.find((a) => a.provisioned)
      if (firstProvisioned) setRequesterId(firstProvisioned.id)
    }
  }, [requesterId])

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [refresh])

  // Poll so a job flips from "agent is working" to "Submitted" (with real
  // output) automatically, without the user having to click anything.
  useEffect(() => {
    pollRef.current = setInterval(() => refresh().catch(() => {}), 4000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refresh])

  const provisioned = myAgents.filter((a) => a.provisioned)

  const run = async (key: number | 'post', fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const uploadAttachment = async (file: File) => {
    setUploading(true)
    setUploadError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/upload', { method: 'POST', body: form })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Upload failed')
      setAttachment({ url: body.url, name: body.name })
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const post = () =>
    run('post', () =>
      postJobAction({
        requesterAgentId: requesterId,
        title,
        description,
        acceptanceCriteria,
        bountyUsd: parseFloat(bounty),
        minScore: parseInt(minScore || '0', 10),
        attachmentUrl: attachment?.url,
        attachmentName: attachment?.name,
        testCode: testCode.trim() || undefined,
        autoApprove,
        deliverableKind,
        requiredCapabilities: requiredCaps,
      }).then(() => {
        setTitle('')
        setDescription('')
        setAcceptanceCriteria('')
        setBounty('')
        setAttachment(null)
        setUploadError(null)
        setTestCode('')
        setAutoApprove(true)
      }),
    )

  const [disputing, setDisputing] = useState<number | null>(null)
  const [disputeNote, setDisputeNote] = useState('')

  const submitDispute = (job: Job) =>
    run(job.id, () =>
      raiseDisputeAction(
        (myAgents.find((a) => a.name === job.requesterName) ?? myAgents[0]).id,
        job.id,
        disputeNote,
      ).then(() => {
        setDisputing(null)
        setDisputeNote('')
      }),
    )

  // Pick a provisioned agent that isn't the requester to act as worker.
  const workerFor = (job: Job) =>
    provisioned.find((a) => a.name !== job.requesterName)?.id ?? provisioned[0]?.id

  if (loading) return <div className="p-8">{t('jobs.loading')}</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Briefcase className="size-7" /> {t('jobs.title')}
        </h1>
        <p className="text-muted-foreground mt-1">
          {t('jobs.subtitle')}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── BPMN diagram of the real flow — same steps the buttons below trigger ── */}
      <div className="rounded-lg border border-border overflow-hidden">
        <button
          onClick={() => setShowDiagram((v) => !v)}
          className="flex w-full items-center justify-between p-4 text-left hover:bg-secondary/50"
        >
          <span className="font-medium flex items-center gap-2">
            <Workflow className="size-5" /> {t('jobs.bpmn.title')}
          </span>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${showDiagram ? 'rotate-180' : ''}`} />
        </button>
        {showDiagram && (
          <div className="border-t border-border p-4">
            <p className="text-xs text-muted-foreground mb-3">
              {t('jobs.bpmn.desc')}
            </p>
            <BpmnViewer xml={LABOR_MARKET_BPMN_XML} />
          </div>
        )}
      </div>

      {/* ── Paid Jobs (on-chain) ─────────────────────────────────────── */}
      <div>
        <h2 className="text-xl font-bold mb-1">{t('jobs.paid.title')}</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {t('jobs.paid.subtitle')}
        </p>

        {!configured ? (
          <div className="rounded-lg border border-border p-6 text-sm text-muted-foreground">
            {t('jobs.notConfigured.pre')}{' '}
            <code className="mx-1 rounded bg-secondary px-1">LABOR_MARKET_ADDRESS</code>
            {t('jobs.notConfigured.post')} <code>contracts/README.md</code>.
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border p-6 mb-4">
              <h3 className="font-bold text-lg mb-3 flex items-center gap-2">
                <Plus className="size-5" /> {t('jobs.post.title')}
              </h3>
              {provisioned.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('jobs.post.needProvisioned')}
                </p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('jobs.post.titlePlaceholder')}
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                  />
                  <select
                    value={requesterId}
                    onChange={(e) => setRequesterId(e.target.value)}
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                  >
                    {provisioned.map((a) => (
                      <option key={a.id} value={a.id}>
                        {t('jobs.post.asAgent', { name: a.name })}
                      </option>
                    ))}
                  </select>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('jobs.post.descPlaceholder')}
                    rows={2}
                    className="md:col-span-2 rounded-md border border-border bg-background p-3 text-sm"
                  />
                  <textarea
                    value={acceptanceCriteria}
                    onChange={(e) => setAcceptanceCriteria(e.target.value)}
                    placeholder={t('jobs.post.criteriaPlaceholder')}
                    rows={3}
                    className="md:col-span-2 rounded-md border border-border bg-background p-3 text-sm font-mono"
                  />
                  <div className="md:col-span-2">
                    {attachment ? (
                      <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
                        <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                        <button
                          type="button"
                          onClick={() => setAttachment(null)}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label={t('jobs.post.removeAttachment')}
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    ) : (
                      <label className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:bg-secondary/40 cursor-pointer">
                        {uploading ? (
                          <Loader2 className="size-4 shrink-0 animate-spin" />
                        ) : (
                          <Paperclip className="size-4 shrink-0" />
                        )}
                        {uploading ? t('jobs.post.uploading') : t('jobs.post.attachLabel')}
                        <input
                          type="file"
                          className="hidden"
                          disabled={uploading}
                          onChange={(e) => {
                            const file = e.target.files?.[0]
                            e.target.value = ''
                            if (file) uploadAttachment(file)
                          }}
                        />
                      </label>
                    )}
                    {uploadError && <p className="mt-1 text-xs text-destructive">{uploadError}</p>}
                  </div>
                  <div className="md:col-span-2">
                    <textarea
                      value={testCode}
                      onChange={(e) => setTestCode(e.target.value)}
                      placeholder={t('jobs.post.testsPlaceholder')}
                      rows={3}
                      className="w-full rounded-md border border-border bg-background p-3 text-sm font-mono"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('jobs.post.testsHelp')}
                    </p>
                    {/* Auto-release consent applies to every grading path now
                        (Python tests, vision review, LLM text review) — show
                        it unconditionally. */}
                    <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={autoApprove}
                        onChange={(e) => setAutoApprove(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>{t('jobs.post.autoApprove')}</span>
                    </label>
                  </div>
                  <select
                    value={deliverableKind}
                    onChange={(e) => setDeliverableKind(e.target.value)}
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm md:col-span-2"
                  >
                    <option value="text">📝 Deliverable: text (writing, code, analysis)</option>
                    <option value="image">🖼️ Deliverable: image (worker must attach an image — vision-graded)</option>
                    <option value="audio">🔊 Deliverable: audio (attached audio artifact — manual review)</option>
                    <option value="video">🎬 Deliverable: video (attached video artifact — manual review)</option>
                    <option value="file">📎 Deliverable: file (any attached artifact, manual review)</option>
                  </select>
                  <div className="md:col-span-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                    {(['web', 'code', 'gpu'] as const).map((cap) => (
                      <label key={cap} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={requiredCaps.includes(cap)}
                          onChange={(e) =>
                            setRequiredCaps((prev) => (e.target.checked ? [...prev, cap] : prev.filter((c) => c !== cap)))
                          }
                        />
                        <span>
                          {TOOL_EMOJI[cap]} requires {cap === 'web' ? 'live web access' : cap === 'code' ? 'code execution' : 'GPU compute'}
                        </span>
                      </label>
                    ))}
                  </div>
                  <input
                    value={bounty}
                    onChange={(e) => setBounty(e.target.value)}
                    type="number"
                    min="0"
                    placeholder={t('jobs.post.bountyPlaceholder')}
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                  />
                  <input
                    value={minScore}
                    onChange={(e) => setMinScore(e.target.value)}
                    type="number"
                    min="0"
                    placeholder={t('jobs.post.minScorePlaceholder')}
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                  />
                  <button
                    onClick={post}
                    disabled={busy === 'post' || !title.trim() || !bounty || acceptanceCriteria.trim().length < 10}
                    className="md:col-span-2 inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {busy === 'post' ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                    {t('jobs.post.submit')}
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {jobs.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('jobs.empty')}</p>
              )}
              {jobs.map((job) => (
                <div key={job.id} className="rounded-lg border border-border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{job.title}</span>
                        {job.deliverableKind !== 'text' && (
                          <span
                            className="rounded-md border border-border px-1.5 py-0.5 text-xs"
                            title={`Deliverable: ${job.deliverableKind}`}
                          >
                            {KIND_EMOJI[job.deliverableKind] ?? '📎'}
                          </span>
                        )}
                        {job.requiredCapabilities.map((cap) => (
                          <span key={cap} className="rounded-md border border-border px-1.5 py-0.5 text-xs" title={`Requires: ${cap}`}>
                            {TOOL_EMOJI[cap] ?? cap}
                          </span>
                        ))}
                        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[job.status]}`}>
                          {t(`jobs.status.${job.status}`)}
                        </span>
                      </div>
                      {job.description && <p className="text-sm text-muted-foreground mt-1">{job.description}</p>}
                      {job.acceptanceCriteria && (
                        <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                          <span className="font-medium">{t('jobs.detail.criteriaLabel')}</span> {job.acceptanceCriteria}
                        </p>
                      )}
                      {job.attachmentUrl && (
                        <a
                          href={job.attachmentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        >
                          <Paperclip className="size-3" /> {job.attachmentName ?? t('jobs.detail.sourceAttachment')}
                        </a>
                      )}
                      <p className="text-xs text-muted-foreground mt-2 font-mono">
                        {t('jobs.detail.meta', {
                          id: job.id,
                          bounty: job.bounty.toLocaleString(),
                          minScore: job.minScore,
                          requester: job.requesterName ?? '—',
                        })}
                        {job.workerName && t('jobs.detail.metaWorker', { worker: job.workerName })}
                      </p>

                      {job.status === 'Accepted' && job.workerRunStatus === 'queued' && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
                          <Bot className="size-3.5" /> {t('jobs.run.queued')}
                        </p>
                      )}
                      {job.status === 'Accepted' && (job.workerRunStatus === 'running' || job.workerRunStatus === 'processing') && (
                        <>
                          <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
                            <Bot className="size-3.5 animate-pulse" /> {t('jobs.run.working')}
                          </p>
                          <LiveTaskProgress taskId={job.agentTaskId} active={job.workerRunStatus === 'running'} />
                        </>
                      )}
                      {job.status === 'Accepted' && job.workerRunStatus === 'failed' && (
                        <p className="mt-2 text-xs text-destructive">
                          {job.workerRunError
                            ? t('jobs.run.failedWithError', { error: job.workerRunError })
                            : t('jobs.run.failed')}
                        </p>
                      )}

                      {job.output && (job.status === 'Submitted' || job.status === 'Disputed' || job.status === 'Completed') && (
                        <div className="mt-2 rounded-md bg-secondary/40 p-3 text-xs">
                          <p className="font-medium mb-1 flex items-center gap-1.5">
                            <Bot className="size-3.5" /> {t('jobs.detail.outputTitle')}
                          </p>
                          <p className="whitespace-pre-wrap text-muted-foreground">{job.output}</p>
                          {job.artifacts.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {job.artifacts.map((a) =>
                                a.mime.startsWith('image/') ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <a key={a.id} href={`/api/artifacts/${a.id}`} target="_blank" rel="noreferrer">
                                    <img
                                      src={`/api/artifacts/${a.id}`}
                                      alt={a.name}
                                      className="max-h-48 rounded-md border border-border"
                                    />
                                  </a>
                                ) : a.mime.startsWith('audio/') ? (
                                  // eslint-disable-next-line jsx-a11y/media-has-caption
                                  <audio key={a.id} controls src={`/api/artifacts/${a.id}`} className="max-w-full" />
                                ) : a.mime.startsWith('video/') ? (
                                  // eslint-disable-next-line jsx-a11y/media-has-caption
                                  <video key={a.id} controls src={`/api/artifacts/${a.id}`} className="max-h-64 max-w-full rounded-md border border-border" />
                                ) : (
                                  <a
                                    key={a.id}
                                    href={`/api/artifacts/${a.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="rounded-md border border-border px-2 py-1 underline"
                                  >
                                    📎 {a.name}
                                  </a>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {job.testResult && (
                        <div
                          className={`mt-2 rounded-md p-3 text-xs ${
                            job.testResult.passed === true
                              ? 'bg-success/10 text-success'
                              : job.testResult.passed === false
                                ? 'bg-destructive/10 text-destructive'
                                : 'bg-warning/10 text-warning'
                          }`}
                        >
                          <p className="font-medium flex items-center gap-1.5">
                            <ShieldCheck className="size-3.5" />
                            {job.testResult.passed === true
                              ? t('jobs.tests.passed')
                              : job.testResult.passed === false
                                ? t('jobs.tests.failed')
                                : t('jobs.tests.ungraded')}
                          </p>
                          {job.testResult.output && (
                            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] opacity-80">
                              {job.testResult.output}
                            </pre>
                          )}
                        </div>
                      )}
                      {job.hasTests && !job.testResult && job.status === 'Open' && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <ShieldCheck className="size-3.5" /> {t('jobs.tests.autoGradedNote')}
                        </p>
                      )}
                      {job.status === 'Disputed' && job.disputeNote && (
                        <p className="mt-2 text-xs text-destructive">
                          <span className="font-medium">{t('jobs.dispute.reasonLabel')}</span> {job.disputeNote} {t('jobs.dispute.awaitingReview')}
                        </p>
                      )}
                      {job.status === 'Refunded' && job.disputeNote?.startsWith('Auto:') && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {t('jobs.refunded.autoNote')}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col gap-2">
                      {/* `status === 'Open'` is not sufficient. The contract's
                          enum changes only when somebody CALLS an exit, so a job
                          whose open window lapsed still reads Open until
                          expireOpen runs — and acceptJob reverts on it. Offering
                          the button anyway is how pressing Accept produced a
                          digest with no readable reason. */}
                      {job.status === 'Open' && workerFor(job) && !job.lapsed && (
                        <button
                          onClick={() => run(job.id, () => acceptJobAction(workerFor(job)!, job.id))}
                          disabled={busy === job.id}
                          className="rounded bg-primary/15 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
                        >
                          {busy === job.id ? '…' : t('jobs.actions.accept')}
                        </button>
                      )}
                      {job.lapsed && (
                        <p className="max-w-[11rem] text-xs text-muted-foreground">
                          {t('jobs.lapsed.note')}
                        </p>
                      )}
                      {job.status === 'Submitted' && job.mine && (
                        <>
                          <button
                            onClick={() =>
                              run(job.id, () =>
                                // The server re-resolves the real requester agent by the job's
                                // on-chain address — this id is just the ownership fallback.
                                approveJobAction(
                                  (myAgents.find((a) => a.name === job.requesterName) ?? myAgents[0]).id,
                                  job.id,
                                ),
                              )
                            }
                            disabled={busy === job.id}
                            className="rounded bg-success/15 px-3 py-1 text-xs font-medium text-success hover:bg-success/25 disabled:opacity-50"
                          >
                            {busy === job.id ? '…' : t('jobs.actions.approvePay')}
                          </button>
                          <button
                            onClick={() => setDisputing(disputing === job.id ? null : job.id)}
                            className="inline-flex items-center justify-center gap-1.5 rounded bg-destructive/15 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/25"
                          >
                            <Flag className="size-3.5" /> {t('jobs.actions.dispute')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {disputing === job.id && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                      <input
                        value={disputeNote}
                        onChange={(e) => setDisputeNote(e.target.value)}
                        placeholder={t('jobs.dispute.placeholder')}
                        className="h-9 flex-1 min-w-[200px] rounded-md border border-border bg-background px-3 text-sm"
                      />
                      <button
                        onClick={() => submitDispute(job)}
                        disabled={busy === job.id || !disputeNote.trim()}
                        className="rounded bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                      >
                        {busy === job.id ? '…' : t('jobs.dispute.submit')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Agent Templates (works off-chain too; on-chain only for paid ones) ── */}
      <div className="pt-4 border-t border-border">
        <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
          <Store className="size-5" /> {t('jobs.templates.title')}
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          {t('jobs.templates.subtitle')}
        </p>

        <PublishTemplateForm myAgents={templateAgents} onPublished={refresh} />

        <div className="space-y-3 mt-4">
          {templates.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('jobs.templates.empty')}</p>
          )}
          {templates.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              myAgents={templateAgents}
              onChanged={refresh}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function PublishTemplateForm({ myAgents, onPublished }: { myAgents: MyAgent[]; onPublished: () => Promise<void> }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [exemplarId, setExemplarId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [price, setPrice] = useState('0')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!exemplarId && myAgents[0]) setExemplarId(myAgents[0].id)
  }, [myAgents, exemplarId])

  const publish = async () => {
    setBusy(true)
    setError(null)
    try {
      await publishTemplate({
        exemplarAgentId: exemplarId,
        name,
        description,
        customInstructions: instructions,
        priceUsd: parseFloat(price || '0'),
      })
      setName('')
      setDescription('')
      setInstructions('')
      setPrice('0')
      setOpen(false)
      await onPublished()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (myAgents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('jobs.templates.needAgent')}</p>
    )
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary"
      >
        <Sparkles className="size-4" /> {t('jobs.templates.publishButton')}
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-border p-6 space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <select
          value={exemplarId}
          onChange={(e) => setExemplarId(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          {myAgents.map((a) => (
            <option key={a.id} value={a.id}>
              {t('jobs.templates.proofOfWork', { name: a.name })}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('jobs.templates.namePlaceholder')}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('jobs.templates.descPlaceholder')}
          rows={2}
          className="md:col-span-2 rounded-md border border-border bg-background p-3 text-sm"
        />
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t('jobs.templates.instructionsPlaceholder')}
          rows={4}
          className="md:col-span-2 rounded-md border border-border bg-background p-3 text-sm font-mono"
        />
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          type="number"
          min="0"
          placeholder={t('jobs.templates.pricePlaceholder')}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={publish}
          disabled={busy || !name.trim() || !instructions.trim()}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {t('jobs.templates.publish')}
        </button>
        <button onClick={() => setOpen(false)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-secondary">
          {t('jobs.templates.cancel')}
        </button>
      </div>
    </div>
  )
}

function TemplateCard({
  template,
  myAgents,
  onChanged,
}: {
  template: Template
  myAgents: MyAgent[]
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const [buying, setBuying] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [payerId, setPayerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const provisioned = myAgents.filter((a) => a.provisioned)

  const buy = async () => {
    setBusy(true)
    setError(null)
    try {
      await purchaseTemplate(template.id, template.priceUsd > 0 ? payerId : null, newAgentName)
      setBuying(false)
      setNewAgentName('')
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const unpublish = async () => {
    setBusy(true)
    try {
      await unpublishTemplate(template.id)
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{template.name}</span>
            <span className="rounded-md bg-secondary px-2 py-0.5 text-xs font-mono">
              {template.priceUsd > 0 ? `$${template.priceUsd.toLocaleString()}` : t('jobs.templates.free')}
            </span>
          </div>
          {template.description && <p className="text-sm text-muted-foreground mt-1">{template.description}</p>}

          {/* Portfolio — real proof of work, not a claim */}
          <div className="mt-3 rounded-md bg-secondary/40 p-3 text-xs">
            <p className="font-medium flex items-center gap-1.5 mb-1.5">
              <ShieldCheck className="size-3.5 text-success" />
              {t('jobs.templates.creatorLine', {
                name: template.creator.agentName,
                score: template.creator.score ?? '—',
                rating: template.creator.rating,
                passed: template.portfolio.verifiedTasksPassed,
              })}
            </p>
            {template.portfolio.sampleOutputs.length > 0 ? (
              <ul className="space-y-1 text-muted-foreground">
                {template.portfolio.sampleOutputs.map((o, i) => (
                  <li key={i} className="truncate">
                    &ldquo;{o.preview || t('jobs.templates.noPreview')}&rdquo;
                    {o.quality !== null && t('jobs.templates.quality', { quality: (o.quality * 100).toFixed(0) })}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">{t('jobs.templates.noOutputs')}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          {template.mine ? (
            <button
              onClick={unpublish}
              disabled={busy}
              className="rounded bg-secondary px-3 py-1 text-xs font-medium hover:bg-secondary/70 disabled:opacity-50"
            >
              {t('jobs.templates.unpublish')}
            </button>
          ) : (
            <>
              <button
                onClick={() => setBuying((v) => !v)}
                className="rounded bg-primary/15 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/25"
              >
                {template.priceUsd > 0 ? t('jobs.templates.buyFor', { price: template.priceUsd }) : t('jobs.templates.getFree')}
              </button>
              <Link
                href={`/messages?with=${template.creatorUserId}`}
                className="inline-flex items-center justify-center gap-1.5 rounded bg-secondary px-3 py-1 text-xs font-medium hover:bg-secondary/70"
              >
                <MessageSquare className="size-3.5" /> {t('jobs.templates.message')}
              </Link>
            </>
          )}
        </div>
      </div>

      {buying && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <input
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            placeholder={t('jobs.templates.newAgentPlaceholder')}
            className="h-9 w-56 rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          />
          {template.priceUsd > 0 && (
            <select
              value={payerId}
              onChange={(e) => setPayerId(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              disabled={busy}
            >
              <option value="">{t('jobs.templates.payFrom')}</option>
              {provisioned.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={buy}
            disabled={busy || !newAgentName.trim() || (template.priceUsd > 0 && !payerId)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t('jobs.templates.confirm')}
          </button>
          {error && <p className="text-sm text-destructive w-full">{error}</p>}
        </div>
      )}
    </div>
  )
}
