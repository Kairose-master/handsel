/**
 * What a coding harness is actually doing, while it does it.
 *
 * Today a local worker is a black box with one bit of output. It spawns
 * Claude Code (or Codex, or Cline), watches it write files for four minutes,
 * throws away everything it saw, and POSTs a finished blob to
 * `/api/runtime/callback`. The owner watching from the dashboard gets
 * "running" and then "done". Every interesting thing — which phase it is in,
 * which files it touched, what the harness printed, how hard the machine is
 * working — exists on the worker's stdout for the length of the run and is
 * then gone.
 *
 * There was never a missing channel. `public/handsel-worker.mjs` already
 * POSTs to `/api/worker/poll` every few seconds with an authenticated
 * per-agent secret; the worker simply had nothing to say. This module is the
 * vocabulary for saying it, and it is pure so the parsing and the arithmetic
 * are under test rather than under a screenshot.
 *
 * **Everything here treats worker input as hostile.** A worker is a program
 * on somebody else's machine sending whatever it likes — the same posture
 * `lib/agent-harness-server.ts` takes with the harness id, and for the same
 * reason: these values reach a page. Unknown phases are dropped, text is
 * clamped, counts are bounded.
 *
 * **And a missing reading is null, never zero.** This is the "no fabricated
 * numbers" rule applied to telemetry, and it is the easiest one to get wrong
 * here: `Number(undefined) || 0` renders as "0% CPU", which is not "we don't
 * know", it is a measurement that never happened. Every field that can be
 * absent is typed `| null`, and every caller has to decide what to show for
 * absent — which, on the console, is nothing at all.
 */

/** The five things a coding harness does, in the order it does them. */
export const RUN_PHASES = ['plan', 'code', 'test', 'review', 'deploy'] as const
export type RunPhase = (typeof RUN_PHASES)[number]

const PHASE_SET = new Set<string>(RUN_PHASES)

export type RunLevel = 'info' | 'good' | 'bad'

export type RunEvent = {
  /** Epoch ms, as reported by the worker's own clock. */
  at: number
  phase: RunPhase
  text: string
  /** Repository-relative path, when the event is about one file. */
  path: string | null
  level: RunLevel
}

/**
 * One reading of how hard the worker's machine is working.
 *
 * Reported by the worker process itself, which is ordinary Node on the
 * owner's own computer and has `os.cpus()`, `os.totalmem()` and
 * `process.memoryUsage()` sitting right there. Nothing about this needs an
 * agent, a sidecar or a metrics pipeline — worth writing down, because it
 * was previously called impossible here on the grounds that there was no
 * channel for it. There is one; it is the poll.
 */
export type ResourceSample = {
  /** Whole percent, 0-100, across all cores. Null when the worker did not say. */
  cpuPct: number | null
  memUsedMb: number | null
  memTotalMb: number | null
}

export const NO_SAMPLE: ResourceSample = { cpuPct: null, memUsedMb: null, memTotalMb: null }

export type HarnessRun = {
  taskId: string
  agentId: string
  /** Registry id from lib/worker-harness.ts, or null for the built-in loop. */
  harnessId: string | null
  /** The model the harness was pointed at, when the worker knows it. */
  model: string | null
  phase: RunPhase
  startedAt: number
  /** Last time the worker said anything. Staleness is derived from this, not
   *  reported — a worker that has died cannot tell you it has died. */
  updatedAt: number
  finishedAt: number | null
  ok: boolean | null
  events: RunEvent[]
  sample: ResourceSample
  /** Tokens the harness reported consuming. Null is the common case and the
   *  honest one: most harness CLIs print no usage total, and the worker's
   *  callback has been sending a hardcoded `token_cost: 0` for every run —
   *  a zero that reads as "free" when it means "not measured". */
  tokensUsed: number | null
}

/* Bounds, not preferences: this is a public endpoint fed by an untrusted
   client, and each of these is what stops one chatty worker from filling a
   table or a page. */
