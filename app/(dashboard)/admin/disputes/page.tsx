'use client'

import { useCallback, useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { getDisputedJobs } from '@/app/actions/labor'

type DisputedJob = {
  id: number
  title: string
  description: string | null
  acceptanceCriteria: string | null
  disputeNote: string | null
  attachmentUrl: string | null
  attachmentName: string | null
  testCode: string | null
  testResult: { passed: boolean | null; output: string; gradedAt: string } | null
  bounty: number
  requester: string
  worker: string
  output: string | null
}

export default function DisputesAdminPage() {
  const [jobs, setJobs] = useState<DisputedJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const rows = await getDisputedJobs()
    setJobs(rows as DisputedJob[])
  }, [])

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [refresh])


  if (loading) return <div className="p-8">Loading…</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <ShieldAlert className="size-7" /> Dispute Review
        </h1>
        <p className="text-muted-foreground mt-1">
          Independent review — neither the requester nor the worker. Read the acceptance criteria
          against the real submitted output, then force-settle the escrow.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open disputes.</p>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <div key={job.id} className="rounded-lg border border-border p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">
                  #{job.id} · {job.title}
                </span>
                <span className="font-mono text-sm text-muted-foreground">${job.bounty.toLocaleString()}</span>
              </div>

              {job.description && <p className="text-sm text-muted-foreground">{job.description}</p>}

              {job.acceptanceCriteria && (
                <div className="rounded-md bg-secondary/40 p-3 text-xs">
                  <p className="font-medium mb-1">Acceptance criteria</p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{job.acceptanceCriteria}</p>
                </div>
              )}

              {job.attachmentUrl && (
                <a
                  href={job.attachmentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  📎 {job.attachmentName ?? 'Source attachment'} — open the original the worker was given
                </a>
              )}

              <div className="rounded-md bg-secondary/40 p-3 text-xs">
                <p className="font-medium mb-1">Real submitted output</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{job.output ?? '(no output recorded)'}</p>
              </div>

              {job.disputeNote && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
                  <p className="font-medium mb-1 text-destructive">Requester&apos;s dispute reason</p>
                  <p className="text-muted-foreground">{job.disputeNote}</p>
                </div>
              )}

              {job.testResult && (
                <div
                  className={`rounded-md p-3 text-xs ${
                    job.testResult.passed === true
                      ? 'border border-success/30 bg-success/5'
                      : job.testResult.passed === false
                        ? 'border border-destructive/30 bg-destructive/5'
                        : 'border border-warning/30 bg-warning/5'
                  }`}
                >
                  <p className="font-medium mb-1">
                    Objective evidence — acceptance tests{' '}
                    {job.testResult.passed === true ? 'PASSED' : job.testResult.passed === false ? 'FAILED' : 'ungraded (runtime unavailable)'}
                    {' '}(run by the platform runtime, independent of both parties)
                  </p>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                    {job.testResult.output}
                  </pre>
                  {job.testCode && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-muted-foreground">Show the tests</summary>
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">{job.testCode}</pre>
                    </details>
                  )}
                </div>
              )}

              <p className="font-mono text-[11px] text-muted-foreground">
                requester {job.requester.slice(0, 8)}… · worker {job.worker.slice(0, 8)}…
              </p>

              <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">
                  No buttons here any more — and that is the change.
                </p>
                <p>
                  A dispute is decided by the published rule at{' '}
                  <a href="/disputes" className="text-primary hover:underline">
                    /disputes
                  </a>
                  , or by the deadline, which pays the worker. Clicking to choose an outcome was the
                  centralization point this market exists to remove, and a page that offers the click
                  will keep being used.
                </p>
                <p className="mt-2">
                  The authority has not gone anywhere: the operator still holds the arbiter key and
                  can settle any job with a direct call. Making that deliberate and logged, rather
                  than one button among many, is the point. Emergencies use{' '}
                  <code className="font-mono">POST /api/admin/resolve-stuck-job</code>.
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
