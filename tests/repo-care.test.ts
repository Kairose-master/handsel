/**
 * Repo Care's judgement: which issues an office picks up overnight, which
 * it leaves for a person, and what the owner reads in the morning.
 *
 * The asymmetry these tests defend: a wrong skip costs the customer an
 * issue that stays open, which they were living with. A wrong pick-up costs
 * them a night's PR they have to read and close — the exact cost the
 * product claims to remove. So every ambiguous case here must skip.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPO_CARE,
  HUMAN_ONLY_LABELS,
  MAX_PER_WAVE,
  MIN_BODY_CHARS,
  humanOnlyLabel,
  humanOnlyWord,
  isDocsIssue,
  morningReport,
  repoCareGoal,
  triageIssues,
  type RepoCareSettings,
  type RepoIssue,
} from '@/lib/repo-care'

const settings: RepoCareSettings = { ...DEFAULT_REPO_CARE, repoFullName: 'acme/api', verifyCommand: 'npm test' }
const issue = (over: Partial<RepoIssue> & { number: number }): RepoIssue => ({
  title: 'Fix the pagination cursor',
  body: 'The cursor repeats the last row when the page size divides the total exactly. Reproduced on main.',
  labels: [],
  ...over,
})

describe('what it picks up', () => {
  it('takes an ordinary bug with a real description, as a coding task with the verify command', () => {
    const { taken, skipped } = triageIssues([issue({ number: 12 })], settings)
    expect(skipped).toEqual([])
    expect(taken).toHaveLength(1)
    const t = taken[0].task
    expect(t.id).toBe('issue-12')
    expect(t.title).toBe('#12 Fix the pagination cursor')
    expect(t.kind).toBe('coding')
    expect(t.riskTier).toBe('E2')
    expect(t.settlement).toBe('internal')
    expect(t.bountyUsd).toBe(0)
    expect(t.verify).toEqual({ command: 'npm test', independentReview: true })
    expect(t.deliverPr).toEqual({ repoFullName: 'acme/api', baseBranch: null })
    // the issue's own words travel verbatim; the brief builder fences them
    expect(t.brief).toContain('The cursor repeats the last row')
    expect(t.brief).toContain('stop and say so in your report instead')
    expect(t.acceptanceCriteria).toContain('`npm test` passes.')
    expect(t.acceptanceCriteria).toContain('nothing else')
  })

  it('a docs issue is lower risk and needs no shell', () => {
    const { taken } = triageIssues([issue({ number: 3, title: 'Fix typo in README', labels: ['documentation'] })], settings)
    expect(taken[0].task.riskTier).toBe('E1')
    expect(taken[0].task.verify?.command).toBeNull()
    expect(isDocsIssue(issue({ number: 1, title: 'Update the CHANGELOG' }))).toBe(true)
    expect(isDocsIssue(issue({ number: 1, title: 'Fix the parser' }))).toBe(false)
  })

  it('openPrs off leaves the change in the workspace', () => {
    const { taken } = triageIssues([issue({ number: 5 })], { ...settings, openPrs: false })
    expect(taken[0]?.task.deliverPr).toBeUndefined()
  })
})

describe('what it refuses to touch', () => {
  const reasons = (issues: RepoIssue[], s = settings) => triageIssues(issues, s).skipped.map((x) => [x.reason, x.detail] as const)

  it('a human-only label, whatever else the issue says', () => {
    for (const label of HUMAN_ONLY_LABELS) {
      const { taken, skipped } = triageIssues([issue({ number: 1, labels: [label] })], settings)
      expect(taken, label).toEqual([])
      expect(skipped[0].reason, label).toBe('label')
    }
    // matched as a whole label, so a label that merely contains the word is fine
    expect(humanOnlyLabel(['securely-store-tokens'])).toBeNull()
    expect(humanOnlyLabel(['Security'])).toBe('Security')
    expect(humanOnlyLabel(['needs human'])).toBe('needs human')
  })

  it('a title that names production, a secret or money', () => {
    expect(reasons([issue({ number: 1, title: 'Rotate the API key in prod' })])[0][0]).toBe('title')
    expect(reasons([issue({ number: 2, title: 'Fix refund rounding' })])[0][0]).toBe('title')
    expect(reasons([issue({ number: 3, title: 'Run the database migration' })])[0][0]).toBe('title')
    // whole words only: `product` is not `prod`, and a body mentioning production is not a production change
    expect(humanOnlyWord('Improve the product page')).toBeNull()
    expect(triageIssues([issue({ number: 4, title: 'Improve the product page', body: 'The layout breaks at 320px on the production site, see the screenshot.' })], settings).taken).toHaveLength(1)
  })

  it('an issue with nothing to work from', () => {
    const [reason, detail] = reasons([issue({ number: 9, body: 'broken pls fix' })])[0]
    expect(reason).toBe('too_vague')
    expect(detail).toContain(String(MIN_BODY_CHARS))
  })

  it('a pull request, and anything outside the label filter', () => {
    expect(reasons([issue({ number: 1, isPullRequest: true })])[0][0]).toBe('pull_request')
    expect(reasons([issue({ number: 2, labels: ['enhancement'] })], { ...settings, labels: ['good first issue'] })[0][0]).toBe('label_filter')
    expect(triageIssues([issue({ number: 3, labels: ['Good First Issue'] })], { ...settings, labels: ['good first issue'] }).taken).toHaveLength(1)
  })

  it("everything past tonight's cap, and the cap itself is bounded", () => {
    const many = Array.from({ length: 6 }, (_, i) => issue({ number: i + 1 }))
    const { taken, skipped } = triageIssues(many, { ...settings, maxPerWave: 2 })
    expect(taken).toHaveLength(2)
    expect(skipped.map((s) => s.reason)).toEqual(['over_cap', 'over_cap', 'over_cap', 'over_cap'])
    expect(triageIssues(many, { ...settings, maxPerWave: 999 }).taken).toHaveLength(6)
    expect(triageIssues(Array.from({ length: 20 }, (_, i) => issue({ number: i + 1 })), { ...settings, maxPerWave: 999 }).taken).toHaveLength(MAX_PER_WAVE)
    expect(triageIssues(many, { ...settings, maxPerWave: 0 }).taken).toHaveLength(1)
  })

  it("order is the caller's, so tonight is predictable before it runs", () => {
    const { taken } = triageIssues([issue({ number: 7 }), issue({ number: 2 }), issue({ number: 5 })], { ...settings, maxPerWave: 2 })
    expect(taken.map((t) => t.issue.number)).toEqual([7, 2])
  })
})

describe('what the owner reads', () => {
  it('the goal line says the scope, the cap and the boundary', () => {
    const goal = repoCareGoal({ ...settings, labels: ['good first issue'], maxPerWave: 3 })
    expect(goal).toContain('acme/api')
    expect(goal).toContain('issues labelled good first issue')
    expect(goal).toContain('up to 3 at a time')
    expect(goal).toContain('`npm test`')
    expect(goal).toContain('waits for a person')
    expect(repoCareGoal({ ...settings, openPrs: false })).toContain('leaving each change in the working directory')
  })

  it('the report leads with what costs the owner attention, and never hides the skip list', () => {
    const report = morningReport({
      repoFullName: 'acme/api',
      lines: [
        { taskId: 'a', title: '#1 Landed thing', status: 'settled', statusReason: null, testsPassed: true, changedFiles: 2, prUrl: 'https://github.com/acme/api/pull/9', needsYou: false },
        { taskId: 'b', title: '#2 Needs a look', status: 'awaiting_approval', statusReason: 'production configuration is affected', testsPassed: true, changedFiles: 1, prUrl: null, needsYou: true },
        { taskId: 'c', title: '#3 Broke', status: 'failed', statusReason: 'tests failed on every attempt', testsPassed: false, changedFiles: 4, prUrl: null, needsYou: false },
      ],
      skipped: [{ issue: issue({ number: 4, title: 'Rotate the API key' }), reason: 'title', detail: 'the title says "api key" — a person decides this one' }],
      costUsd: 0.42,
    })
    expect(report.indexOf('Waiting for your decision')).toBeLessThan(report.indexOf('## Landed'))
    expect(report.indexOf('## Landed')).toBeLessThan(report.indexOf('## Failed'))
    expect(report).toContain('1 landed · 1 need you · 1 failed · 1 left for a person · $0.42 of model time')
    expect(report).toContain('https://github.com/acme/api/pull/9')
    expect(report).toContain('TESTS FAILED')
    expect(report).toContain('#4 Rotate the API key — the title says "api key"')
  })

  it('an empty night is a real report, not an error', () => {
    const report = morningReport({ repoFullName: 'acme/api', lines: [], skipped: [], costUsd: null })
    expect(report).toContain('0 landed · 0 need you · 0 failed · 0 left for a person')
    expect(report).not.toContain('$')
  })
})
