/**
 * GitHub repo jobs — the pure logic (see docs/github-jobs.md).
 *
 * A repo job's deliverable is a UNIFIED DIFF (text). The worker never touches
 * credentials; the platform's GitHub App turns the diff into a PR and the
 * requester's own CI grades it. Everything here is side-effect-free and
 * unit-tested: fence extraction, diff parsing, and patch application (the
 * `git apply --check` analog — apply is text manipulation, not execution).
 */

/** A defect in the WORKER'S diff (malformed, doesn't apply, unsafe path) —
 * distinguished from infra/App errors so grading can fail the worker only
 * for their own submission, never for our plumbing. */
export class DiffRejectedError extends Error {}

// ── Identity ────────────────────────────────────────────────────────────

export const REPO_JOB_TITLE_PREFIX = 'repo → '

/**
 * owner/name, both segments in GitHub's allowed charset.
 *
 * Tightened beyond "the charset" once this name started reaching a `git`
 * argv and a directory name (lib/worker-deliverable.ts): the charset alone
 * admitted `-x/y` and `../..`. Neither is a real repository, and both are
 * dangerous in the new position — git reads a leading dash as an OPTION, and
 * it has options that execute things (`--upload-pack`, `--config
 * core.sshCommand=…`), so no shell needs to be involved for that to be code
 * execution on a worker's machine. `..` walks a clone out of its scratch
 * directory.
 *
 * Both segments must therefore START with an alphanumeric, and `..` is
 * refused outright. GitHub's own rules are narrower still, so this rejects
 * nothing legitimate.
 */
export function validateRepoFullName(s: string): boolean {
  if (typeof s !== 'string' || s.length > 140 || s.includes('..')) return false
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s)
}

export function repoJobTitle(repoFullName: string, title: string): string {
  return `${REPO_JOB_TITLE_PREFIX}${repoFullName}: ${title}`.slice(0, 200)
}

export function repoJobDescription(input: {
  repoFullName: string
  baseBranch: string
  brief: string
  issueUrl?: string | null
}): string {
  const { repoFullName, baseBranch, brief, issueUrl } = input
  return [
    `GitHub repository job on **${repoFullName}** (base branch \`${baseBranch}\`).`,
    '',
    '## The task',
    brief.trim(),
    issueUrl ? `\nIssue: ${issueUrl}` : '',
    '',
    '## How to work this job (no credentials involved)',
    `1. Clone the PUBLIC repo yourself: \`git clone https://github.com/${repoFullName}.git\` (branch \`${baseBranch}\`).`,
    '2. Make the change on your own machine/infrastructure.',
    '3. Submit ONE unified diff as your deliverable, in a ```diff fenced block,',
    `   generated against \`${baseBranch}\` (e.g. \`git diff\` from the repo root, \`a/\`–\`b/\` prefixes).`,
    '',
    'The platform (not you) opens a pull request from your diff. The',
    "repository's own CI then runs as the independent grader, and the",
    'requester merging the PR is what releases the escrow. A diff that does',
    'not apply cleanly to the base branch fails immediately — regenerate it',
    'against the current branch head before submitting.',
  ]
    .filter((l) => l !== null)
    .join('\n')
}

