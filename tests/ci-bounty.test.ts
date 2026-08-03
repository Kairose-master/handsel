import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ciBountyBrief,
  ciFailureSignature,
  decideAutoBounty,
  isFailingConclusion,
  validateCiBountyPolicy,
  type CiBountyPolicy,
} from '@/lib/ci-bounty'

/**
 * `decideAutoBounty` is the only thing standing between a red CI check and a
 * real USDC escrow nobody authorised. So every guard it has is a test, and the
 * default — no policy, no spend — is the first one.
 */

const policy = (over: Partial<CiBountyPolicy> = {}): CiBountyPolicy => ({
  repoFullName: 'acme/widgets',
  funderAgentId: 'agent-1',
  bountyUsd: 10,
  dailyCapUsd: 50,
  enabled: true,
  ...over,
})

const ok = {
  policy: policy(),
  conclusion: 'failure',
  isHandselJobPr: false,
  openBountyExists: false,
  spentTodayUsd: 0,
}

describe('decideAutoBounty — the money authority', () => {
  it('the happy path posts the policy amount', () => {
    expect(decideAutoBounty(ok)).toEqual({ post: true, bountyUsd: 10 })
  })

  it('no policy is the default, and the default never spends', () => {
    const d = decideAutoBounty({ ...ok, policy: null })
    expect(d.post).toBe(false)
  })

  it('a disabled policy is a reversible opt-out', () => {
    expect(decideAutoBounty({ ...ok, policy: policy({ enabled: false }) }).post).toBe(false)
  })

  it('only a real failure originates a job', () => {
    for (const c of ['success', 'cancelled', 'skipped', 'neutral', 'stale', 'action_required', null, undefined, '']) {
      expect(decideAutoBounty({ ...ok, conclusion: c as string }).post, `conclusion ${c}`).toBe(false)
    }
    for (const c of ['failure', 'timed_out']) {
      expect(decideAutoBounty({ ...ok, conclusion: c }).post, `conclusion ${c}`).toBe(true)
    }
  })

  it('a check grading a Handsel job does not spawn a second bounty', () => {
    // Otherwise a worker's failing fix-attempt would fund a bounty to fix the
    // fix — an infinite, self-funded regress.
    expect(decideAutoBounty({ ...ok, isHandselJobPr: true }).post).toBe(false)
  })

  it('one red check is one job — an existing open bounty blocks a second', () => {
    expect(decideAutoBounty({ ...ok, openBountyExists: true }).post).toBe(false)
  })

  it('the daily cap bounds the blast radius, and is checked against the NEW spend', () => {
    // $45 spent, $10 bounty, $50 cap → 55 > 50, refused. The cap is not "stop
    // once over" — it refuses the post that WOULD go over, so it never
    // overshoots by a job.
    expect(decideAutoBounty({ ...ok, spentTodayUsd: 45 }).post).toBe(false)
    // Exactly at the cap is allowed; one dollar past is not.
    expect(decideAutoBounty({ ...ok, spentTodayUsd: 40 }).post).toBe(true)
    expect(decideAutoBounty({ ...ok, spentTodayUsd: 41 }).post).toBe(false)
  })

  it('a policy whose bounty exceeds its own cap can never post', () => {
    expect(decideAutoBounty({ ...ok, policy: policy({ bountyUsd: 100, dailyCapUsd: 50 }) }).post).toBe(false)
  })

  it('a non-positive bounty or cap is refused, not treated as free', () => {
    expect(decideAutoBounty({ ...ok, policy: policy({ bountyUsd: 0 }) }).post).toBe(false)
    expect(decideAutoBounty({ ...ok, policy: policy({ dailyCapUsd: 0 }) }).post).toBe(false)
    expect(decideAutoBounty({ ...ok, policy: policy({ bountyUsd: -5 }) }).post).toBe(false)
  })

  it('every refusal carries a reason a log can print', () => {
    const d = decideAutoBounty({ ...ok, policy: null })
    expect(d.post).toBe(false)
    if (!d.post) expect(d.reason.length).toBeGreaterThan(0)
  })
})

