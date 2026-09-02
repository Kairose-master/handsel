/**
 * Three fixed-scope GitHub jobs, priced and bounded — the first products.
 *
 * docs/go-to-market.md and the owner's 30-day plan both land on the same first
 * sale: "turn a GitHub issue into a verified PR", where the repository's own
 * CI grades and the requester's own merge releases the money. This file is the
 * menu for that: each template answers, in this order and nothing else,
 * **what you get → what it costs → when → what happens if it fails.**
 *
 * They are templates over `post_repo_job` (lib/mcp/handlers/repo.ts), not a
 * parallel system: `toRepoJobArgs` produces the exact argument object that
 * tool accepts, so a template is one call away from an escrowed job and can
 * never drift from what the market actually posts.
 *
 * Scope is deliberately narrow. A template that admits "refactor the auth
 * layer" is not a product, it is a negotiation; these admit one bug, one test
 * file, one document, and refuse to describe anything larger.
 *
 * Pure.
 */

export type RepoJobTemplateId = 'bug-fix' | 'test-writing' | 'docs-update'

export type RepoJobTemplate = {
  id: RepoJobTemplateId
  label: string
  /** One sentence, in the buyer's terms. */
  youGet: string
  /** Suggested bounty, USD. A starting point the buyer can move. */
  bountyUsd: number
  /** Delivery window the job is posted with, in hours. */
  deliveryHours: number
  /** What the worker is briefed to do — becomes the job description. */
  brief: (input: TemplateInput) => string
  /** What "done" means, beyond "the diff applies and CI passes", which
   *  repoJobAcceptanceCriteria already adds. */
  criteria: (input: TemplateInput) => string
  /** What happens if it fails — the sentence a buyer reads before paying. */
  ifItFails: string
  /** Things this template will NOT do. Refusing scope is part of the price. */
  outOfScope: string[]
}

export type TemplateInput = {
  repo: string
  /** The issue this job answers. Optional for docs jobs; required for the
   *  other two, because "fix a bug" with no issue is not a fixed scope. */
  issueUrl?: string
  /** Buyer's own one-paragraph description of the problem. */
  summary: string
  baseBranch?: string
}

/**
 * Mainnet fee and forfeit, as deployed. These are contract immutables, not
 * settings — `/participation` states them and the contract is the authority.
 * Kept here so the menu can print what a buyer is actually charged, and so a
 * test can refuse a sentence that says "you pay nothing" when that is not so.
 */
export const POSTING_FEE_BPS = 500
export const POSTING_FEE_FLAT_USD = 0.03
export const SILENCE_FORFEIT_BPS = 1000

/** What a buyer is charged at post time: bounty plus the non-refundable fee. */
export function postCostUsd(bountyUsd: number): number {
  return Math.round((bountyUsd + (bountyUsd * POSTING_FEE_BPS) / 10_000 + POSTING_FEE_FLAT_USD) * 100) / 100
}

/**
 * The sentence a buyer reads before paying. It has to be exactly true.
 *
 * The first draft said "you pay nothing" — the shape every coding-agent
 * competitor cannot offer, and the reason this lane exists. It was wrong in
 * two ways the contract makes precise. A PR closed unmerged does not refund
 * the escrow; on V2 the platform records the verdict and stops, and the job
 * settles at the review deadline by `expireReview`, which returns 90% and
 * pays the worker a 10% silence forfeit. Only a dispute ruled for the
 * requester returns 100%. And the posting fee is credited to the fee
 * recipient inside `postJob` — no path, including `cancelJob`, gives it back.
 */
const FAIL_SENTENCE =
  'If the PR is not merged you do not pay the bounty. Closing it unmerged — a diff that does not apply, a red CI run, or a change you decline — returns 90% of the escrow to you at the review deadline; the other 10% goes to the worker as the contract’s silence forfeit, and a dispute ruled in your favour returns 100%. The posting fee (5% of the bounty + $0.03) is charged when the job is posted and is not refunded on any path. Only a merge releases the bounty.'

