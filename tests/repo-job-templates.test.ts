import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { REPO_JOB_TEMPLATES, postCostUsd, renderMenu, repoJobTemplate, toRepoJobArgs } from '@/lib/repo-job-templates'

const input = { repo: 'acme/widget', issueUrl: 'https://github.com/acme/widget/issues/12', summary: 'Pagination skips the last row when the page size divides the total exactly.' }

describe('each template answers the four buyer questions, in order', () => {
  it.each(REPO_JOB_TEMPLATES.map((t) => [t.id, t] as const))('%s: what → cost → when → if it fails', (_id, t) => {
    expect(t.youGet.length).toBeGreaterThan(40)
    expect(t.bountyUsd).toBeGreaterThan(0)
    expect(t.deliveryHours).toBeGreaterThan(0)
    // The failure sentence is the one a buyer reads before paying, and it has
    // to say the thing that makes this different from every coding agent:
    // no merge, no money.
    // "You pay nothing" was the first draft and it was false twice over: an
    // unmerged PR returns 90% (10% silence forfeit to the worker) and the
    // posting fee is never refunded. The sentence has to carry both.
    expect(t.ifItFails).not.toMatch(/pay nothing/i)
    expect(t.ifItFails).toMatch(/returns 90%/)
    expect(t.ifItFails).toMatch(/10% goes to the worker/)
    expect(t.ifItFails).toMatch(/posting fee .*not refunded/i)
    expect(t.ifItFails).toMatch(/Only a merge releases/)
    expect(t.outOfScope.length).toBeGreaterThan(0)
  })
})

describe('a template is one call from an escrowed job', () => {
  it('produces the exact post_repo_job argument names', () => {
    const args = toRepoJobArgs(repoJobTemplate('bug-fix')!, input)
    expect(Object.keys(args).sort()).toEqual(['bounty_usd', 'brief', 'criteria', 'issue_url', 'repo', 'title'].sort())
    expect(args.bounty_usd).toBe(40)
    expect(args.title).toMatch(/^Bug fix: /)
  })

  it('refuses a fix with no issue — that is not a fixed scope', () => {
    expect(() => toRepoJobArgs(repoJobTemplate('bug-fix')!, { ...input, issueUrl: undefined })).toThrow(/issue URL/)
    expect(() => toRepoJobArgs(repoJobTemplate('test-writing')!, { ...input, issueUrl: undefined })).toThrow(/issue URL/)
  })

  it('lets a docs job stand without an issue', () => {
    expect(() => toRepoJobArgs(repoJobTemplate('docs-update')!, { ...input, issueUrl: undefined })).not.toThrow()
  })

  it('refuses a summary too short to be a brief', () => {
    expect(() => toRepoJobArgs(repoJobTemplate('docs-update')!, { ...input, summary: 'fix readme' })).toThrow(/20 characters/)
  })

  it('carries the buyer summary into the brief verbatim', () => {
    expect(toRepoJobArgs(repoJobTemplate('bug-fix')!, input).brief).toContain(input.summary)
  })
})

describe('scope is refused, not negotiated', () => {
  it('bug fix demands a failing-then-passing test and forbids refactors', () => {
    const t = repoJobTemplate('bug-fix')!
    expect(t.brief(input)).toMatch(/FAILS on the current base branch/)
    expect(t.brief(input)).toMatch(/Do not refactor/)
    expect(t.criteria(input)).toMatch(/fails without the change and passes with it/)
  })

  it('test writing forbids touching the module under test', () => {
    const t = repoJobTemplate('test-writing')!
    expect(t.brief(input)).toMatch(/Do not change the module/)
    expect(t.criteria(input)).toMatch(/touches only test files/)
  })

  it('docs update forbids code changes and demands claims exist in source', () => {
    const t = repoJobTemplate('docs-update')!
    expect(t.brief(input)).toMatch(/must exist in the source/)
    expect(t.criteria(input)).toMatch(/touches only documentation files/)
  })
})

describe('the menu', () => {
  it('lists bounty, delivery, and the real up-front charge on every entry', () => {
    const menu = renderMenu()
    for (const t of REPO_JOB_TEMPLATES) {
      expect(menu).toContain(`## ${t.label} — $${t.bountyUsd} bounty, ${t.deliveryHours}h`)
      expect(menu).toContain(`**Charged up front:** $${postCostUsd(t.bountyUsd).toFixed(2)}`)
    }
    expect(menu).toContain('**If it fails:**')
  })

  it('computes the post cost the way the contract does — 5% plus a flat $0.03', () => {
    expect(postCostUsd(40)).toBe(42.03)
    expect(postCostUsd(25)).toBe(26.28)
    expect(postCostUsd(0)).toBe(0.03)
  })
})

describe('the published menu is the generated menu', () => {
  it('docs/verified-work-menu.md carries renderMenu() verbatim', () => {
    // The doc says it is generated and must not be hand-edited. This is what
    // makes that sentence true: a price changed in one place and not the
    // other fails here, before a buyer reads the stale one.
    const doc = readFileSync('docs/verified-work-menu.md', 'utf8')
    expect(doc).toContain(renderMenu())
  })
})