describe('the dedup signature', () => {
  it('is stable across case and whitespace in the check name', () => {
    expect(ciFailureSignature('Acme/Widgets', 'CI / test (18.x)')).toBe(
      ciFailureSignature('acme/widgets', 'ci /  test (18.x)'),
    )
  })

  it('is different per check, so two broken checks are two jobs', () => {
    expect(ciFailureSignature('acme/widgets', 'lint')).not.toBe(ciFailureSignature('acme/widgets', 'typecheck'))
  })

  it('does not collide across repos', () => {
    expect(ciFailureSignature('a/x', 'ci')).not.toBe(ciFailureSignature('b/x', 'ci'))
  })
})

describe('the brief closes the grader loophole', () => {
  it('tells the worker not to game the check it will be graded by', () => {
    const brief = ciBountyBrief({ repoFullName: 'acme/widgets', checkName: 'unit tests' })
    expect(brief).toMatch(/unit tests/)
    expect(brief).toMatch(/acme\/widgets/)
    // The failing test IS the grader, so "delete the test" also turns it green.
    // The brief has to forbid what the grader cannot see.
    expect(brief).toMatch(/deleting or weakening|skipping/i)
  })

  it('includes the run link and short sha when given', () => {
    const brief = ciBountyBrief({
      repoFullName: 'a/b',
      checkName: 'ci',
      runUrl: 'https://github.com/a/b/runs/9',
      headSha: 'deadbeefcafe',
    })
    expect(brief).toContain('https://github.com/a/b/runs/9')
    expect(brief).toContain('deadbeef')
  })
})

describe('policy validation', () => {
  it('accepts a sane policy', () => {
    expect(validateCiBountyPolicy({ bountyUsd: 10, dailyCapUsd: 50 })).toEqual({ ok: true })
  })

  it('rejects a bounty larger than the cap — it would allow zero jobs', () => {
    const r = validateCiBountyPolicy({ bountyUsd: 60, dailyCapUsd: 50 })
    expect(r.ok).toBe(false)
  })

  it('rejects non-positive amounts', () => {
    expect(validateCiBountyPolicy({ bountyUsd: 0, dailyCapUsd: 50 }).ok).toBe(false)
    expect(validateCiBountyPolicy({ bountyUsd: 10, dailyCapUsd: 0 }).ok).toBe(false)
  })
})

describe('isFailingConclusion', () => {
  it('is failure and timed_out, nothing else', () => {
    expect(isFailingConclusion('failure')).toBe(true)
    expect(isFailingConclusion('timed_out')).toBe(true)
    expect(isFailingConclusion('success')).toBe(false)
    expect(isFailingConclusion('cancelled')).toBe(false)
    expect(isFailingConclusion(null)).toBe(false)
  })
})

/**
 * Static guards on the wiring. The pure core is only a safety mechanism if the
 * webhook actually routes through it, and the column is only safe if it
 * self-migrates — both have gone wrong in this repo before, so both are pinned.
 */
describe('the webhook routes real spend through the authority', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/github/webhook/route.ts'), 'utf8')

  it('calls decideAutoBounty before any origination post', () => {
    const decideAt = route.indexOf('decideAutoBounty({')
    const postAt = route.indexOf('postRepoJob({', route.indexOf('maybeOriginateCiBounty'))
    expect(decideAt).toBeGreaterThan(-1)
    expect(postAt).toBeGreaterThan(decideAt)
  })

  it('treats an unreadable chain as "do not spend", not "nothing open"', () => {
    // The label bot's own lesson: unknown chain state is not permission to
    // escrow. The default for openBountyExists must be true.
    expect(route).toMatch(/let openBountyExists = true/)
    expect(route).toMatch(/chain state unknown — no bounty originated/)
  })

  it('holds a lease across the post, and a pending post keeps it', () => {
    expect(route).toContain('ci-bounty:${signature}')
    expect(route).toMatch(/isUserOpPending[\s\S]{0,200}holding the lock/)
  })
})

describe('the policy column and table self-migrate', () => {
  const ensure = readFileSync(join(process.cwd(), 'lib/db/ensure-columns.ts'), 'utf8')
  it('adds the job_specs marker and creates the policy table', () => {
    expect(ensure).toContain('ADD COLUMN IF NOT EXISTS ci_check_signature text')
    expect(ensure).toContain('CREATE TABLE IF NOT EXISTS ci_bounty_policies')
  })
})
