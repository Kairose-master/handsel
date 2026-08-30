import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  modeFor,
  validRepoName,
  validBranch,
  clonePathFor,
  cloneArgs,
  stageArgs,
  diffArgs,
  diffIsEmpty,
  wrapDiff,
  repoBrief,
} from '@/lib/worker-deliverable'
import { extractUnifiedDiff } from '@/lib/repo-jobs'

const REPO = { fullName: 'octocat/hello-world', baseBranch: 'main' }

describe('modeFor', () => {
  it('asks for a diff when the job names a repository', () => {
    expect(modeFor({ taskId: 't', repo: REPO })).toBe('diff')
  })

  it('keeps the file handoff for everything else', () => {
    expect(modeFor({ taskId: 't' })).toBe('file')
    expect(modeFor({ taskId: 't', repo: null })).toBe('file')
  })

  it('does not take the diff path on a repo name it would refuse to clone', () => {
    // Otherwise the worker commits to producing a diff and then has nothing
    // to produce it from.
    expect(modeFor({ taskId: 't', repo: { fullName: '--upload-pack=x/y', baseBranch: 'main' } })).toBe('file')
  })
})

describe('validRepoName', () => {
  it('accepts an ordinary owner/repo', () => {
    for (const ok of ['octocat/hello-world', 'a/b', 'Org.Name/repo_1', 'x/y.z-2']) {
      expect(validRepoName(ok), ok).toBe(true)
    }
  })

  it('refuses anything git could read as an option', () => {
    // No shell is involved anywhere on this path and it would STILL be remote
    // code execution: git has options that run commands.
    for (const bad of ['--upload-pack=touch /tmp/x', '-x/y', '--config core.sshCommand=x']) {
      expect(validRepoName(bad), bad).toBe(false)
    }
  })

  it('refuses anything that walks out of the scratch directory', () => {
    for (const bad of ['../../etc/passwd', 'a/../../b', 'a/b/c', '/abs/path']) {
      expect(validRepoName(bad), bad).toBe(false)
    }
  })

  it('refuses the shapes that are not a repo name at all', () => {
    for (const bad of ['', 'noslash', 'a/', '/b', null, undefined, 42, {}, 'a/b '.repeat(60)]) {
      expect(validRepoName(bad as string), String(bad)).toBe(false)
    }
  })
})

describe('validBranch', () => {
  it('accepts real branch names including slashes', () => {
    for (const ok of ['main', 'release/2.1', 'feat/thing-1']) expect(validBranch(ok), ok).toBe(true)
  })

  it('refuses option-shaped and traversing names', () => {
    for (const bad of ['-x', '--exec=x', 'a/../b', '', null, ' main']) {
      expect(validBranch(bad as unknown), String(bad)).toBe(false)
    }
  })
})

describe('cloneArgs', () => {
  it('clones shallow and single-branch', () => {
    const args = cloneArgs(REPO, '.handsel/repos/t1')!
    expect(args).toContain('--depth')
    expect(args).toContain('--single-branch')
    expect(args[args.indexOf('--branch') + 1]).toBe('main')
  })

  it('puts the URL after a bare -- so it can never be read as an option', () => {
    const args = cloneArgs(REPO, 'dest')!
    const sep = args.indexOf('--')
    expect(sep).toBeGreaterThan(0)
    expect(args[sep + 1]).toBe('https://github.com/octocat/hello-world.git')
  })

  it('refuses rather than building a command it cannot vouch for', () => {
    expect(cloneArgs({ fullName: '-evil/x', baseBranch: 'main' }, 'd')).toBe(null)
    expect(cloneArgs({ fullName: 'a/b', baseBranch: '--exec=x' }, 'd')).toBe(null)
  })
})

describe('clonePathFor', () => {
  it('gives each task its own checkout', () => {
    // --concurrency shares one workdir; two jobs in one clone would each
    // diff the other's changes into their own submission.
    expect(clonePathFor('a')).not.toBe(clonePathFor('b'))
  })

  it('cannot be steered out of the scratch directory by a task id', () => {
    expect(clonePathFor('../../etc')).toBe('.handsel/repos/etc')
    expect(clonePathFor('')).toBe('.handsel/repos/task')
  })
})

describe('diffArgs', () => {
  it('diffs the index against the recorded base', () => {
    // Against the base, not HEAD: several harnesses commit their own work,
    // and `git diff --cached` alone then comes back empty.
    const args = diffArgs('a1b2c3d4e5f6')!
    expect(args).toEqual(['diff', '--cached', '--no-color', '--no-ext-diff', 'a1b2c3d4e5f6'])
  })

  it('stages everything first, so created files are in the diff', () => {
    // A diff that silently omits new files is the most common way a repo-job
    // submission fails review, and it reads as the worker forgetting them.
    expect(stageArgs()).toEqual(['add', '-A'])
  })

  it('refuses a base that is not a sha', () => {
    for (const bad of ['', 'HEAD', '--exec=x', 'zzzz']) expect(diffArgs(bad)).toBe(null)
  })
})

