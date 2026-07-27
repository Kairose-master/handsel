/**
 * Round-trip a REAL `git diff` through the platform's patch applier.
 *
 * Every other test of the applier uses a hand-authored diff, which shares an
 * author with the parser: if my mental model of git's output is wrong in some
 * systematic way, the fixtures encode the same mistake and all of them pass
 * while the first real submission fails at PR-open time. This test removes
 * that shared assumption by having git itself produce the diff.
 *
 * The check is exact: apply the diff to the ORIGINAL contents and the result
 * must equal, byte for byte, what git actually has in the working tree. That
 * is precisely what `openPrFromDiff` does before writing blobs, so a pass here
 * means a real worker's `git diff` will produce the pull request we intend.
 *
 * Hermetic: a throwaway repo under the OS temp dir, its own git identity, no
 * network. Skipped (not failed) where git is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyUnifiedDiff, parseUnifiedDiff } from '@/lib/repo-jobs'

let repo: string

// Resolved at MODULE scope, not in beforeAll: vitest evaluates `describe.skipIf`
// when it collects the file, so a flag set later would already have been read
// as `true` and the suite would fail instead of skipping.
const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

/** Contents of the pristine commit — what the platform fetches from the base
 *  branch when it applies a worker's diff. */
const ORIGINAL: Record<string, string> = {
  'src/app.ts': ['export function greet(name: string) {', '  return `hello ${name}`', '}', ''].join('\n'),
  'src/util.ts': Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n',
  'docs/old.md': '# Old\n\nThis file gets deleted.\n',
  'docs/move-me.md': '# Moved\n\nContent survives a rename.\n',
  'no-newline.txt': 'no trailing newline', // deliberately unterminated
}

beforeAll(() => {
  if (!gitAvailable) return
  repo = mkdtempSync(join(tmpdir(), 'handsel-diff-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  for (const [path, content] of Object.entries(ORIGINAL)) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  git('add', '-A')
  git('commit', '-qm', 'base')
})

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

/** The diff a worker would submit: everything in the tree vs the base commit,
 *  produced exactly the way `foreman work` produces it. */
function workingDiff(): string {
  git('add', '-A')
  return git('diff', '--cached', '--no-color')
}

function readNow(path: string): string | null {
  const full = join(repo, path)
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}

describe.skipIf(!gitAvailable)('a real git diff applies to exactly what git produced', () => {
  it('handles modify, create, delete, rename and an unterminated file in one diff', async () => {
    // A worker's edits — one of each shape the applier claims to support.
    writeFileSync(
      join(repo, 'src/app.ts'),
      ['export function greet(name: string) {', '  // friendlier', '  return `hi ${name}!`', '}', ''].join('\n'),
    )
    // Two far-apart edits in one file => two separate hunks.
    const util = ORIGINAL['src/util.ts']!.split('\n')
    util[0] = 'export const v0 = 100'
    util[35] = 'export const v35 = 3500'
    writeFileSync(join(repo, 'src/util.ts'), util.join('\n'))

    mkdirSync(join(repo, 'src/new'), { recursive: true })
    writeFileSync(join(repo, 'src/new/added.ts'), 'export const added = true\n')
    rmSync(join(repo, 'docs/old.md'))
    git('mv', 'docs/move-me.md', 'docs/moved.md')
    writeFileSync(join(repo, 'no-newline.txt'), 'still no trailing newline')

    const diff = workingDiff()
    expect(diff).toContain('diff --git')

    // The parser must cope with whatever git emitted, unmodified.
    expect(() => parseUnifiedDiff(diff)).not.toThrow()

    // Apply against the PRISTINE contents, the way the platform does against
    // the base branch — not against the edited working tree.
    const applied = await applyUnifiedDiff(diff, async (path) => ORIGINAL[path] ?? null)
    const result = new Map(applied.map((f) => [f.path, f.content]))

    for (const path of ['src/app.ts', 'src/util.ts', 'src/new/added.ts', 'no-newline.txt', 'docs/moved.md']) {
      expect(result.get(path), `${path} must be in the applied set`).toBe(readNow(path))
    }
    // Deletions and the vacated side of a rename come back as null content.
    expect(result.get('docs/old.md')).toBeNull()
    expect(result.get('docs/move-me.md')).toBeNull()
    expect(readNow('docs/move-me.md')).toBeNull()

    // The unterminated file must stay unterminated — appending a newline here
    // would be a silent one-byte edit nobody asked for.
    expect(result.get('no-newline.txt')!.endsWith('\n')).toBe(false)
  })

  it('rejects a real diff generated against a DIFFERENT base, instead of applying it wrongly', async () => {
    const diff = workingDiff()
    // Someone else moved the base forward under the worker's feet.
    const movedOn = { ...ORIGINAL, 'src/app.ts': 'export function greet() {\n  return "unrelated rewrite"\n}\n' }
    await expect(applyUnifiedDiff(diff, async (p) => movedOn[p as keyof typeof movedOn] ?? null)).rejects.toThrow(
      /does not apply|Regenerate/i,
    )
  })

  it('parses a diff of a file git treats as having no trailing newline on BOTH sides', async () => {
    // Isolate the "\ No newline at end of file" marker on the removed line as
    // well as the added one — the shape that is easiest to get wrong.
    const diff = git('diff', '--cached', '--no-color', '--', 'no-newline.txt')
    expect(diff).toContain('\\ No newline at end of file')
    const [patch] = parseUnifiedDiff(diff)
    const applied = await applyUnifiedDiff(diff, async () => ORIGINAL['no-newline.txt']!)
    expect(patch.hunks.length).toBe(1)
    expect(applied[0].content).toBe(readNow('no-newline.txt'))
  })
})
