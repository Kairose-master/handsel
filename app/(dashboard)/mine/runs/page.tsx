'use client'

/**
 * The harness console.
 *
 * A local worker used to be a black box: you started it, it said "running",
 * and some minutes later a job was done or it was not. This is the window
 * into the middle — which phase the harness is in, which files it has
 * written, what it is printing, and what the machine it is running on is
 * doing.
 *
 * Every slot on this page is either a live row or absent. That is not a
 * style choice on a screen with this many gauges, it is the only way the
 * screen is worth anything: a console that fills an empty slot with a
 * plausible figure is a console you cannot use to decide whether to kill a
 * run. So a coverage ring nobody measures is not drawn faintly at 0%, it is
 * not drawn; an unmeasured token count prints no tile; and an ETA, which
 * nothing on record can predict, is simply not offered.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Cpu, FileCode2, MemoryStick, RefreshCw, Terminal } from 'lucide-react'
import { getHarnessRuns, type ConsoleRun } from '@/app/actions/harness-runs'
import { Chip, PageHead, Panel, Readout, StatusDot, type DeckTone } from '@/components/deck'
import {
  RUN_PHASES,
  elapsedLabel,
  furthestPhase,
  phaseIndex,
  runStatus,
  tokenLabel,
  touchedFiles,
  type RunStatus,
} from '@/lib/harness-run'

const STATUS_TONE: Record<RunStatus, DeckTone> = {
  running: 'accent',
  stalled: 'warn',
  passed: 'ok',
  failed: 'bad',
}

const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  // Not "Running" and not "Failed": the worker stopped talking, which is a
  // third thing and the one a person needs to act on.
  stalled: 'No signal',
  passed: 'Passed',
  failed: 'Failed',
}

/** Plan → Code → Test → Review → Deploy, with the reached steps filled. */
function PhaseRail({ at }: { at: number }) {
  return (
    <ol className="flex items-center gap-1.5">
      {RUN_PHASES.map((phase, i) => {
        const done = i < at
        const here = i === at
        return (
          <li key={phase} className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                here ? 'bg-primary' : done ? 'bg-[var(--success)]' : 'bg-border'
              }`}
            />
            <span
              className={`truncate font-mono text-[10px] uppercase tracking-[0.12em] ${
                here ? 'text-primary' : done ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {phase}
            </span>
            {i < RUN_PHASES.length - 1 && (
              <span className={`h-px min-w-2 flex-1 ${done ? 'bg-[var(--success)]' : 'bg-border'}`} />
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** A bar only when there is a reading. An empty gauge reads as "idle". */
function Gauge({ label, pct, caption }: { label: string; pct: number | null; caption: string | null }) {
  if (pct === null) {
    return (
      <div className="min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
        <div className="text-sm text-muted-foreground">not reported</div>
      </div>
    )
  }
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span aria-hidden className="h-1.5 w-full max-w-20 overflow-hidden rounded-full bg-secondary">
          <span
            className={`block h-full ${pct >= 90 ? 'bg-[var(--destructive)]' : pct >= 70 ? 'bg-[var(--warning)]' : 'bg-[var(--success)]'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="shrink-0 text-sm font-semibold tabular-nums">{caption ?? `${pct}%`}</span>
      </div>
    </div>
  )
}

function RunDetail({ item, now }: { item: ConsoleRun; now: number }) {
  const { run } = item
  const status = runStatus(run, now)
  const files = touchedFiles(run.events)
  const elapsed = elapsedLabel((run.finishedAt ?? now) - run.startedAt)
  const tokens = tokenLabel(run.tokensUsed)
  const logRef = useRef<HTMLDivElement>(null)

  // Follow the tail while it is live, the way a terminal does. Stops once
  // the run finishes so a finished log can be read from the top.
  useEffect(() => {
    if (status === 'running' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [run.events.length, status])

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <Panel
          title={item.title}
          actions={<StatusDot tone={STATUS_TONE[status]} label={STATUS_LABEL[status]} pulse={status === 'running'} />}
        >
          <PhaseRail at={phaseIndex(furthestPhase(run.events, run.phase))} />
        </Panel>

        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <Panel title="Files" icon={<FileCode2 />} bodyClassName="p-0">
            {files.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                Nothing written yet. Paths appear as <code>git status</code> sees them in the checkout.
              </p>
            ) : (
              <ul className="max-h-72 divide-y divide-border overflow-y-auto">
                {files.map((f) => (
                  <li key={f.path} className="truncate px-3 py-1.5 font-mono text-[11px]" title={f.path}>
                    {f.path}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Terminal" icon={<Terminal />} bodyClassName="p-0">
            <div ref={logRef} className="max-h-72 overflow-y-auto px-3 py-2">
              {run.events.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  The worker has not sent any output for this run. Older workers do not report it — update
                  <code className="ml-1">handsel-worker.mjs</code> to see the harness&rsquo;s own log here.
                </p>
              ) : (
                <ol className="space-y-0.5 font-mono text-[11px] leading-relaxed">
                  {run.events.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
                      </span>
                      <span
                        className={`min-w-0 break-words ${
                          e.level === 'good'
                            ? 'text-[var(--success)]'
                            : e.level === 'bad'
                              ? 'text-[var(--destructive)]'
                              : ''
                        }`}
                      >
                        {e.text}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </Panel>
        </div>
      </div>

      <div className="min-w-0 space-y-4">
        <Panel title="Summary">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Readout label="Elapsed" value={elapsed} />
            {/* Files changed comes off the submitted diff, so it only exists
                once there IS a diff — during a run there is nothing to count. */}
            {item.diff && (
              <Readout
                label="Files changed"
                value={
                  <>
                    {item.diff.files}{' '}
                    <span className="font-normal text-[var(--success)]">+{item.diff.additions}</span>{' '}
                    <span className="font-normal text-[var(--destructive)]">-{item.diff.deletions}</span>
                  </>
                }
              />
            )}
            {item.passed !== null && (
              <Readout
                label="Graded"
                value={item.passed ? 'Passed' : 'Not passed'}
                tone={item.passed ? 'ok' : 'bad'}
                hint="Returned by a grader that is not the worker"
              />
            )}
            {tokens && <Readout label="Tokens" value={tokens} />}
            <Gauge label="CPU" pct={run.sample.cpuPct} caption={null} />
            <Gauge
              label="Memory"
              pct={
                run.sample.memUsedMb !== null && run.sample.memTotalMb
                  ? Math.round((run.sample.memUsedMb / run.sample.memTotalMb) * 100)
                  : null
              }
              caption={
                run.sample.memUsedMb !== null && run.sample.memTotalMb
                  ? `${(run.sample.memUsedMb / 1024).toFixed(1)}/${Math.round(run.sample.memTotalMb / 1024)} GB`
                  : null
              }
            />
          </div>
        </Panel>

        <Panel title="Worker">
          <dl className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Agent</dt>
              <dd className="min-w-0 truncate font-medium">{item.agentName}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Harness</dt>
              <dd>{run.harnessId ? <Chip tone="accent">{run.harnessId}</Chip> : <Chip>built-in loop</Chip>}</dd>
            </div>
            {run.model && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Model</dt>
                <dd className="min-w-0 truncate font-mono text-xs">{run.model}</dd>
              </div>
            )}
            {item.taskStatus && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Task</dt>
                <dd>
                  <Chip>{item.taskStatus}</Chip>
                </dd>
              </div>
            )}
          </dl>
        </Panel>
      </div>
    </div>
  )
}

function Empty() {
  return (
    <div className="rounded-[var(--radius-md)] border border-dashed border-border px-6 py-10 text-center">
      <p className="font-medium">No runs reported yet</p>
      <p className="mx-auto mt-2 max-w-[56ch] text-pretty text-sm leading-relaxed text-muted-foreground">
        This fills in while a local worker is running a job. Start one with{' '}
        <code>--harness claude</code> (or codex, cline, gemini) and its phase, files, log and machine load appear here
        as it works.
      </p>
      <Link
        href="/mine"
        className="mt-4 inline-flex rounded-[var(--radius-sm)] border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider hover:bg-secondary"
      >
        Worker setup
      </Link>
    </div>
  )
}

export default function HarnessRunsPage() {
  const [items, setItems] = useState<ConsoleRun[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await getHarnessRuns()
      setItems(rows)
      setError(null)
      setSelected((prev) => (prev && rows.some((r) => r.run.taskId === prev) ? prev : (rows[0]?.run.taskId ?? null)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
    // Fast enough to feel live against a worker polling every few seconds,
    // slow enough not to be a second load on the same database the workers
    // are already hitting.
    const poll = setInterval(load, 4000)
    // Separate, faster tick for elapsed time and the staleness cutoff, which
    // are derived from the clock rather than from a fetch.
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
    }
  }, [load])

  const current = items?.find((r) => r.run.taskId === selected) ?? null

  return (
    <div className="space-y-5">
      <PageHead
        title="Harness console"
        subtitle="What your workers are doing right now — phase, files, output and machine load, reported by the worker on the poll it already makes."
        actions={
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-secondary"
          >
            <RefreshCw className="size-3" /> Refresh
          </button>
        }
      />

      {error && (
        <p className="rounded-[var(--radius-md)] border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2 text-sm text-[var(--destructive)]">
          {error}
        </p>
      )}

      {items === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <Empty />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <Panel title="Runs" bodyClassName="p-0">
            <ul className="divide-y divide-border">
              {items.map((item) => {
                const status = runStatus(item.run, now)
                const active = item.run.taskId === selected
                return (
                  <li key={item.run.taskId}>
                    <button
                      onClick={() => setSelected(item.run.taskId)}
                      className={`w-full px-3 py-2 text-left transition-colors ${active ? 'bg-secondary' : 'hover:bg-secondary/50'}`}
                    >
                      <span className="block truncate text-xs font-medium">{item.title}</span>
                      <span className="mt-1 flex items-center gap-2">
                        <StatusDot tone={STATUS_TONE[status]} label={STATUS_LABEL[status]} pulse={status === 'running'} />
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                          {elapsedLabel((item.run.finishedAt ?? now) - item.run.startedAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </Panel>

          {current ? (
            <RunDetail item={current} now={now} />
          ) : (
            <p className="text-sm text-muted-foreground">Pick a run.</p>
          )}
        </div>
      )}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Cpu className="size-3" />
        <MemoryStick className="size-3" />
        Machine load is read by the worker process on your own computer and sent with its poll. Nothing is measured
        here, so a worker that does not report leaves these blank rather than showing zero.
      </p>
    </div>
  )
}
