/**
 * Agent portfolio repos — each agent can have its own GitHub repository,
 * and every PAID job's deliverable is committed there with provenance.
 *
 * Why this exists: docs/product-thesis.md names portability as one of the
 * two real gaps — a work proof is verifiable on this platform, but an
 * agent's track record should survive OUTSIDE it, somewhere a stranger
 * already trusts and can browse. A GitHub repo per agent is exactly that:
 * a public, timestamped, diffable record of what the agent actually
 * delivered and got paid for, one commit per settled job.
 *
 * What "honest" required here, in order:
 *
 *  - **We do not create the repo.** The GitHub App's permission set is
 *    Contents/PRs/Issues/Checks/Metadata — deliberately narrow
 *    (docs/github-jobs.md: "Nothing else") — and repo creation would need
 *    Administration:write, which forces every existing installation to
 *    re-approve. So the OWNER creates the repo on GitHub, installs the
 *    same App the repo-jobs pipeline already uses, and binds it here. The
 *    bind check is real: the repo must appear in the owner's own
 *    `listUserInstallationRepos` — the same "you can see it AND our App is
 *    installed on it" intersection the repo-job picker enforces.
 *
 *  - **Only PAID work is committed.** The hook is creditWorkerForJob
 *    (app/actions/labor.ts) — the single choke point every settlement path
 *    already flows through (auto-approve, both manual approve paths,
 *    delegation ticks, reconciliation). By the time it runs, escrow has
 *    moved on-chain. Note this is deliberately BEFORE that function's
 *    same-owner guard: an office's own pipeline jobs earn no credit event
 *    (self-dealing cannot buy reputation) but the work is real and paid,
 *    and a portfolio records work — it is not a credit score.
 *
 *  - **Best-effort, never load-bearing.** A portfolio commit failure logs
 *    and settlement proceeds untouched — same posture as proof issuance
 *    and settlement splits, its neighbors in the settle path. GitHub being
 *    down must never strand money.
 *
 *  - **Idempotent against the sweep.** Settlement paths re-observe
 *    completed jobs; the dedup row in `agent_repo_commit` closes the
 *    sequential case, and the deterministic file path closes the
 *    concurrent one — a second PUT of an existing path without its sha is
 *    a 422 from GitHub itself, which we record as already-mirrored.
 *
 * Trust note (this writes to an external service with owner-granted
 * credentials): the committed content is the deliverable the owner's agent
 * was already paid for, going to a repo the owner explicitly bound after
 * installing the App on it. Nothing here touches repos that were not
 * deliberately bound, and unbinding stops future commits immediately.
 */
import { pool, db } from '@/lib/db'
import { agent, jobSpec, agentTask } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { excerptForBrief } from '@/lib/brief-excerpt'

/** GitHub's Contents API caps writes around 1 MB of content; stay well
 *  under it and disclose any cut in the committed file itself. */
export const PORTFOLIO_DELIVERABLE_LIMIT = 700_000

export type AgentRepoBinding = {
  agentId: string
  repoFullName: string
  boundAt: Date
}

export type MirroredCommit = {
  jobId: number
  repoFullName: string
  path: string
  committedAt: Date
}

// ── Pure parts (unit-tested without a database or GitHub) ────────────────

/** Deterministic path for one job's deliverable file. Deterministic is
 *  load-bearing: it is what makes a concurrent double-commit collide (422)
 *  instead of writing twice. Jobs are numbered on-chain, so the id alone
 *  is unique; the slug exists for humans browsing the repo. */
export function portfolioFilePath(jobId: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'job'
  return `deliverables/job-${jobId}-${slug}.md`
}

export function portfolioCommitMessage(jobId: number, title: string): string {
  return `job #${jobId} settled: ${title.slice(0, 72)}`
}

/**
 * The committed document. Provenance first, deliverable second, and any
 * truncation disclosed in platform-authored text (lib/brief-excerpt.ts's
 * rule). Every field is a real settlement fact — nothing decorative.
 */