export const REPO_JOB_TEMPLATES: readonly RepoJobTemplate[] = [
  {
    id: 'bug-fix',
    label: 'Bug fix',
    youGet: 'A pull request that makes one reported bug stop happening, with a regression test that fails before the fix and passes after.',
    bountyUsd: 40,
    deliveryHours: 24,
    brief: (i) =>
      [
        `Fix the bug described in the linked issue on ${i.repo}.`,
        '',
        'Requester summary:',
        i.summary.trim(),
        '',
        'Do exactly this and nothing else:',
        '1. Reproduce the bug with a test that FAILS on the current base branch.',
        '2. Make the smallest change that makes that test pass.',
        '3. Run the existing test suite; do not change or delete existing tests to make them pass.',
        '',
        'Do not refactor surrounding code, rename things, or fix unrelated issues you notice. Mention them in the PR description instead.',
      ].join('\n'),
    criteria: () =>
      'The PR adds at least one test that fails without the change and passes with it, changes only what the fix requires, and leaves every pre-existing test passing.',
    ifItFails: FAIL_SENTENCE,
    outOfScope: ['Refactors or renames', 'Fixing a second bug found along the way', 'Changes to CI configuration', 'Dependency upgrades'],
  },
  {
    id: 'test-writing',
    label: 'Test writing',
    youGet: 'A pull request adding tests for one module you name, covering its documented behaviour and its edge cases, with no change to the module itself.',
    bountyUsd: 30,
    deliveryHours: 24,
    brief: (i) =>
      [
        `Write tests for the module described below on ${i.repo}. Do not change the module.`,
        '',
        'Requester summary (which module, what it is supposed to do):',
        i.summary.trim(),
        '',
        'Do exactly this and nothing else:',
        '1. Read the module and any existing tests for it.',
        "2. Add tests in the repository's existing test framework and directory layout — do not introduce a new framework.",
        '3. Cover the documented behaviour, the boundaries (empty, zero, maximum, malformed input), and any error paths.',
        '4. Every test you add must pass on the current base branch. A test that fails is a bug report, not a deliverable — put it in the PR description.',
        '',
        'If the module cannot be tested without changing it, stop and say so in the PR description rather than changing it.',
      ].join('\n'),
    criteria: () =>
      'The PR touches only test files and test fixtures, uses the repository’s existing test framework, and every added test passes on the base branch.',
    ifItFails: FAIL_SENTENCE,
    outOfScope: ['Changing the code under test', 'Adding a test framework or runner', 'Snapshot tests of large outputs', 'Tests that need network access or secrets'],
  },
  {
    id: 'docs-update',
    label: 'Documentation update',
    youGet: 'A pull request bringing one document into line with what the code actually does today — README, setup guide, or API reference — with every claim checked against the source.',
    bountyUsd: 25,
    deliveryHours: 24,
    brief: (i) =>
      [
        `Update the documentation described below on ${i.repo} so it matches the current code.`,
        '',
        'Requester summary (which document, what is stale or missing):',
        i.summary.trim(),
        '',
        'Do exactly this and nothing else:',
        '1. Read the code the document describes. Every command, flag, path, and default you write must exist in the source at the base branch.',
        '2. Fix what is wrong, add what is missing, remove what no longer exists.',
        '3. Keep the document’s existing structure and voice. Do not rewrite sections that are already correct.',
        '',
        'Do not change code, comments in code, or any file that is not documentation.',
      ].join('\n'),
    criteria: () =>
      'The PR touches only documentation files, every command and option it names exists in the source at the base branch, and it preserves the document’s existing structure.',
    ifItFails: FAIL_SENTENCE,
    outOfScope: ['Code changes of any kind', 'New documents from scratch', 'Translation', 'Marketing copy'],
  },
]

export function repoJobTemplate(id: string): RepoJobTemplate | null {
  return REPO_JOB_TEMPLATES.find((t) => t.id === id) ?? null
}

/** The exact `post_repo_job` argument object. A template is one call from an
 *  escrowed job, and can never describe something the market does not post. */
export function toRepoJobArgs(template: RepoJobTemplate, input: TemplateInput): {
  repo: string
  title: string
  brief: string
  criteria: string
  bounty_usd: number
  issue_url?: string
  base_branch?: string
} {
  if (!input.summary || input.summary.trim().length < 20) {
    throw new Error('summary must describe the problem in at least 20 characters — a template is a scope, not a brief')
  }
  if (template.id !== 'docs-update' && !input.issueUrl) {
    throw new Error(`${template.label} needs an issue URL — a fix with no issue is not a fixed scope`)
  }
  const firstLine = input.summary.trim().split('\n')[0].slice(0, 80)
  return {
    repo: input.repo,
    title: `${template.label}: ${firstLine}`,
    brief: template.brief(input),
    criteria: template.criteria(input),
    bounty_usd: template.bountyUsd,
    ...(input.issueUrl ? { issue_url: input.issueUrl } : {}),
    ...(input.baseBranch ? { base_branch: input.baseBranch } : {}),
  }
}

/** The menu, as a buyer reads it. */
export function renderMenu(): string {
  return REPO_JOB_TEMPLATES.map((t) =>
    [
      `## ${t.label} — $${t.bountyUsd} bounty, ${t.deliveryHours}h`,
      '',
      `**Charged up front:** $${postCostUsd(t.bountyUsd).toFixed(2)} (bounty + 5% + $0.03 posting fee). Base mainnet USDC.`,
      '',
      `**You get:** ${t.youGet}`,
      '',
      `**If it fails:** ${t.ifItFails}`,
      '',
      `**Not included:** ${t.outOfScope.join('; ')}.`,
    ].join('\n'),
  ).join('\n\n')
}
