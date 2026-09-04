/**
 * Repo Care — the first vertical, and the reason the office is the product.
 *
 * The pitch is one sentence: overnight the office reads a repository's
 * backlog, does the tests, docs and low-risk bugs, and by morning there are
 * pull requests with their verification beside them. Anything that touches
 * production, a secret, a dependency or money waited for a person instead.
 *
 * This module is the judgement in that sentence, and nothing else — it is
 * pure, so what Repo Care will and will not pick up is a table you can read
 * and a test can pin, rather than a prompt's mood.
 *
 * The design decision worth stating: **triage is conservative and boring on
 * purpose.** A wrong skip costs the customer one issue that stays open,
 * which they were living with anyway. A wrong pick-up spends a night
 * producing a PR that a person then has to read, judge and close — the
 * exact cost the product claims to remove. So the skip list is a fixed set
 * of labels and words, not a model's opinion, and an issue that says
 * nothing useful is skipped rather than guessed at.
 */
import type { PlannedTask, RiskTier } from '@/lib/office-session'

export type RepoIssue = {
  number: number
  title: string
  body: string
  labels: string[]
  /** Set on a pull request; Repo Care never works on one. */
  isPullRequest?: boolean
}

export type RepoCareSettings = {
  repoFullName: string
  /** Only issues carrying one of these, when set. Empty = any issue that survives triage. */
  labels: string[]
  /** How many issues one night may take. */
  maxPerWave: number
  /** The command that decides whether a change is done. */
  verifyCommand: string | null
  /** Land the diff as a pull request. Off leaves the diff in the workspace and on the timeline. */
  openPrs: boolean
  baseBranch: string | null
}

export const DEFAULT_REPO_CARE: Omit<RepoCareSettings, 'repoFullName'> = {
  labels: [],
  maxPerWave: 3,
  verifyCommand: null,
  openPrs: true,
  baseBranch: null,
}

export const MAX_PER_WAVE = 10

/**
 * Labels that mean "a person decides this one". Matched case-insensitively
 * as whole labels, so `security` skips and `securely-store-tokens` does not.
 */
export const HUMAN_ONLY_LABELS: readonly string[] = [
  'needs-human',
  'needs human',
  'security',
  'vulnerability',
  'production',
  'infra',
  'infrastructure',
  'deploy',
  'release',
  'breaking',
  'breaking-change',
  'billing',
  'payment',
  'legal',
  'design',
  'discussion',
  'question',
  'wontfix',
  'duplicate',
  'blocked',
  'on-hold',
]

/**
 * Words in the title that mean the same thing. Deliberately narrow: these
 * are matched as whole words on the TITLE only, because a body full of a
 * stack trace mentioning `production.log` is not a production change, and
 * the title is where a person states the actual ask.
 */
export const HUMAN_ONLY_WORDS: readonly string[] = [
  'production',
  'prod',
  'deploy',
  'deployment',
  'migration',
  'migrate',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'token',
  'api key',
  'password',
  'payment',
  'billing',
  'invoice',
  'refund',
  'gdpr',
  'licence',
  'license',
  'rotate',
  'revoke',
  'delete all',
  'drop table',
]

/** A title like this is a docs change: lower risk, and no shell needed to be sure. */
const DOCS_WORDS = ['readme', 'docs', 'documentation', 'typo', 'comment', 'changelog', 'spelling', 'wording']

export const MIN_BODY_CHARS = 40

export type SkipReason = 'pull_request' | 'label' | 'title' | 'too_vague' | 'label_filter' | 'over_cap'

export type Triage = {
  taken: Array<{ issue: RepoIssue; task: PlannedTask }>
  skipped: Array<{ issue: RepoIssue; reason: SkipReason; detail: string }>
}

const lower = (s: string) => s.toLowerCase()

/** Whole-word match, so `prod` does not fire on `product`. */
function hasWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)
}

export function humanOnlyLabel(labels: readonly string[]): string | null {
  for (const l of labels) {
    const norm = lower(l).trim()
    if (HUMAN_ONLY_LABELS.some((h) => h === norm || norm.replace(/[_\s]+/g, '-') === h.replace(/[_\s]+/g, '-'))) return l
  }
  return null
}

export function humanOnlyWord(title: string): string | null {
  const t = lower(title)
  for (const w of HUMAN_ONLY_WORDS) if (hasWord(t, w)) return w
  return null
}

export function isDocsIssue(issue: RepoIssue): boolean {
  const t = lower(issue.title)
  return DOCS_WORDS.some((w) => hasWord(t, w)) || issue.labels.some((l) => ['documentation', 'docs'].includes(lower(l)))
}

