/**
 * What the worker is actually supposed to hand back — and the repo-job case
 * the harness mode broke.
 *
 * `lib/repo-jobs.ts` already tells a worker, in the brief the platform sends:
 * clone the public repo, make the change, and *submit ONE unified diff in a
 * ```diff fenced block*. The platform side of that is complete — `extractUnifiedDiff`
 * pulls it out, `parseUnifiedDiff` validates every path, `openPrFromDiff`
 * opens the pull request, the repository's own CI is the independent grader,
 * and the requester merging is what releases the escrow.
 *
 * Harness mode then appended, to every brief: "write your deliverable to
 * `.handsel/deliverable-<task>.md` — nothing else you print is read." On a
 * repo job that overrides the only instruction that mattered. The harness
 * writes a summary, the worker submits the summary, `extractUnifiedDiff` finds
 * nothing, and the job fails. Not a gap in a new feature: a regression that
 * broke the one job type a coding harness exists for.
 *
 * So the deliverable is decided PER JOB rather than per worker. A repo job
 * gets a scratch clone, the harness works in it, and `git` produces the diff —
 * no prose anywhere in the loop. Everything else keeps the file handoff.
 *
 * Pure: this decides the mode, builds the argv, and shapes the submission.
 * `public/handsel-worker.mjs` runs it. Which matters most for `cloneArgs`,
 * where a repository name arrives from a stranger's job spec and ends up in
 * a URL and a filesystem path.
 */

export type TaskRepo = {
  fullName: string
  /** The branch the diff must apply to. NULL means "whatever the repository's
   *  default is" — which is not the same as 'main'. Guessing 'main' was a real
   *  bug: `octocat/Hello-World` defaults to `master`, and the clone simply
   *  fails with "Remote branch main not found". `git clone --single-branch`
   *  with no `--branch` takes the real default, so the correct answer needs no
   *  API call and cannot be wrong. */
  baseBranch?: string | null
}

export type TaskShape = {
  taskId: string
  deliverableKind?: string | null
  repo?: TaskRepo | null
}

export type DeliverableMode =
  /** A unified diff, from a scratch clone. */
  | 'diff'
  /** Whatever the harness writes to the agreed file. */
  | 'file'

export function modeFor(task: TaskShape): DeliverableMode {
  return task.repo && validateRepoFullName(task.repo.fullName) ? 'diff' : 'file'
}

/**
 * The repo name check is `lib/repo-jobs.ts`'s, not a second copy.
 *
 * That module already owns what a repo name may look like, and it was
 * tightened rather than duplicated when this file started putting the name
 * into a `git` argv and a directory path — two copies of one rule are how
 * the two start disagreeing about the same string, which for a security
 * check means one of them is wrong and nobody knows which.
 */
export { validateRepoFullName as validRepoName } from '@/lib/repo-jobs'
import { validateRepoFullName } from '@/lib/repo-jobs'

/** A branch name lands in the same argv. Same reasoning. */
export function validBranch(branch: unknown): branch is string {
  if (typeof branch !== 'string' || !branch || branch.length > 200) return false
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(branch) && !branch.includes('..')
}

/** Where a repo job's clone goes, relative to the worker's `--workdir`. One
 *  per task for the same reason the deliverable file is one per task: with
 *  `--concurrency` two jobs share a workdir. */
export function clonePathFor(taskId: string): string {
  const safe = String(taskId).replace(/[^A-Za-z0-9_-]/g, '') || 'task'
  return `.handsel/repos/${safe.slice(0, 64)}`
}

/** Shallow, single-branch: a worker needs the tree to change, never the
 *  history, and a full clone of a large repo is minutes of someone else's
 *  bandwidth per job. */
export function cloneArgs(repo: TaskRepo, dest: string): string[] | null {
  if (!validateRepoFullName(repo.fullName)) return null
  // A named branch must be a valid one; an ABSENT branch is fine and means
  // "the repository's default", which --single-branch alone already gives.
  if (repo.baseBranch != null && repo.baseBranch !== '' && !validBranch(repo.baseBranch)) return null
  return [
    'clone',
    '--depth',
    '1',
    '--single-branch',
    ...(repo.baseBranch ? ['--branch', repo.baseBranch] : []),
    // `--` so a name that somehow got past validation still cannot be read
    // as an option. Belt and braces, and free.
    '--',
    `https://github.com/${repo.fullName}.git`,
    dest,
  ]
}

/**
 * The two commands that turn "the harness changed some files" into a diff.
 *
 * `add -A` first so files the harness CREATED are in the index — a diff that
 * silently omits new files is the most common way a repo-job submission fails
 * review, and it looks like the worker forgot to write them.
 *
 * Then `diff --cached <base>`: index against the commit we cloned. Comparing
 * against the recorded base rather than HEAD is what makes this work whether
 * or not the harness committed its own work — several of them do, and
 * `git diff --cached` alone would then come back empty.
 */
export function stageArgs(): string[] {
  return ['add', '-A']
}

export function diffArgs(baseSha: string): string[] | null {
  if (!/^[0-9a-f]{7,64}$/i.test(baseSha)) return null
  return ['diff', '--cached', '--no-color', '--no-ext-diff', baseSha]
}

/** A diff of nothing. Submitting it wastes the bounty and reads, to whoever
 *  reviews the job, as a worker that did not try. */
export function diffIsEmpty(diff: string): boolean {
  return !diff.trim().split('\n').some((l) => l.startsWith('diff --git ') || l.startsWith('--- '))
}

/**
 * The submission for a repo job.
 *
 * The fence is not decoration: `extractUnifiedDiff` in lib/repo-jobs.ts prefers a
 * ```diff block, and a bare diff with the harness's prose around it is
 * exactly the case its fallback heuristic gets wrong.
 */
export function wrapDiff(diff: string, summary: string): string {
  const notes = summary.trim()
  return [notes, notes ? '' : null, '```diff', diff.trimEnd(), '```'].filter((l) => l !== null).join('\n')
}

/**
 * The brief a harness gets for a repo job.
 *
 * Deliberately does NOT carry the deliverable-file instruction. The platform's
 * own repo-job brief already says what to submit; appending a second, louder
 * instruction that contradicts it is the bug this module exists to undo. All
 * this adds is where the checkout is, which the harness cannot know.
 */
export function repoBrief(platformBrief: string, clonePath: string, repo: TaskRepo): string {
  return [
    platformBrief.trim(),
    '',
    '---',
    '',
    'HOW THIS RUN IS SET UP:',
    `${repo.fullName} is already cloned for you at \`${clonePath}\`${repo.baseBranch ? ` on branch \`${repo.baseBranch}\`` : ''}, and that is your working directory.`,
    'Make the change there, in the files. Do not print a diff and do not write a summary file —',
    'the diff is taken from the checkout with git once you are done, so what is on disk IS the deliverable.',
  ].join('\n')
}
