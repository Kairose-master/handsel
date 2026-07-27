/**
 * GitHub App client for repo jobs (docs/github-jobs.md, Phase 2).
 *
 * The App is the ONLY holder of repo credentials: workers submit diffs, the
 * platform turns a validated diff into a branch + PR via the Git Data API
 * (pure text manipulation — no clone, no execution), and the requester's own
 * CI + merge decision do the grading and settlement.
 *
 * Config: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET env
 * vars, with the encrypted platform_secrets KV (github_app_id /
 * github_app_private_key / github_webhook_secret) as fallback. Degrades
 * gracefully: unconfigured ⇒ repo jobs fall back to manual diff review.
 */
import { createSign, createHmac, timingSafeEqual } from 'node:crypto'
import { applyUnifiedDiff, type AppliedPatch } from '@/lib/repo-jobs'

const GITHUB_API = 'https://api.github.com'

// ── Config ──────────────────────────────────────────────────────────────

export type GithubAppConfig = { appId: string; privateKey: string }

async function secretOrEnv(envName: string, secretKey: string): Promise<string | null> {
  const fromEnv = process.env[envName]?.trim()
  if (fromEnv) return fromEnv
  const { getPlatformSecret } = await import('@/lib/platform-secret')
  return getPlatformSecret(secretKey)
}

export async function getGithubAppConfig(): Promise<GithubAppConfig | null> {
  const appId = await secretOrEnv('GITHUB_APP_ID', 'github_app_id')
  const rawKey = await secretOrEnv('GITHUB_APP_PRIVATE_KEY', 'github_app_private_key')
  if (!appId || !rawKey) return null
  // Tolerate \n-escaped single-line PEM (a common env-var paste shape).
  const privateKey = rawKey.includes('-----BEGIN') ? rawKey.replace(/\\n/g, '\n') : null
  if (!privateKey) return null
  return { appId, privateKey }
}

export async function isGithubAppConfigured(): Promise<boolean> {
  return (await getGithubAppConfig()) !== null
}

export async function getGithubWebhookSecret(): Promise<string | null> {
  return secretOrEnv('GITHUB_WEBHOOK_SECRET', 'github_webhook_secret')
}

// ── App JWT + installation tokens ───────────────────────────────────────

/** Short-lived RS256 JWT identifying the App itself (no deps — node:crypto). */
export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId })}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  return `${unsigned}.${signer.sign(privateKeyPem).toString('base64url')}`
}

async function ghFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'handsel-repo-jobs',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
}