export function renderPortfolioMarkdown(input: {
  jobId: number
  title: string
  specHash: string | null
  bountyUsd: number
  txHash: string
  agentName: string
  proofUrl: string | null
  deliverableText: string | null
  settledAt: Date
}): string {
  const lines = [
    `# ${input.title}`,
    '',
    `| | |`,
    `|---|---|`,
    `| Job | #${input.jobId} (Handsel labor market) |`,
    `| Worker | ${input.agentName} |`,
    `| Bounty | $${input.bountyUsd.toFixed(2)} USDC |`,
    `| Settled | ${input.settledAt.toISOString()} |`,
    `| Settlement tx | ${input.txHash} |`,
  ]
  if (input.specHash) lines.push(`| Spec hash | ${input.specHash} |`)
  if (input.proofUrl) lines.push(`| Work proof | ${input.proofUrl} |`)
  lines.push('', '---', '')
  if (input.deliverableText) {
    const cut = excerptForBrief(input.deliverableText, PORTFOLIO_DELIVERABLE_LIMIT)
    lines.push(cut.text)
    if (cut.truncated) {
      lines.push(
        '',
        `> PLATFORM NOTICE: ${cut.omitted.toLocaleString('en-US')} characters were cut from the end of this deliverable to fit GitHub's file-write limit. The spec hash above still commits to the full paid-for bytes.`,
      )
    }
  } else {
    lines.push(
      `_This job's deliverable is not text (an image or audio artifact, or its task record has expired). The settlement facts above are the record; the work proof link, when present, fingerprints the actual bytes._`,
    )
  }
  return lines.join('\n') + '\n'
}

// ── Storage (self-migrating, same pattern as agent_office_slot) ──────────

let tablesReady = false
async function ensureTables(): Promise<void> {
  if (tablesReady) return
  await pool.query(
    `CREATE TABLE IF NOT EXISTS agent_repo (
       agent_id text PRIMARY KEY,
       repo_full_name text NOT NULL,
       bound_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS agent_repo_commit (
       agent_id text NOT NULL,
       job_id integer NOT NULL,
       repo_full_name text NOT NULL,
       path text NOT NULL,
       committed_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (agent_id, job_id)
     )`,
  )
  tablesReady = true
}

async function requireOwnedAgent(userId: string, agentId: string) {
  const [row] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!row || row.userId !== userId) throw new Error('Not your agent')
  return row
}

/** Bind a repo to an agent. The repo must be one the owner's own GitHub
 *  identity can see through an installation of our App — the exact
 *  intersection the repo-job picker uses, re-checked server-side here so a
 *  hand-crafted request can't bind someone else's repository. */
export async function bindAgentRepo(input: { userId: string; agentId: string; repoFullName: string }): Promise<AgentRepoBinding> {
  await requireOwnedAgent(input.userId, input.agentId)

  const { githubUserToken } = await import('@/lib/github-identity')
  const token = await githubUserToken(input.userId)
  if (!token) throw new Error('Connect GitHub first (Settings → GitHub) — binding needs your GitHub identity.')
  const { listUserInstallationRepos } = await import('@/lib/github-app')
  const repos = await listUserInstallationRepos(token)
  if (!repos.some((r) => r.fullName === input.repoFullName)) {
    throw new Error(
      `"${input.repoFullName}" is not a repo you can see with our App installed. Create it on GitHub, install the App on it, then bind.`,
    )
  }

  await ensureTables()
  const boundAt = new Date()
  await pool.query(
    `INSERT INTO agent_repo (agent_id, repo_full_name, bound_at) VALUES ($1, $2, $3)
     ON CONFLICT (agent_id) DO UPDATE SET repo_full_name = EXCLUDED.repo_full_name, bound_at = EXCLUDED.bound_at`,
    [input.agentId, input.repoFullName, boundAt],
  )
  return { agentId: input.agentId, repoFullName: input.repoFullName, boundAt }
}

export async function unbindAgentRepo(input: { userId: string; agentId: string }): Promise<void> {
  await requireOwnedAgent(input.userId, input.agentId)
  await ensureTables()
  await pool.query(`DELETE FROM agent_repo WHERE agent_id = $1`, [input.agentId])
}

export async function agentRepoBinding(agentId: string): Promise<AgentRepoBinding | null> {
  await ensureTables()
  const { rows } = await pool.query<{ agent_id: string; repo_full_name: string; bound_at: Date }>(
    `SELECT * FROM agent_repo WHERE agent_id = $1`,
    [agentId],
  )
  if (!rows[0]) return null
  return { agentId: rows[0].agent_id, repoFullName: rows[0].repo_full_name, boundAt: rows[0].bound_at }
}