export const MAX_EVENTS_PER_REPORT = 40
export const MAX_EVENTS_KEPT = 300
export const MAX_TEXT = 300
export const MAX_PATH = 200

/**
 * Colour codes first, then bare control characters.
 *
 * Order matters and the naive version gets it wrong: strip the ESC byte as a
 * control character and the rest of the sequence survives as literal
 * `[31m` text. Every harness CLI in the registry colours its output, so the
 * terminal panel would fill with that residue on the first real run. The
 * sequence has to go as a unit, before anything eats its introducer.
 */
/* eslint-disable no-control-regex -- matching control characters IS the job
   here; the rule exists to catch ones typed in by accident. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const CONTROL = /[\u0000-\u001f\u007f]/g
/* eslint-enable no-control-regex */

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const clean = v.replace(ANSI, '').replace(CONTROL, '').trim()
  return clean ? clean.slice(0, max) : null
}

function finiteOr(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/** Coerce whatever the worker sent into events we are willing to store. */
export function sanitizeEvents(raw: unknown, now: number): RunEvent[] {
  if (!Array.isArray(raw)) return []
  const out: RunEvent[] = []
  for (const item of raw.slice(0, MAX_EVENTS_PER_REPORT)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const text = clampText(r.text, MAX_TEXT)
    if (!text) continue
    const phase = typeof r.phase === 'string' && PHASE_SET.has(r.phase) ? (r.phase as RunPhase) : 'code'
    const level: RunLevel = r.level === 'good' || r.level === 'bad' ? r.level : 'info'
    // A worker clock can be wrong, and a timestamp years in the future sorts
    // every real event off the end of the list. Anything more than a day
    // either side of now is replaced with the moment we received it.
    const reported = finiteOr(r.at, 0, Number.MAX_SAFE_INTEGER)
    const at = reported !== null && Math.abs(reported - now) < 86_400_000 ? reported : now
    out.push({ at, phase, text, path: clampText(r.path, MAX_PATH), level })
  }
  return out
}

export function sanitizeSample(raw: unknown): ResourceSample {
  if (!raw || typeof raw !== 'object') return NO_SAMPLE
  const r = raw as Record<string, unknown>
  return {
    cpuPct: finiteOr(r.cpuPct, 0, 100),
    memUsedMb: finiteOr(r.memUsedMb, 0, 1_048_576),
    memTotalMb: finiteOr(r.memTotalMb, 0, 1_048_576),
  }
}

export function sanitizePhase(raw: unknown): RunPhase | null {
  return typeof raw === 'string' && PHASE_SET.has(raw) ? (raw as RunPhase) : null
}

/**
 * How far along the run is.
 *
 * Derived from the furthest phase any event reached rather than from the
 * last one reported, because harnesses go backwards: a failing test sends
 * the model back to writing code, and a stepper that walks back to step 2
 * reads as the run having lost progress it did not lose.
 */
export function furthestPhase(events: readonly RunEvent[], reported: RunPhase | null = null): RunPhase {
  let best = reported ? RUN_PHASES.indexOf(reported) : 0
  for (const e of events) best = Math.max(best, RUN_PHASES.indexOf(e.phase))
  return RUN_PHASES[Math.max(0, best)]
}

export function phaseIndex(phase: RunPhase): number {
  return RUN_PHASES.indexOf(phase)
}

/** Files the run touched, most recently written first, one entry per path. */
export function touchedFiles(events: readonly RunEvent[]): { path: string; at: number }[] {
  const seen = new Map<string, number>()
  for (const e of events) {
    if (!e.path) continue
    const prev = seen.get(e.path)
    if (prev === undefined || e.at > prev) seen.set(e.path, e.at)
  }
  return [...seen.entries()].map(([path, at]) => ({ path, at })).sort((a, b) => b.at - a.at)
}

export type DiffStat = { files: number; additions: number; deletions: number }

/**
 * Lines added and removed, straight off the unified diff the worker already
 * submits. No new reporting needed for this one — a repo job's deliverable
 * IS the diff, so "12 files, +240 -18" has been derivable since repo jobs
 * shipped and simply was never derived.
 */
export function diffStat(diff: string): DiffStat {
  const files = new Set<string>()
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const p = line.slice(4).trim().split('\t')[0]
      if (p && p !== '/dev/null') files.add(p.replace(/^[ab]\//, ''))
      continue
    }
    if (line.startsWith('@@') || line.startsWith('diff --git ')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { files: files.size, additions, deletions }
}

/**
 * Whether a run that has not finished is still alive.
 *
 * A worker that is killed, loses its network or hangs never sends a
 * "failed" — it just stops talking. Without this, every abandoned run sits
 * on the console as "Running" forever, which is the most misleading state a
 * job list can be in: it is the one that makes someone wait.
 */
export const STALE_AFTER_MS = 150_000

export type RunStatus = 'running' | 'stalled' | 'passed' | 'failed'

export function runStatus(run: Pick<HarnessRun, 'finishedAt' | 'ok' | 'updatedAt'>, now: number): RunStatus {
  if (run.finishedAt !== null) return run.ok ? 'passed' : 'failed'
  return now - run.updatedAt > STALE_AFTER_MS ? 'stalled' : 'running'
}

/** `2m 42s`, matching how long a person waits rather than how a clock works. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** `18.4k`. Null in, null out — there is no zero-token run to report. */
export function tokenLabel(tokens: number | null): string | null {
  if (tokens === null || !Number.isFinite(tokens)) return null
  if (tokens < 1000) return String(Math.round(tokens))
  return `${(tokens / 1000).toFixed(1)}k`
}

/** Merge a report into a run, oldest event first and the history bounded. */
export function appendEvents(existing: readonly RunEvent[], incoming: readonly RunEvent[]): RunEvent[] {
  const merged = [...existing, ...incoming].sort((a, b) => a.at - b.at)
  return merged.length > MAX_EVENTS_KEPT ? merged.slice(merged.length - MAX_EVENTS_KEPT) : merged
}

/** One node of the workspace tree the console draws — a directory (with
 *  children) or a file (with the event timestamp that put it there). */
export type FileTreeNode = {
  name: string
  /** Full repo-relative path — the stable key, and the hover title. */
  path: string
  /** Present on directories only. */
  children?: FileTreeNode[]
  /** Present on files only: when the worker last reported touching it. */
  at?: number
}

/**
 * The touched-file list as a tree, the way an editor's explorer draws it.
 *
 * Built from the same `touchedFiles` events — nothing here is a directory
 * listing of anyone's machine. The platform only ever knows the paths the
 * worker chose to report; a directory node exists because a reported path
 * runs through it, never because it was scanned.
 *
 * Directories sort before files, then alphabetical — editor convention,
 * pinned by test so the console cannot quietly reshuffle mid-run.
 */
export function buildFileTree(files: readonly { path: string; at: number }[]): FileTreeNode[] {
  type Dir = { node: FileTreeNode; dirs: Map<string, Dir> }
  const root: Dir = { node: { name: '', path: '', children: [] }, dirs: new Map() }

  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      let next = cur.dirs.get(name)
      if (!next) {
        const node: FileTreeNode = { name, path: parts.slice(0, i + 1).join('/'), children: [] }
        cur.node.children!.push(node)
        next = { node, dirs: new Map() }
        cur.dirs.set(name, next)
      }
      cur = next
    }
    const leaf = parts[parts.length - 1]
    const existing = cur.node.children!.find((c) => !c.children && c.name === leaf)
    if (existing) existing.at = Math.max(existing.at ?? 0, f.at)
    else cur.node.children!.push({ name: leaf, path: f.path, at: f.at })
  }

  const sortRec = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((a, b) => {
      const aDir = a.children ? 0 : 1
      const bDir = b.children ? 0 : 1
      return aDir - bDir || a.name.localeCompare(b.name)
    })
    for (const n of nodes) if (n.children) sortRec(n.children)
    return nodes
  }
  return sortRec(root.node.children!)
}
