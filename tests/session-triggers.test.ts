/**
 * Trigger names for event-driven office sessions: what a GitHub delivery
 * becomes, how an owner's list is matched, and that the HTTP lane can never
 * spell a GitHub-sourced name.
 */
import { describe, expect, it } from 'vitest'
import { describeTrigger, githubTriggersFor, httpTrigger, normalizeTrigger, parseTriggerList, triggerMatches } from '@/lib/session-triggers'

describe('githubTriggersFor', () => {
  const repo = { repository: { full_name: 'Acme/API' } }
  it('emits an unqualified and a repo-qualified name per event', () => {
    expect(githubTriggersFor('issues', { ...repo, action: 'opened' })).toEqual(['github:issues.opened', 'github:acme/api:issues.opened'])
    expect(githubTriggersFor('pull_request', { ...repo, action: 'opened' })).toEqual(['github:pull_request.opened', 'github:acme/api:pull_request.opened'])
  })
  it('a merged PR is merged, not closed; a label carries its name', () => {
    expect(githubTriggersFor('pull_request', { ...repo, action: 'closed', pull_request: { merged: true } })).toContain('github:acme/api:pull_request.merged')
    expect(githubTriggersFor('pull_request', { ...repo, action: 'closed', pull_request: { merged: false } })).toContain('github:acme/api:pull_request.closed')
    expect(githubTriggersFor('issues', { ...repo, action: 'labeled', label: { name: 'Good First Issue' } })).toEqual([
      'github:issues.labeled',
      'github:acme/api:issues.labeled',
      'github:issues.labeled:good-first-issue',
      'github:acme/api:issues.labeled:good-first-issue',
    ])
  })
  it('CI: only a completed suite fires, by conclusion', () => {
    expect(githubTriggersFor('check_suite', { ...repo, action: 'requested', check_suite: { conclusion: null } })).toEqual([])
    expect(githubTriggersFor('check_suite', { ...repo, action: 'completed', check_suite: { conclusion: 'failure' } })).toEqual(['github:ci.failed', 'github:acme/api:ci.failed'])
    expect(githubTriggersFor('workflow_run', { ...repo, action: 'completed', workflow_run: { conclusion: 'success' } })).toEqual(['github:ci.passed', 'github:acme/api:ci.passed'])
    expect(githubTriggersFor('check_suite', { ...repo, action: 'completed', check_suite: { conclusion: 'neutral' } })).toEqual([])
  })
  it('deliveries a session cannot act on fire nothing; a malformed payload is not a crash', () => {
    expect(githubTriggersFor('ping', {})).toEqual([])
    expect(githubTriggersFor('installation', { action: 'created' })).toEqual([])
    expect(githubTriggersFor('issues', null)).toEqual([])
    expect(githubTriggersFor('issues', { action: 42, repository: 'nope' })).toEqual([])
    expect(githubTriggersFor('issues', { action: 'opened' })).toEqual(['github:issues.opened'])
  })
})

describe('matching', () => {
  it('exact, case-insensitive, or a prefix wildcard', () => {
    expect(triggerMatches(['github:acme/api:issues.opened'], ['github:acme/api:issues.opened', 'github:issues.opened'])).toEqual(['github:acme/api:issues.opened'])
    expect(triggerMatches(['github:acme/api:issues.opened'], ['github:acme/api:issues.closed'])).toEqual([])
    expect(triggerMatches(['github:acme/api:*'], ['github:acme/api:ci.failed', 'github:other/repo:ci.failed'])).toEqual(['github:acme/api:ci.failed'])
    expect(triggerMatches(['*'], ['http:x'])).toEqual(['http:x'])
    expect(triggerMatches(['GitHub:ACME/api:ci.failed'], ['github:acme/api:ci.failed'])).toEqual(['github:acme/api:ci.failed'])
    expect(triggerMatches([], ['github:issues.opened'])).toEqual([])
  })
})

describe('names', () => {
  it('normalizes, bounds and rejects junk', () => {
    expect(normalizeTrigger('  GitHub:Acme/API:Issues.Opened ')).toBe('github:acme/api:issues.opened')
    expect(normalizeTrigger('')).toBeNull()
    expect(normalizeTrigger('x'.repeat(200))).toBeNull()
    expect(normalizeTrigger('has space')).toBeNull()
    expect(normalizeTrigger('a*b')).toBeNull()
    expect(normalizeTrigger('github:acme/api:*')).toBe('github:acme/api:*')
    expect(normalizeTrigger('*')).toBe('*')
    expect(normalizeTrigger('<script>')).toBeNull()
  })
  it('parses an owner-typed list, dropping junk and duplicates', () => {
    expect(parseTriggerList('github:a/b:issues.opened, http:nightly\nhttp:nightly, ???, ')).toEqual(['github:a/b:issues.opened', 'http:nightly'])
  })
  it('the HTTP lane is always prefixed http: and never a wildcard', () => {
    expect(httpTrigger('nightly-report')).toBe('http:nightly-report')
    expect(httpTrigger('http:nightly')).toBe('http:nightly')
    expect(httpTrigger('github:acme/api:ci.failed')).toBe('http:github:acme/api:ci.failed')
    expect(httpTrigger('x:*')).toBeNull()
    expect(httpTrigger('')).toBeNull()
  })
  it('describes a name for the owner', () => {
    expect(describeTrigger('github:acme/api:issues.opened')).toBe('GitHub issues opened on acme/api')
    expect(describeTrigger('github:ci.failed')).toBe('GitHub ci failed on any repo')
    expect(describeTrigger('github:acme/api:*')).toBe('any GitHub event on acme/api')
    expect(describeTrigger('http:nightly')).toBe('an HTTP call named "nightly"')
    expect(describeTrigger('*')).toBe('any event')
  })
})
