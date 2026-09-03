/**
 * Triggers for event-driven office sessions — pure.
 *
 * An event-driven session (lib/office-session.ts, kind `event_driven`) lists
 * the trigger names it wakes on. This module is the vocabulary: what a
 * GitHub delivery, a CI result or an HTTP call becomes as trigger names, and
 * how a session's list is matched against what fired.
 *
 * Names are `source:qualifier…:event`, lower-case, e.g.
 *   github:issues.opened                 any repo the App sees
 *   github:acme/api:issues.opened        one repo
 *   github:acme/api:issues.labeled:bug   one label on one repo
 *   github:acme/api:ci.failed            a check suite concluded failure
 *   http:nightly-report                  POST /api/office/sessions/trigger
 *
 * A session may end a trigger with `*` to take every event under that prefix
 * (`github:acme/api:*`). Matching is exact otherwise — a session that asked
 * for `issues.opened` is not woken by `issues.closed`.
 *
 * The GitHub side never names a user: the webhook fires whatever sessions
 * subscribed to that repo's events, whoever owns them. A session naming a
 * repo it has no business with just wakes on public activity the App was
 * installed to see — the App's installation scope is the boundary, and a
 * wake only ever starts the session's own next wave from its own budget.
 */

export const TRIGGER_MAX_LEN = 120
const TRIGGER_RE = /^[a-z0-9][a-z0-9._\-/:$#@]*(\*)?$/

/** Lower-cased, trimmed, bounded; null when it is not a trigger name at all. */
export function normalizeTrigger(raw: string): string | null {
  const t = raw.trim().toLowerCase()
  if (t === '*') return t
  if (t.length === 0 || t.length > TRIGGER_MAX_LEN) return null
  if (!TRIGGER_RE.test(t)) return null
  if (t.includes('*') && !t.endsWith(':*') && t !== '*') return null
  return t
}

/** Parse an owner-typed list ("a, b\nc") into normalized, de-duplicated names. */
export function parseTriggerList(raw: string): string[] {
  const out: string[] = []
  for (const piece of raw.split(/[\n,]/)) {
    const t = normalizeTrigger(piece)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** True when any fired name matches any of the session's triggers. */
export function triggerMatches(sessionTriggers: readonly string[], fired: readonly string[]): string[] {
  const hits: string[] = []
  for (const f of fired) {
    const name = f.toLowerCase()
    for (const t of sessionTriggers) {
      const want = t.toLowerCase()
      if (want === '*' || want === name || (want.endsWith(':*') && name.startsWith(want.slice(0, -1)))) {
        if (!hits.includes(name)) hits.push(name)
      }
    }
  }
  return hits
}

type GhPayload = {
  action?: unknown
  repository?: { full_name?: unknown }
  label?: { name?: unknown }
  pull_request?: { merged?: unknown; draft?: unknown }
  check_suite?: { conclusion?: unknown; status?: unknown }
  check_run?: { conclusion?: unknown; status?: unknown }
  workflow_run?: { conclusion?: unknown; status?: unknown }
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null)

/**
 * The trigger names one GitHub delivery fires. Empty for deliveries a session
 * cannot meaningfully wake on (pings, installation churn, an in-progress
 * check). Every name is emitted twice: unqualified and repo-qualified, so a
 * session can subscribe at either width.
 */
export function githubTriggersFor(event: string, payload: unknown): string[] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as GhPayload
  const repo = str(p.repository?.full_name)?.toLowerCase() ?? null
  const action = str(p.action)?.toLowerCase() ?? null
  const events: string[] = []
  switch (event) {
    case 'issues': {
      if (!action) break
      if (['opened', 'reopened', 'closed', 'edited', 'assigned'].includes(action)) events.push(`issues.${action}`)
      if (action === 'labeled') {
        const label = str(p.label?.name)?.toLowerCase().replace(/\s+/g, '-')
        events.push('issues.labeled')
        if (label) events.push(`issues.labeled:${label}`)
      }
      break
    }
    case 'issue_comment': {
      if (action === 'created') events.push('issue_comment.created')
      break
    }
    case 'pull_request': {
      if (!action) break
      if (action === 'closed') events.push(p.pull_request?.merged === true ? 'pull_request.merged' : 'pull_request.closed')
      else if (['opened', 'reopened', 'synchronize', 'ready_for_review', 'review_requested'].includes(action)) events.push(`pull_request.${action}`)
      break
    }
    case 'check_suite':
    case 'workflow_run': {
      const node = event === 'check_suite' ? p.check_suite : p.workflow_run
      if (action !== 'completed') break
      const conclusion = str(node?.conclusion)?.toLowerCase()
      if (conclusion === 'success') events.push('ci.passed')
      else if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled') events.push('ci.failed')
      break
    }
    case 'push':
      events.push('push')
      break
    case 'release':
      if (action === 'published') events.push('release.published')
      break
    default:
      break
  }
  const out: string[] = []
  for (const e of events) {
    out.push(`github:${e}`)
    if (repo) out.push(`github:${repo}:${e}`)
  }
  return out
}

/** The HTTP lane: a caller-chosen name, prefixed so it can never spoof a GitHub name. */
export function httpTrigger(name: string): string | null {
  const t = normalizeTrigger(name)
  if (!t || t.includes('*')) return null
  return t.startsWith('http:') ? t : `http:${t}`
}

/** What a trigger name means, for the owner's page. */
export function describeTrigger(trigger: string): string {
  const t = trigger.toLowerCase()
  if (t === '*') return 'any event'
  const [source, ...rest] = t.split(':')
  const tail = rest.join(':')
  if (source === 'github') {
    const parts = rest
    const repo = parts.length > 1 && parts[0].includes('/') ? parts[0] : null
    const ev = repo ? parts.slice(1).join(':') : tail
    const where = repo ? ` on ${repo}` : ' on any repo'
    if (ev === '*') return `any GitHub event${where}`
    return `GitHub ${ev.replace(/[._]/g, ' ')}${where}`
  }
  if (source === 'http') return `an HTTP call named "${tail}"`
  return trigger
}