export function repoJobAcceptanceCriteria(input: { repoFullName: string; baseBranch: string; criteria?: string }): string {
  const extra = input.criteria?.trim()
  return [
    `The deliverable is a single unified diff against ${input.repoFullName}@${input.baseBranch} that applies cleanly.`,
    `The pull request opened from it must pass the repository's own CI checks.`,
    extra ? `Additionally: ${extra}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

// ── Diff extraction ─────────────────────────────────────────────────────

/**
 * Pull the unified diff out of a worker's submission. Prefers a ```diff
 * fenced block; falls back to detecting a bare diff in the raw text.
 */
export function extractUnifiedDiff(output: string): string | null {
  const fence = output.match(/```(?:diff|patch)\s*\n([\s\S]*?)```/)
  if (fence && fence[1].trim()) return fence[1].replace(/\s+$/, '') + '\n'
  // Bare diff: find the first line that starts a file patch and take the rest.
  const lines = output.split('\n')
  const start = lines.findIndex(
    (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')),
  )
  if (start === -1) return null
  const candidate = lines.slice(start).join('\n')
  return /^@@ -\d+/m.test(candidate) ? candidate.replace(/\s+$/, '') + '\n' : null
}

// ── Diff parsing ────────────────────────────────────────────────────────

export type HunkLine = { tag: ' ' | '-' | '+'; text: string; noNewline?: boolean }
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: HunkLine[] }
export type FilePatch = {
  oldPath: string | null // null = new file
  newPath: string | null // null = deleted file
  /** git mode from the header ('100644' | '100755' | …) when present. */
  mode: string | null
  /** A `rename from`/`rename to` pair with NO hunks (git's "similarity index
   *  100%" form) — the content is unchanged, only the path moves. Without
   *  this the whole rename would be silently dropped from the PR. */
  pureRename?: true
  hunks: Hunk[]
}

/** The path a patch applies to in the BASE tree (null for new files). */
export function patchTargetPath(p: FilePatch): string | null {
  return p.oldPath
}
/** The path the result lives at (null for deletions). */
export function patchResultPath(p: FilePatch): string | null {
  return p.newPath
}

function stripPathPrefix(raw: string): string | null {
  // "a/lib/x.ts", "b/lib/x.ts" or bare "lib/x.ts"; "/dev/null" → null.
  const p = raw.trim().split('\t')[0] // git appends \t + timestamp in some diffs
  if (p === '/dev/null') return null
  if (p.includes('"')) throw new DiffRejectedError(`Unsupported quoted path in diff: ${p}`)
  const stripped = /^[ab]\//.test(p) ? p.slice(2) : p
  if (!stripped || stripped.startsWith('/') || stripped.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new DiffRejectedError(`Unsafe or empty path in diff: ${p}`)
  }
  return stripped
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse a unified diff into per-file patches. Throws with a worker-actionable
 * message on anything malformed — the message becomes the grading output.
 */
export function parseUnifiedDiff(diff: string): FilePatch[] {
  const lines = diff.split('\n')
  const patches: FilePatch[] = []
  let i = 0
  let pendingMode: string | null = null
  let renameFrom: string | null = null
  let renameTo: string | null = null

  /** git writes a content-free rename as `rename from`/`rename to` with no
   *  hunks; flush it when the file section ends. */
  const flushPendingRename = () => {
    if (renameFrom && renameTo) {
      patches.push({ oldPath: renameFrom, newPath: renameTo, mode: pendingMode, pureRename: true, hunks: [] })
    }
    renameFrom = null
    renameTo = null
  }

  while (i < lines.length) {
    const line = lines[i]
    if (/^(GIT binary patch|Binary files )/.test(line)) {
      throw new DiffRejectedError('Binary patches are not supported — repo jobs take text diffs only.')
    }
    if (line.startsWith('diff --git ')) {
      flushPendingRename()
      pendingMode = null
      i++
      continue
    }
    const renameFromMatch = line.match(/^rename from (.+)$/)
    if (renameFromMatch) {
      renameFrom = stripPathPrefix(renameFromMatch[1])
      i++
      continue
    }
    const renameToMatch = line.match(/^rename to (.+)$/)
    if (renameToMatch) {
      renameTo = stripPathPrefix(renameToMatch[1])
      i++
      continue
    }
    const modeMatch = line.match(/^(?:new file mode|new mode) (\d{6})$/)
    if (modeMatch) {
      pendingMode = modeMatch[1]
      i++
      continue
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const oldPath = stripPathPrefix(line.slice(4))
      const newPath = stripPathPrefix(lines[i + 1].slice(4))
      renameFrom = null // this file section carries real hunks; not a pure rename
      renameTo = null
      if (oldPath === null && newPath === null) throw new DiffRejectedError('Diff has a file with both sides /dev/null.')
      i += 2
      const hunks: Hunk[] = []
      while (i < lines.length && HUNK_RE.test(lines[i])) {
        const m = lines[i].match(HUNK_RE)!
        const hunk: Hunk = {
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
          lines: [],
        }
        i++
        let seenOld = 0
        let seenNew = 0
        while (i < lines.length && (seenOld < hunk.oldLines || seenNew < hunk.newLines)) {
          const raw = lines[i]
          if (raw.startsWith('\\')) {
            // "\ No newline at end of file" — applies to the previous line.
            const prev = hunk.lines[hunk.lines.length - 1]
            if (prev) prev.noNewline = true
            i++
            continue
          }
          const tag = raw[0] === undefined || raw === '' ? ' ' : raw[0]
          const text = raw === '' ? '' : raw.slice(1)
          if (tag === ' ') {
            seenOld++
            seenNew++
            hunk.lines.push({ tag: ' ', text })
          } else if (tag === '-') {
            seenOld++
            hunk.lines.push({ tag: '-', text })
          } else if (tag === '+') {
            seenNew++
            hunk.lines.push({ tag: '+', text })
          } else {
            throw new DiffRejectedError(`Malformed hunk line in diff (expected ' ', '-', '+' or '\\'): ${raw.slice(0, 80)}`)
          }
          i++
        }
        // trailing no-newline marker after the last counted line
        if (i < lines.length && lines[i].startsWith('\\')) {
          const prev = hunk.lines[hunk.lines.length - 1]
          if (prev) prev.noNewline = true
          i++
        }
        if (seenOld !== hunk.oldLines || seenNew !== hunk.newLines) {
          throw new DiffRejectedError(`Hunk at -${hunk.oldStart} is truncated (header counts don't match its lines).`)
        }
        hunks.push(hunk)
      }
      if (hunks.length === 0) throw new DiffRejectedError(`File ${newPath ?? oldPath} has no hunks — not a valid unified diff.`)
      patches.push({ oldPath, newPath, mode: pendingMode, hunks })
      pendingMode = null
      continue
    }
    i++
  }

  flushPendingRename()

  if (patches.length === 0) throw new DiffRejectedError('No file patches found — submit a unified diff (--- / +++ / @@ format).')
  const seen = new Set<string>()
  for (const p of patches) {
    const key = p.newPath ?? p.oldPath!
    if (seen.has(key)) throw new DiffRejectedError(`Duplicate patch for ${key} — submit one patch per file.`)
    seen.add(key)
  }
  return patches
}

// ── Patch application (the `git apply --check` analog) ──────────────────

function splitContent(content: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = content.endsWith('\n')
  const lines = content.split('\n')
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

/**
 * Apply one file's hunks to its original content. `original` is null for new
 * files; returns null for deletions. Context and removed lines must match the
 * original EXACTLY (no fuzz) — a mismatch throws with the offending line, and
 * that message is the worker's failure verdict.
 */
export function applyFilePatch(original: string | null, patch: FilePatch): string | null {
  const label = patch.newPath ?? patch.oldPath ?? '(unknown)'
  if (patch.oldPath === null && original !== null) {
    throw new DiffRejectedError(`${label}: diff creates a new file but it already exists on the base branch.`)
  }
  if (patch.oldPath !== null && original === null) {
    throw new DiffRejectedError(`${patch.oldPath}: file does not exist on the base branch.`)
  }

  if (patch.pureRename) return original ?? ''

  const { lines: src, trailingNewline } = splitContent(original ?? '')
  const out: string[] = []
  let srcIdx = 0
  let lastNoNewline = false

  for (const hunk of patch.hunks) {
    // Unified-diff convention: when oldLines is 0 (pure insertion), oldStart
    // is the line BEFORE the insertion point, not the first affected line.
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    if (start < srcIdx) throw new DiffRejectedError(`${label}: hunks overlap or are out of order.`)
    if (start > src.length) throw new DiffRejectedError(`${label}: hunk at line ${hunk.oldStart} is past the end of the file.`)
    out.push(...src.slice(srcIdx, start))
    srcIdx = start

    for (const l of hunk.lines) {
      if (l.tag === ' ' || l.tag === '-') {
        if (src[srcIdx] !== l.text) {
          throw new DiffRejectedError(
            `${label}: diff does not apply at line ${srcIdx + 1} — expected ${JSON.stringify(l.text).slice(0, 120)}, ` +
              `found ${JSON.stringify(src[srcIdx] ?? '(end of file)').slice(0, 120)}. Regenerate the diff against the current base branch.`,
          )
        }
        srcIdx++
        if (l.tag === ' ') {
          out.push(l.text)
          lastNoNewline = Boolean(l.noNewline)
        }
      } else {
        out.push(l.text)
        lastNoNewline = Boolean(l.noNewline)
      }
    }
  }
  out.push(...src.slice(srcIdx))
  if (srcIdx < src.length) lastNoNewline = !trailingNewline

  if (patch.newPath === null) {
    if (out.length > 0) {
      throw new DiffRejectedError(`${label}: diff deletes the file but does not remove all its lines — regenerate with \`git diff\`.`)
    }
    return null
  }
  if (out.length === 0) return ''
  return out.join('\n') + (lastNoNewline ? '' : '\n')
}

/** Result of checking a whole diff against fetched base contents. */
export type AppliedPatch = { path: string; content: string | null; mode: string | null }

/**
 * Apply every file patch given a loader for base-branch contents. This is the
 * platform's validation gate before any PR is opened.
 */
export async function applyUnifiedDiff(
  diff: string,
  fetchOriginal: (path: string) => Promise<string | null>,
  opts?: { maxFiles?: number },
): Promise<AppliedPatch[]> {
  const patches = parseUnifiedDiff(diff)
  const maxFiles = opts?.maxFiles ?? 40
  if (patches.length > maxFiles) throw new DiffRejectedError(`Diff touches ${patches.length} files — the limit is ${maxFiles}.`)
  const results: AppliedPatch[] = []
  for (const patch of patches) {
    const original = patch.oldPath === null ? null : await fetchOriginal(patch.oldPath)
    const content = applyFilePatch(original, patch)
    if (patch.newPath !== null && patch.oldPath !== null && patch.newPath !== patch.oldPath) {
      // Rename: delete the old path, create the new one.
      results.push({ path: patch.oldPath, content: null, mode: null })
    }
    results.push({ path: patch.newPath ?? patch.oldPath!, content, mode: patch.mode })
  }
  return results
}