async function ghJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await ghFetch(path, token, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

// Installation tokens last 1h; cache well inside that.
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

/**
 * Exchange the App JWT for an installation token scoped to the installation
 * that covers `repoFullName`. Throws if the App isn't installed on the repo —
 * that error message is surfaced to requesters as "install the App first".
 */
export async function installationTokenForRepo(repoFullName: string): Promise<string> {
  const cached = tokenCache.get(repoFullName)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const config = await getGithubAppConfig()
  if (!config) throw new Error('GitHub App is not configured on this deployment.')
  const jwt = appJwt(config.appId, config.privateKey)
  const inst = await ghJson<{ id: number }>(`/repos/${repoFullName}/installation`, jwt).catch((e) => {
    throw new Error(
      `The Handsel GitHub App is not installed on ${repoFullName} (or the repo doesn't exist). ` +
        `The requester must install the App on that repository. (${e instanceof Error ? e.message : e})`,
    )
  })
  const tok = await ghJson<{ token: string }>(`/app/installations/${inst.id}/access_tokens`, jwt, { method: 'POST' })
  tokenCache.set(repoFullName, { token: tok.token, expiresAt: Date.now() + 50 * 60 * 1000 })
  return tok.token
}

// ── Repo reads ──────────────────────────────────────────────────────────

export async function repoDefaultBranch(repoFullName: string, token: string): Promise<string> {
  const repo = await ghJson<{ default_branch: string }>(`/repos/${repoFullName}`, token)
  return repo.default_branch
}

/** File content at a ref, or null when the path doesn't exist there. */
export async function fetchRepoFile(repoFullName: string, ref: string, path: string, token: string): Promise<string | null> {
  const res = await ghFetch(`/repos/${repoFullName}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(ref)}`, token)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub contents read of ${path}@${ref} failed: ${res.status}`)
  const body = (await res.json()) as { type?: string; content?: string; encoding?: string }
  if (body.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new Error(`${path} is not a regular file on ${ref} (submodules/symlinks aren't patchable).`)
  }
  return Buffer.from(body.content, 'base64').toString('utf8')
}

/** Existing git mode of a path (e.g. executables are 100755), by walking the
 *  base tree one segment at a time — bounded work, no recursive tree fetch. */
async function existingMode(repoFullName: string, rootTreeSha: string, path: string, token: string): Promise<string | null> {
  try {
    let treeSha = rootTreeSha
    const segments = path.split('/')
    for (let i = 0; i < segments.length; i++) {
      const tree = await ghJson<{ tree: Array<{ path: string; mode: string; type: string; sha: string }> }>(
        `/repos/${repoFullName}/git/trees/${treeSha}`,
        token,
      )
      const entry = tree.tree.find((t) => t.path === segments[i])
      if (!entry) return null
      if (i === segments.length - 1) return entry.mode
      treeSha = entry.sha
    }
  } catch {
    /* best-effort — default mode wins */
  }
  return null
}

// ── The PR pipeline: validated diff → branch → commit → PR ─────────────

export type OpenedPr = { prNumber: number; prUrl: string; branch: string }

/**
 * Turn a worker's unified diff into a real pull request:
 * base ref → apply the diff against fetched base contents (validation — a
 * non-applying diff throws before anything is written) → blobs → tree →
 * commit → branch ref → PR. All Git Data API text operations; nothing from
 * the diff is ever executed.
 */
export async function openPrFromDiff(input: {
  repoFullName: string
  baseBranch: string
  diff: string
  title: string
  body: string
  branchHint: string
}): Promise<OpenedPr> {
  const { repoFullName, diff, title, body } = input
  const token = await installationTokenForRepo(repoFullName)
  const baseBranch = input.baseBranch || (await repoDefaultBranch(repoFullName, token))

  const ref = await ghJson<{ object: { sha: string } }>(
    `/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    token,
  )
  const baseSha = ref.object.sha
  const baseCommit = await ghJson<{ tree: { sha: string } }>(`/repos/${repoFullName}/git/commits/${baseSha}`, token)
  const baseTreeSha = baseCommit.tree.sha

  // Validation gate: every hunk must apply cleanly to the CURRENT base.
  const applied: AppliedPatch[] = await applyUnifiedDiff(diff, (path) => fetchRepoFile(repoFullName, baseSha, path, token))

  const treeEntries: Array<{ path: string; mode: string; type: 'blob'; sha: string | null }> = []
  for (const file of applied) {
    if (file.content === null) {
      treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: null }) // deletion
      continue
    }
    const blob = await ghJson<{ sha: string }>(`/repos/${repoFullName}/git/blobs`, token, {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
    })
    const mode = file.mode ?? (await existingMode(repoFullName, baseTreeSha, file.path, token)) ?? '100644'
    treeEntries.push({ path: file.path, mode: mode === '100755' ? '100755' : '100644', type: 'blob', sha: blob.sha })
  }

  const newTree = await ghJson<{ sha: string }>(`/repos/${repoFullName}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  })
  const commit = await ghJson<{ sha: string }>(`/repos/${repoFullName}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({ message: title, tree: newTree.sha, parents: [baseSha] }),
  })

  const branch = `handsel/${input.branchHint.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)}`
  await ghJson(`/repos/${repoFullName}/git/refs`, token, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  })

  const pr = await ghJson<{ number: number; html_url: string }>(`/repos/${repoFullName}/pulls`, token, {
    method: 'POST',
    body: JSON.stringify({ title, body, head: branch, base: baseBranch }),
  })
  return { prNumber: pr.number, prUrl: pr.html_url, branch }
}

/** Best-effort PR comment (settlement outcomes; failures never propagate). */
export async function commentOnPr(repoFullName: string, prNumber: number, body: string): Promise<void> {
  try {
    const token = await installationTokenForRepo(repoFullName)
    await ghJson(`/repos/${repoFullName}/issues/${prNumber}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
  } catch (e) {
    console.error('[github-app] PR comment failed (non-fatal):', e)
  }
}

// ── What the signed-in user can actually post a job on ─────────────────

export type InstallableRepo = { fullName: string; private: boolean; defaultBranch: string }

/** Where the requester installs (or adjusts) the App. Falls back to the
 *  generic installations page when no slug is configured. */
export function appInstallUrl(): string {
  const slug = process.env.GITHUB_APP_SLUG?.trim()
  return slug ? `https://github.com/apps/${slug}/installations/new` : 'https://github.com/settings/installations'
}

/**
 * Repositories where BOTH are true: the user can access them, and our App is
 * installed on them. That intersection is exactly the set of repos a job can
 * be posted against, so the picker can't offer one that would fail at
 * escrow time. Uses the user's own token — we see only what they see.
 */
export async function listUserInstallationRepos(userToken: string, maxRepos = 200): Promise<InstallableRepo[]> {
  const installs = await ghJson<{ installations: Array<{ id: number }> }>('/user/installations?per_page=100', userToken)
  const repos: InstallableRepo[] = []
  for (const inst of installs.installations ?? []) {
    for (let page = 1; page <= 5 && repos.length < maxRepos; page++) {
      const body = await ghJson<{
        repositories: Array<{ full_name: string; private: boolean; default_branch: string }>
      }>(`/user/installations/${inst.id}/repositories?per_page=100&page=${page}`, userToken).catch(() => null)
      const batch = body?.repositories ?? []
      repos.push(
        ...batch.map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })),
      )
      if (batch.length < 100) break
    }
  }
  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName)).slice(0, maxRepos)
}

// ── Webhook verification ────────────────────────────────────────────────

/** Constant-time check of X-Hub-Signature-256 over the RAW request body. */
export function verifyGithubSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const given = signatureHeader.slice('sha256='.length)
  if (given.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}