/**
 * The night's plan. Order is the caller's (GitHub's own — oldest updated
 * first, if they asked for that); this only decides yes or no and stops at
 * the cap, so which issues get done tonight is predictable rather than
 * whichever the model found interesting.
 */
export function triageIssues(issues: readonly RepoIssue[], settings: RepoCareSettings, wave = 1): Triage {
  const out: Triage = { taken: [], skipped: [] }
  const taken = new Set<string>()
  const cap = Math.max(1, Math.min(MAX_PER_WAVE, Math.floor(settings.maxPerWave)))
  for (const issue of issues) {
    if (issue.isPullRequest) {
      out.skipped.push({ issue, reason: 'pull_request', detail: 'it is a pull request, not an issue' })
      continue
    }
    if (settings.labels.length > 0 && !issue.labels.some((l) => settings.labels.some((want) => lower(want) === lower(l)))) {
      out.skipped.push({ issue, reason: 'label_filter', detail: `it carries none of ${settings.labels.join(', ')}` })
      continue
    }
    const badLabel = humanOnlyLabel(issue.labels)
    if (badLabel) {
      out.skipped.push({ issue, reason: 'label', detail: `labelled ${badLabel} — a person decides this one` })
      continue
    }
    const badWord = humanOnlyWord(issue.title)
    if (badWord) {
      out.skipped.push({ issue, reason: 'title', detail: `the title says "${badWord}" — a person decides this one` })
      continue
    }
    if (issue.body.trim().length < MIN_BODY_CHARS) {
      out.skipped.push({ issue, reason: 'too_vague', detail: `the description is under ${MIN_BODY_CHARS} characters — nothing to work from` })
      continue
    }
    if (out.taken.length >= cap) {
      out.skipped.push({ issue, reason: 'over_cap', detail: `tonight's cap of ${cap} is already taken` })
      continue
    }
    out.taken.push({ issue, task: taskForIssue(issue, settings, wave, taken) })
  }
  return out
}

function taskForIssue(issue: RepoIssue, settings: RepoCareSettings, wave: number, taken: Set<string>): PlannedTask {
  const docs = isDocsIssue(issue)
  const id = uniqueId(`issue-${issue.number}`, taken)
  const riskTier: RiskTier = docs ? 'E1' : 'E2'
  return {
    id,
    title: `#${issue.number} ${issue.title}`.slice(0, 120),
    // The issue's own words, verbatim. The brief builder fences this — an
    // issue is written by whoever can open one, which on a public repo is
    // anybody.
    brief:
      `Resolve issue #${issue.number} of ${settings.repoFullName} in the working directory you were given.\n\n` +
      `Title: ${issue.title}\n\n${issue.body.trim()}\n\n` +
      `Change only what this issue needs. If resolving it would touch production configuration, a secret, a dependency, ` +
      `or anything the issue did not ask for, stop and say so in your report instead — that is a correct outcome here, not a failure.`,
    acceptanceCriteria: acceptanceFor(issue, settings, docs),
    kind: 'coding',
    dependsOn: [],
    bountyUsd: 0,
    settlement: 'internal',
    riskTier,
    verify: { command: docs ? null : settings.verifyCommand, independentReview: true },
    ...(settings.openPrs ? { deliverPr: { repoFullName: settings.repoFullName, baseBranch: settings.baseBranch } } : {}),
  }
}

function acceptanceFor(issue: RepoIssue, settings: RepoCareSettings, docs: boolean): string {
  const lines = [
    `The change resolves what issue #${issue.number} ("${issue.title}") asks for, and nothing else.`,
    'No file outside the working directory is touched, and no secret, environment file or production configuration is modified.',
  ]
  if (!docs && settings.verifyCommand) lines.push(`\`${settings.verifyCommand}\` passes.`)
  if (docs) lines.push('The prose is correct and reads like the surrounding text.')
  lines.push('The report says what changed and why, and names anything the issue asked for that was deliberately left out.')
  return lines.map((l) => `- ${l}`).join('\n')
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  taken.add(id)
  return id
}

