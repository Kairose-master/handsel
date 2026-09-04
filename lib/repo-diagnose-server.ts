/**
 * The free, no-account Repo Care diagnostic — GitHub's own public API,
 * unauthenticated, so a cold prospect (or a sales DM's recipient) can see
 * what tonight would look like before signing in, connecting anything, or
 * touching the GitHub App.
 *
 * Deliberately NOT `lib/github-app.ts`'s `listOpenIssues`: that function
 * throws unless the Handsel App is already installed on the repo, which is
 * correct for the App's own job (it is about to write to that repo) and
 * wrong for a diagnostic that has to work on a stranger's public repo the
 * App has never seen. This reads the public REST API instead — no
 * installation, no token, and therefore no write access either; a private
 * repo simply can't be diagnosed this way, which the error message says.
 */
import { DEFAULT_REPO_CARE, summarizeTriage, triageIssues, type Diagnostic, type RepoIssue } from '@/lib/repo-care'

const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/

export type DiagnoseResult = { ok: true; diagnostic: Diagnostic } | { ok: false; error: string }

/** `owner/repo`, trimmed of a leading `github.com/` a pasted URL might carry. */
export function normalizeRepoInput(raw: string): string | null {
  const s = raw.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  return REPO_RE.test(s) ? s : null
}

export async function diagnoseRepo(repoFullNameRaw: string): Promise<DiagnoseResult> {
  const repoFullName = normalizeRepoInput(repoFullNameRaw)
  if (!repoFullName) return { ok: false, error: 'Give it as owner/repo, e.g. facebook/react.' }

  let res: Response
  try {
    res = await fetch(`https://api.github.com/repos/${repoFullName}/issues?state=open&per_page=100`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'handsel-repo-care-diagnostic' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return { ok: false, error: 'Could not reach GitHub just now — try again in a moment.' }
  }
  if (res.status === 404) return { ok: false, error: `${repoFullName} isn't public, or doesn't exist.` }
  if (res.status === 403) {
    // Unauthenticated GitHub reads are capped at 60/hour per source IP,
    // shared across every visitor hitting this from the same deployment.
    // Honest about the cause rather than a generic failure.
    return { ok: false, error: "GitHub's rate limit for anonymous requests is used up for a moment — try again shortly." }
  }
  if (!res.ok) return { ok: false, error: `GitHub answered ${res.status} for ${repoFullName}.` }

  const rows = (await res.json()) as Array<{ number: number; title: string; body: string | null; labels: Array<{ name?: string } | string>; pull_request?: unknown }>
  const issues: RepoIssue[] = rows.map((r) => ({
    number: r.number,
    title: String(r.title ?? ''),
    body: String(r.body ?? ''),
    labels: (r.labels ?? []).map((l) => (typeof l === 'string' ? l : String(l?.name ?? ''))).filter(Boolean),
    isPullRequest: Boolean(r.pull_request),
  }))
  const triage = triageIssues(issues, { ...DEFAULT_REPO_CARE, repoFullName })
  return { ok: true, diagnostic: summarizeTriage(repoFullName, triage) }
}