export async function agentRepoCommits(userId: string, agentId: string): Promise<MirroredCommit[]> {
  await requireOwnedAgent(userId, agentId)
  await ensureTables()
  const { rows } = await pool.query<{ job_id: number; repo_full_name: string; path: string; committed_at: Date }>(
    `SELECT job_id, repo_full_name, path, committed_at FROM agent_repo_commit WHERE agent_id = $1 ORDER BY committed_at DESC LIMIT 50`,
    [agentId],
  )
  return rows.map((r) => ({ jobId: r.job_id, repoFullName: r.repo_full_name, path: r.path, committedAt: r.committed_at }))
}

// ── The settlement hook ──────────────────────────────────────────────────

/**
 * Mirror one paid job into the worker agent's bound repo, if any. Called
 * from creditWorkerForJob — see this file's header for why that exact
 * choke point, and why before its same-owner guard. Never throws.
 */
export async function mirrorSettledJobToAgentRepo(input: {
  agentId: string
  jobId: number
  bounty: number
  txHash: string
}): Promise<void> {
  try {
    const binding = await agentRepoBinding(input.agentId)
    if (!binding) return // the common case — fast, one indexed select

    const { rows: done } = await pool.query(
      `SELECT 1 FROM agent_repo_commit WHERE agent_id = $1 AND job_id = $2`,
      [input.agentId, input.jobId],
    )
    if (done.length > 0) return

    const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.onchainJobId, input.jobId))
    const [workerAgent] = await db.select().from(agent).where(eq(agent.id, input.agentId))
    if (!workerAgent) return
    const title = spec?.title ?? `Job #${input.jobId}`

    let deliverableText: string | null = null
    if (spec?.agentTaskId) {
      const [task] = await db.select().from(agentTask).where(eq(agentTask.id, spec.agentTaskId))
      deliverableText = task?.output ?? null
    }

    // Best-effort proof link — the auto-approve path issues the proof
    // AFTER crediting, so on that path it usually isn't there yet; a
    // reconciliation or later sweep would carry it. Absence is fine: the
    // spec hash and tx hash are already committed facts.
    let proofUrl: string | null = null
    try {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM work_proofs WHERE job_ref = $1 ORDER BY created_at DESC LIMIT 1`,
        [`#${input.jobId}`],
      )
      if (rows[0]) {
        const { absoluteUrl } = await import('@/lib/origin')
        proofUrl = absoluteUrl(`/proof/${rows[0].id}`)
      }
    } catch {
      // proofs table may not exist yet on a fresh deployment — fine
    }

    const path = portfolioFilePath(input.jobId, title)
    const body = renderPortfolioMarkdown({
      jobId: input.jobId,
      title,
      specHash: spec?.specHash ?? null,
      bountyUsd: input.bounty,
      txHash: input.txHash,
      agentName: workerAgent.name,
      proofUrl,
      deliverableText,
      settledAt: new Date(),
    })

    const { installationTokenForRepo } = await import('@/lib/github-app')
    const token = await installationTokenForRepo(binding.repoFullName)
    const res = await fetch(`https://api.github.com/repos/${binding.repoFullName}/contents/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        message: portfolioCommitMessage(input.jobId, title),
        content: Buffer.from(body, 'utf8').toString('base64'),
      }),
      signal: AbortSignal.timeout(20_000),
    })

    // 201 = committed; 422 = the deterministic path already exists (a
    // concurrent sweep beat us) — both mean the job is mirrored.
    if (!res.ok && res.status !== 422) {
      throw new Error(`GitHub responded ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }

    await pool.query(
      `INSERT INTO agent_repo_commit (agent_id, job_id, repo_full_name, path) VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, job_id) DO NOTHING`,
      [input.agentId, input.jobId, binding.repoFullName, path],
    )
    console.log(`[agent-repo] mirrored job #${input.jobId} → ${binding.repoFullName}/${path}`)
  } catch (error) {
    // Portfolio is a mirror, never load-bearing: log and let settlement
    // proceed exactly as if no repo were bound.
    console.error(`[agent-repo] mirror failed for job #${input.jobId} (settlement unaffected):`, error)
  }
}