/** The goal line a Repo Care session carries, so the page reads like a sentence. */
export function repoCareGoal(settings: RepoCareSettings): string {
  const scope = settings.labels.length > 0 ? `issues labelled ${settings.labels.join(', ')}` : 'the open backlog'
  return (
    `Take care of ${settings.repoFullName}: work ${scope}, up to ${settings.maxPerWave} at a time` +
    `${settings.verifyCommand ? `, verified with \`${settings.verifyCommand}\`` : ''}` +
    `${settings.openPrs ? ', and open a pull request for each' : ', leaving each change in the working directory'}. ` +
    `Anything production-shaped, secret-shaped or dependency-shaped waits for a person.`
  )
}

/* ── The morning report ───────────────────────────────────────────────── */

export type TaskOutcomeLine = {
  taskId: string
  title: string
  status: string
  statusReason: string | null
  testsPassed: boolean | null
  changedFiles: number
  prUrl: string | null
  needsYou: boolean
}

/**
 * What the owner reads over coffee. Ordered by what it costs them: what
 * needs a decision, then what landed, then what failed, then what was
 * skipped and why — because the skip list is the product's honesty and
 * hiding it would make the office look better than it is.
 */
export function morningReport(input: { repoFullName: string; lines: readonly TaskOutcomeLine[]; skipped: readonly Triage['skipped'][number][]; costUsd: number | null }): string {
  const needs = input.lines.filter((l) => l.needsYou)
  const landed = input.lines.filter((l) => !l.needsYou && l.status === 'settled')
  const failed = input.lines.filter((l) => !l.needsYou && (l.status === 'failed' || l.status === 'skipped'))
  const out: string[] = [`# ${input.repoFullName} — overnight`, '']
  out.push(
    `${landed.length} landed · ${needs.length} need you · ${failed.length} failed · ${input.skipped.length} left for a person` +
      `${input.costUsd !== null ? ` · $${input.costUsd.toFixed(2)} of model time` : ''}`,
    '',
  )
  const block = (heading: string, lines: readonly TaskOutcomeLine[]) => {
    if (lines.length === 0) return
    out.push(`## ${heading}`, '')
    for (const l of lines) {
      const bits = [l.testsPassed === true ? 'tests passed' : l.testsPassed === false ? 'TESTS FAILED' : 'not verified', `${l.changedFiles} file(s)`]
      out.push(`- **${l.title}** — ${bits.join(' · ')}${l.prUrl ? `\n  ${l.prUrl}` : ''}${l.statusReason ? `\n  ${l.statusReason}` : ''}`)
    }
    out.push('')
  }
  block('Waiting for your decision', needs)
  block('Landed', landed)
  block('Failed', failed)
  if (input.skipped.length > 0) {
    out.push('## Left for a person', '')
    for (const s of input.skipped) out.push(`- #${s.issue.number} ${s.issue.title} — ${s.detail}`)
    out.push('')
  }
  return out.join('\n').trimEnd()
}

/* ── The free diagnostic ─────────────────────────────────────────────── */

/**
 * The three buckets the landing page shows before anyone has an account or
 * has connected anything. Built from the same `triageIssues` a real
 * session plans from — the diagnostic is not a simplified opinion, it is
 * the real rule engine run once, read-only.
 *
 * There is no fourth, unverifiable bucket like "needs your approval": that
 * depends on what a run actually changes, which does not exist yet at
 * diagnosis time. Claiming it here would be exactly the kind of promise
 * this repo's "no fake data" rule exists to catch. `review` is honestly
 * named instead — the rest of the backlog, for a person to read, not a
 * verdict on any one issue.
 */
export type DiagnosticBucket = 'workable' | 'excluded' | 'review'

export type DiagnosticIssue = {
  number: number
  title: string
  bucket: DiagnosticBucket
  /** Why it landed in `excluded` or `review`; null for `workable`. */
  reason: string | null
}

export type Diagnostic = {
  repoFullName: string
  /** Open issues read, pull requests already excluded from this count. */
  totalOpenIssues: number
  workable: number
  excluded: number
  review: number
  issues: DiagnosticIssue[]
}

/** Pure: turns a real `triageIssues` result into the three counts the
 *  landing page shows. No network in this function — `diagnoseRepo`
 *  (`lib/repo-diagnose-server.ts`) is what fetches the issues. */
export function summarizeTriage(repoFullName: string, triage: Triage): Diagnostic {
  const issues: DiagnosticIssue[] = []
  for (const t of triage.taken) issues.push({ number: t.issue.number, title: t.issue.title, bucket: 'workable', reason: null })
  let excluded = 0
  let review = 0
  for (const s of triage.skipped) {
    if (s.issue.isPullRequest) continue // not part of "open issues" at all
    const bucket: DiagnosticBucket = s.reason === 'label' || s.reason === 'title' ? 'excluded' : 'review'
    if (bucket === 'excluded') excluded += 1
    else review += 1
    issues.push({ number: s.issue.number, title: s.issue.title, bucket, reason: s.detail })
  }
  return {
    repoFullName,
    totalOpenIssues: triage.taken.length + excluded + review,
    workable: triage.taken.length,
    excluded,
    review,
    issues,
  }
}
