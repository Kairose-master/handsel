import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A job spec that claims a repo must carry its issue number too.
 *
 * `issue_number` is documented in schema.ts as "the idempotency and cancel
 * key", and the GitHub webhook's `specsForIssue` matches on
 * (repoFullName, issueNumber). Every repost path — grading failure, dispute
 * refund, price raise — inserts a NEW spec row copied field by field from the
 * old one, and all three carried `repoFullName` and `baseBranch` while
 * dropping `issueNumber`.
 *
 * What that cost, observed on the live deployment: bounty job #327 was a
 * repost. Its issue was closed and its label removed, the webhook asked
 * `specsForIssue` for the job to cancel, got nothing back, and returned
 * `ignored` without a comment. The escrow stayed locked with no issue left to
 * point at it. The stale-claim deadline warning reads the same field, so that
 * went quiet as well.
 *
 * The reason it survived review is legible in the diff: the repost site has a
 * comment reading "Repo identity must survive a repost", and then enumerates
 * two of that identity's three fields. Reviewing the list against the comment
 * cannot catch a field missing from both.
 *
 * So this is checked structurally rather than by example. Reading the source is
 * deliberate: these are database inserts inside on-chain settlement paths, and
 * a test that had to reach a real repost would test the mocking.
 */

const SOURCE_DIRS = ['lib', 'app']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
}

/** Every `db.insert(jobSpec).values(...)` argument list, as source text. */
function specInserts(source: string): string[] {
  const blocks: string[] = []
  const marker = 'insert(jobSpec).values('
  let from = 0
  for (;;) {
    const start = source.indexOf(marker, from)
    if (start === -1) break
    let depth = 0
    let i = start + marker.length - 1
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    blocks.push(source.slice(start, i + 1))
    from = i + 1
  }
  return blocks
}

const inserts = SOURCE_DIRS.flatMap((dir) =>
  walk(dir).flatMap((file) => specInserts(readFileSync(file, 'utf8')).map((block) => ({ file, block }))),
)

describe('every jobSpec insert is found at all', () => {
  it('parses more than one, or the scanner is broken and everything below passes vacuously', () => {
    expect(inserts.length).toBeGreaterThan(5)
  })
})

describe('repo identity travels together', () => {
  const repoInserts = inserts.filter(({ block }) => /\brepoFullName:/.test(block))

  it('finds the repo-job inserts', () => {
    expect(repoInserts.length).toBeGreaterThan(2)
  })

  it.each(repoInserts.map(({ file, block }) => [file, block] as const))(
    '%s carries issueNumber alongside repoFullName',
    (_file, block) => {
      // A spec that knows its repo but not its issue is a bounty nobody can
      // cancel: the escrow's only off-chain exit is keyed on this field.
      expect(block).toMatch(/\bissueNumber:/)
    },
  )
})
