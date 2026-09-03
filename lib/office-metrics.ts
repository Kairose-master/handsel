/**
 * What an office actually saved its owner — pure, from the session log.
 *
 * Every other counter in this repo answers "how much work happened".
 * That is the wrong question for the person paying: they already know they
 * have work. What they are buying is **hours of their own attention back**,
 * and the only honest way to price that is to measure how often the office
 * needed them and how long it waited when it did.
 *
 * So the numbers here are, in order of what they are for:
 *
 *   1. `unattendedRate` — the share of finished sessions that finished with
 *      NO owner decision at all. This is the product working.
 *   2. `ownerDecisions` / `ownerWaitMs` — how many times a person had to
 *      decide, and the wall-clock the office spent stopped waiting for them.
 *   3. `passRate` / `retriesPerSettled` — whether the work is any good, and
 *      how much the office had to redo to get there.
 *   4. `harnessCostUsd` / `movedUsd` — the model bill and the money that
 *      actually left, kept apart because they are different budgets with
 *      different owners.
 *
 * **What this cannot measure, and does not claim to.** `ownerWaitMs` is the
 * time the SESSION was blocked, not minutes of human attention — nobody here
 * is watching the owner's clock, and a decision made in ten seconds after an
 * eight-hour sleep is eight hours of waiting and ten seconds of work. The
 * field names say `wait`, never `saved`, for that reason. `medianDecisionMs`
 * is the closest honest proxy for responsiveness, and it is the owner's, not
 * ours.
 *
 * Pure: takes session states, returns numbers. No queries, no clock — `now`
 * is passed in so a window is reproducible.
 */
import { STATUS_META, type SessionState } from '@/lib/office-session'

export type OfficeMetrics = {
  /** Sessions that reached a terminal status inside the window. */
  finished: number
  /** …of which completed (as opposed to failed, cancelled, expired). */
  completed: number
  /** Finished sessions that needed no owner decision, over all finished. Null with none finished. */
  unattendedRate: number | null
  ownerDecisions: number
  policyDecisions: number
  /** Total wall-clock sessions spent stopped, waiting for a person. */
  ownerWaitMs: number
  /** Median time from "we asked" to "they answered", over answered asks. Null with none. */
  medianDecisionMs: number | null
  /** Asks still open right now. */
  openAsks: number
  tasksSettled: number
  tasksFailed: number
  /** settled / (settled + failed). Null with neither. */
  passRate: number | null
  retries: number
  /** Retries per settled task — how much rework a delivered task cost. Null with none settled. */
  retriesPerSettled: number | null
  /** What the harnesses reported spending (the model bill). */
  harnessCostUsd: number
  /** What actually left an escrow, on-chain. */
  movedUsd: number
  /** Median time from first dispatch to terminal, over finished sessions. Null with none. */
  medianSessionMs: number | null
  /** Live sessions right now, and how many of those are blocked on a person. */
  live: number
  liveWaitingOnOwner: number
}

export const EMPTY_METRICS: OfficeMetrics = {
  finished: 0,
  completed: 0,
  unattendedRate: null,
  ownerDecisions: 0,
  policyDecisions: 0,
  ownerWaitMs: 0,
  medianDecisionMs: null,
  openAsks: 0,
  tasksSettled: 0,
  tasksFailed: 0,
  passRate: null,
  retries: 0,
  retriesPerSettled: null,
  harnessCostUsd: 0,
  movedUsd: 0,
  medianSessionMs: null,
  live: 0,
  liveWaitingOnOwner: 0,
}

export type MetricsWindow = {
  /** Only sessions created at or after this. Omit for everything given. */
  since?: number
}

export function officeMetrics(states: readonly SessionState[], window: MetricsWindow = {}): OfficeMetrics {
  const since = window.since ?? 0
  const decisionDurations: number[] = []
  const sessionDurations: number[] = []
  const m: OfficeMetrics = { ...EMPTY_METRICS }

  for (const st of states) {
    const s = st.session
    if (s.createdAt < since) continue
    const terminal = STATUS_META[s.status].terminal
    let ownerDecisionsHere = 0

    for (const a of Object.values(st.approvals ?? {})) {
      if (a.decidedAt === null) {
        m.openAsks += 1
        continue
      }
      if (a.decidedBy === 'owner') {
        m.ownerDecisions += 1
        ownerDecisionsHere += 1
        const waited = a.decidedAt - a.requestedAt
        if (waited > 0) {
          m.ownerWaitMs += waited
          decisionDurations.push(waited)
        }
      } else {
        m.policyDecisions += 1
      }
      if (a.moved) m.movedUsd += a.moved.amountUsd
    }

    for (const t of Object.values(st.tasks ?? {})) {
      if (t.status === 'settled') m.tasksSettled += 1
      else if (t.status === 'failed') m.tasksFailed += 1
      // The first attempt is the work; every one after it is rework.
      if (t.attempts > 1) m.retries += t.attempts - 1
    }

    for (const r of Object.values(st.runs ?? {})) {
      if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) m.harnessCostUsd += r.costUsd
    }

    if (terminal) {
      m.finished += 1
      if (s.status === 'completed') m.completed += 1
      if (ownerDecisionsHere === 0) m.unattendedRate = (m.unattendedRate ?? 0) + 1
      // Start to end, and `completedAt` is only set on the happy path — a
      // failed or cancelled session's last heartbeat is the closest honest
      // end, and a session with neither contributes nothing rather than a
      // made-up duration.
      const from = s.startedAt ?? s.createdAt
      const to = s.completedAt ?? s.lastHeartbeatAt
      if (to !== null && to > from) sessionDurations.push(to - from)
    } else {
      m.live += 1
      if (s.status === 'waiting_on_approval') m.liveWaitingOnOwner += 1
    }
  }

  m.unattendedRate = m.finished > 0 ? round((m.unattendedRate ?? 0) / m.finished) : null
  const decided = m.tasksSettled + m.tasksFailed
  m.passRate = decided > 0 ? round(m.tasksSettled / decided) : null
  m.retriesPerSettled = m.tasksSettled > 0 ? round(m.retries / m.tasksSettled, 2) : null
  m.medianDecisionMs = median(decisionDurations)
  m.medianSessionMs = median(sessionDurations)
  m.harnessCostUsd = round(m.harnessCostUsd, 4)
  m.movedUsd = round(m.movedUsd, 2)
  return m
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