describe('diffIsEmpty', () => {
  it('knows a real diff from nothing', () => {
    expect(diffIsEmpty('')).toBe(true)
    expect(diffIsEmpty('   \n\n')).toBe(true)
    expect(diffIsEmpty('I looked at the code and it seems fine.')).toBe(true)
    expect(diffIsEmpty('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toBe(false)
  })
})

describe('wrapDiff', () => {
  const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'

  it('produces something the platform can actually extract', () => {
    // The end-to-end claim: what the worker submits is what lib/repo-jobs.ts
    // pulls back out and turns into a pull request.
    const submitted = wrapDiff(DIFF, 'Renamed the thing and updated its caller.')
    expect(extractUnifiedDiff(submitted)?.trim()).toBe(DIFF)
  })

  it('survives a harness that wrote nothing but the diff', () => {
    expect(extractUnifiedDiff(wrapDiff(DIFF, ''))?.trim()).toBe(DIFF)
  })

  it('keeps prose out of the fence', () => {
    const submitted = wrapDiff(DIFF, 'Some notes.')
    expect(extractUnifiedDiff(submitted)).not.toContain('Some notes.')
    expect(submitted.startsWith('Some notes.')).toBe(true)
  })
})

describe('repoBrief', () => {
  it('says where the checkout is and that the files are the deliverable', () => {
    const brief = repoBrief('Fix the bug.', '.handsel/repos/t1', REPO)
    expect(brief).toContain('Fix the bug.')
    expect(brief).toContain('.handsel/repos/t1')
    expect(brief).toContain('main')
  })

  it('never carries the deliverable-file instruction', () => {
    // Appending it is the exact regression this module exists to undo: on a
    // repo job it overrides the only instruction that mattered.
    const brief = repoBrief('Fix the bug.', '.handsel/repos/t1', REPO)
    expect(brief).not.toMatch(/deliverable-.*\.md/)
    expect(brief).not.toMatch(/nothing else you print is read/i)
  })
})

describe('the worker and the platform agree', () => {
  it('the worker takes the repo path when the poll says so', () => {
    const worker = readFileSync('public/handsel-worker.mjs', 'utf8')
    expect(worker).toMatch(/repo/)
    expect(worker).toMatch(/--cached/)
    expect(worker).toMatch(/```diff/)
  })

  it('the poll tells the worker which repo and branch', () => {
    const route = readFileSync('app/api/worker/poll/route.ts', 'utf8')
    expect(route).toMatch(/repoFullName/)
    expect(route).toMatch(/baseBranch/)
  })
})

describe('a real submission survives the platform side', () => {
  // Captured verbatim from an end-to-end run: the worker cloned
  // octocat/Hello-World, a harness edited files in the checkout, and this is
  // what came back over the callback. The claim being pinned is the whole
  // point of the feature — that what a harness worker submits is something
  // lib/repo-jobs.ts can turn into a pull request.
  const SUBMITTED = [
    'Added NOTES.md and touched README.',
    '',
    '```diff',
    'diff --git a/NOTES.md b/NOTES.md',
    'new file mode 100644',
    'index 0000000..e15ad32',
    '--- /dev/null',
    '+++ b/NOTES.md',
    '@@ -0,0 +1,3 @@',
    '+# Notes',
    '+',
    '+Written by the fake harness',
    'diff --git a/README b/README',
    'index 980a0d5..5b9b522 100644',
    '--- a/README',
    '+++ b/README',
    '@@ -1 +1,2 @@',
    ' Hello World!',
    '+edited by the fake harness',
    '```',
  ].join('\n')

  it('extracts cleanly', () => {
    const diff = extractUnifiedDiff(SUBMITTED)
    expect(diff).not.toBe(null)
    expect(diff).not.toContain('Added NOTES.md and touched README.')
  })

  it('parses into the file patches the PR is built from', async () => {
    const { parseUnifiedDiff } = await import('@/lib/repo-jobs')
    const patches = parseUnifiedDiff(extractUnifiedDiff(SUBMITTED)!)
    expect(patches.map((p) => p.newPath ?? p.oldPath).sort()).toEqual(['NOTES.md', 'README'])
  })

  it('carries a file the harness CREATED, not only ones it edited', () => {
    // `git add -A` before the diff is what puts new files in; without it the
    // submission silently omits them and reads as a worker that forgot.
    expect(extractUnifiedDiff(SUBMITTED)).toContain('new file mode')
  })
})