function round(n: number, places = 3): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/* ── Saying it in words ───────────────────────────────────────────────── */

export type MetricLine = { key: string; value: string; sub: string; tone: 'good' | 'warn' | 'bad' | 'plain' }

export const NO_DATA = '—'

export function humanMs(ms: number | null): string {
  if (ms === null) return NO_DATA
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

function pct(x: number | null): string {
  return x === null ? NO_DATA : `${Math.round(x * 100)}%`
}

/**
 * The five lines an operator should be able to read in one glance, with the
 * sub-line saying what the number IS — because "82%" beside a word is how a
 * dashboard lies. A null number renders as "—" and says why, never as 0%:
 * an office with no finished session has not achieved a 0% pass rate.
 */
export function metricLines(m: OfficeMetrics): MetricLine[] {
  return [
    {
      key: 'unattended',
      value: pct(m.unattendedRate),
      sub: m.finished === 0 ? 'no session has finished yet' : `${m.completed}/${m.finished} finished, ${m.ownerDecisions} needed you`,
      tone: m.unattendedRate === null ? 'plain' : m.unattendedRate >= 0.8 ? 'good' : m.unattendedRate >= 0.5 ? 'warn' : 'bad',
    },
    {
      key: 'yourDecisions',
      value: String(m.ownerDecisions + m.openAsks),
      sub: m.openAsks > 0 ? `${m.openAsks} open now · ${m.policyDecisions} settled by policy` : `${m.policyDecisions} settled by policy without you`,
      tone: m.openAsks > 0 ? 'warn' : 'plain',
    },
    {
      key: 'blockedWaiting',
      value: humanMs(m.ownerWaitMs === 0 ? null : m.ownerWaitMs),
      sub: m.medianDecisionMs === null ? 'time sessions spent stopped, waiting for a person' : `median ask answered in ${humanMs(m.medianDecisionMs)}`,
      tone: 'plain',
    },
    {
      key: 'passRate',
      value: pct(m.passRate),
      sub: m.passRate === null ? 'no task has been decided yet' : `${m.tasksSettled} settled · ${m.tasksFailed} failed · ${m.retriesPerSettled ?? NO_DATA} retries each`,
      tone: m.passRate === null ? 'plain' : m.passRate >= 0.9 ? 'good' : m.passRate >= 0.6 ? 'warn' : 'bad',
    },
    {
      key: 'realCost',
      value: `$${(m.harnessCostUsd + m.movedUsd).toFixed(2)}`,
      sub: `$${m.harnessCostUsd.toFixed(2)} model · $${m.movedUsd.toFixed(2)} paid out`,
      tone: 'plain',
    },
  ]
}

/**
 * One sentence for a report or an email. Deliberately refuses to claim
 * hours saved: it says what was done and how often a person was needed,
 * and lets the reader do their own arithmetic on their own rate.
 */
export function metricsSentence(m: OfficeMetrics): string {
  if (m.finished === 0 && m.live === 0) return 'This office has not run a session yet.'
  if (m.finished === 0) return `${m.live} session(s) running; nothing has finished yet${m.openAsks ? `, and ${m.openAsks} decision(s) are waiting for you` : ''}.`
  const unattended = Math.round((m.unattendedRate ?? 0) * m.finished)
  return (
    `${m.completed} of ${m.finished} finished sessions completed; ${unattended} of them without asking you anything. ` +
    `${m.tasksSettled} task(s) settled${m.tasksFailed ? `, ${m.tasksFailed} failed` : ''}` +
    `${m.retriesPerSettled !== null ? ` at ${m.retriesPerSettled} retries each` : ''}. ` +
    `You were asked ${m.ownerDecisions} time(s)${m.medianDecisionMs !== null ? ` and answered in ${humanMs(m.medianDecisionMs)} on median` : ''}. ` +
    `Cost so far: $${m.harnessCostUsd.toFixed(2)} of model time and $${m.movedUsd.toFixed(2)} paid to workers.`
  )
}
