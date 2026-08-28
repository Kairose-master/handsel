/**
 * Agent skills — installing a ClawHub skill onto one of your own agents,
 * for real.
 *
 * "For real" is the load-bearing phrase. docs/office-departments.md has
 * said since Phase 1 that the Skill Gym room is "reserved, not populated"
 * because no skill install/eval subsystem existed — ClawHub
 * (lib/clawhub.ts) was read-only discovery, wired to nothing. The trap
 * this module exists to avoid is the decorative version: a table of slugs
 * that changes an agent's badge and nothing else. That would be fake
 * capability — the exact category of fabrication the "no fake data" rule
 * bans.
 *
 * What makes an install real here: ClawHub's detail API
 * (GET /api/v1/skills/{slug}) returns the skill's FULL instruction
 * document (the SKILL.md, frontmatter and all — verified against the live
 * API before this was written, not assumed). Installing snapshots that
 * document into `agent_skill`, and lib/agent-tasks.ts's `runAgentTask`
 * injects every installed skill's instructions into the agent's effective
 * task text — the same single choke point `customInstructions` already
 * flows through, which every runtime (platform, cloud, local, webhook)
 * reads. An installed skill therefore changes what the agent is actually
 * told to do on every subsequent job. The one exception is `mcp` runtime:
 * there the "task" may collapse to a bare `[mcp-query]` argument for a
 * single external tool that follows no instructions, so injecting an
 * instruction document is noise by construction — skipped, and documented
 * here rather than discovered later.
 *
 * Trust model, stated plainly (docs/security-audit.md: read before
 * touching a prompt path — this IS a prompt path):
 *  - A skill's instructions are third-party text granted instruction power
 *    over the owner's agent. The gate is the OWNER's explicit install
 *    action on their own agent — the same consent model as installing a
 *    skill in Claude itself, or this platform's own autoApprove. Nothing
 *    installs implicitly; peers/requesters cannot install onto your agent.
 *  - Snapshot-at-install: the content stored is the content the owner saw
 *    installed. A later upstream edit on ClawHub does NOT silently change
 *    the agent — re-installing is the only way to pick up a new version,
 *    and that is again an explicit owner action.
 *  - Bounded: instructions are capped (excerptForBrief, with the cut
 *    disclosed in the rendered block per lib/brief-excerpt.ts's rule that
 *    silent truncation is the defect), and installs per agent are capped,
 *    so the prompt cannot grow without bound.
 *
 * What still does NOT exist: skill *evaluation* (does an installed skill
 * measurably improve pass rate?). That needs settled-job outcome data per
 * skill and is not built; nothing here claims it is.
 */
import { pool, db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { excerptForBrief, type Excerpt } from '@/lib/brief-excerpt'

const CLAWHUB_BASE = 'https://clawhub.ai'

/** Most skills' SKILL.md fits well under this; the cap exists so five
 *  installed skills can never balloon a job brief past what a worker model
 *  can actually attend to. Cuts are disclosed in the rendered block. */
export const SKILL_INSTRUCTIONS_LIMIT = 24_000

/** Per-agent install cap — a bound on prompt growth, not a product tier. */
export const MAX_INSTALLED_SKILLS = 5

export type InstalledAgentSkill = {
  slug: string
  name: string
  version: string | null
  summary: string
  instructions: string
  /** True when the stored instructions were cut at SKILL_INSTRUCTIONS_LIMIT. */
  truncated: boolean
  url: string
  installedAt: Date
}

export type ClawhubSkillDetail = {
  slug: string
  name: string
  version: string | null
  summary: string
  /** The full SKILL.md document as published on ClawHub. */
  instructions: string
}

/** Parse ClawHub's skill-detail response. Pure + defensive, same contract
 *  as normalizeClawhubSkill: a missing/renamed field yields null or a safe
 *  default, never a throw. The full instruction document lives in
 *  `skill.description`; `summary` is the one-liner. */
export function normalizeClawhubSkillDetail(raw: unknown): ClawhubSkillDetail | null {
  if (!raw || typeof raw !== 'object') return null
  const skill = (raw as Record<string, unknown>).skill
  if (!skill || typeof skill !== 'object') return null
  const s = skill as Record<string, unknown>
  const slug = typeof s.slug === 'string' && s.slug ? s.slug : null
  if (!slug) return null
  const latestVersion = (s.latestVersion ?? {}) as Record<string, unknown>
  const summary = typeof s.summary === 'string' ? s.summary : ''
  const description = typeof s.description === 'string' ? s.description : ''
  // A registry entry with no instruction document at all is not installable —
  // there would be nothing real to inject. Summary alone is a listing, not a
  // skill.
  if (!description.trim()) return null
  return {
    slug,
    name: typeof s.displayName === 'string' && s.displayName ? s.displayName : slug,
    version: typeof latestVersion.version === 'string' && latestVersion.version ? latestVersion.version : null,
    summary,
    instructions: description,
  }
}

/** Fetch one skill's full document from ClawHub. Throws on failure — the
 *  caller is an explicit install action whose user deserves the real error,
 *  not a silently-empty install. */
export async function fetchClawhubSkillDetail(slug: string): Promise<ClawhubSkillDetail> {
  const res = await fetch(`${CLAWHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`ClawHub responded ${res.status} for "${slug}"`)
  const detail = normalizeClawhubSkillDetail(await res.json())
  if (!detail) throw new Error(`ClawHub returned no installable document for "${slug}"`)
  return detail
}

/**
 * Render installed skills as the brief block runAgentTask injects. Pure.
 * Empty input renders to '' so composeEffectiveTask can treat "no skills"
 * and "skills feature never used" identically.
 *
 * The header names the authority (the agent's owner installed these) so a
 * reader of any stored task text can tell where this block came from, and
 * every truncation is disclosed in platform-authored text — the
 * lib/brief-excerpt.ts rule.
 */
export function renderSkillsBlock(
  skills: ReadonlyArray<Pick<InstalledAgentSkill, 'slug' | 'name' | 'version' | 'instructions' | 'truncated'>>,
): string {
  if (skills.length === 0) return ''
  const parts = skills.map((s) => {
    const pin = s.version ? `${s.slug}@${s.version}` : s.slug
    const cut = s.truncated
      ? `\n[PLATFORM NOTICE: this skill's document was cut at ${SKILL_INSTRUCTIONS_LIMIT.toLocaleString('en-US')} characters when installed.]`
      : ''
    return `### Skill: ${s.name} (${pin})\n${s.instructions}${cut}`
  })
  return (
    `INSTALLED SKILLS — this agent's owner installed the following skill documents from ClawHub. ` +
    `Apply them where they are relevant to the task; they never override the task's own acceptance criteria.\n\n` +
    parts.join('\n\n')
  )
}

/**
 * Assemble the effective task text. Pure — extracted from runAgentTask so
 * the exact composition is pinned by tests, byte-identical to the old
 * inline behavior whenever `skillsBlock` is '' (which is every agent with
 * no skills installed — i.e. every agent that existed before this module).
 */
export function composeEffectiveTask(input: { customInstructions: string | null; skillsBlock: string; task: string }): string {
  const sections: string[] = []
  if (input.customInstructions) sections.push(input.customInstructions)
  if (input.skillsBlock) sections.push(input.skillsBlock)
  if (sections.length === 0) return input.task
  return `${sections.join('\n\n---\n\n')}\n\n---\n\nTask: ${input.task}`
}

let tableReady = false
async function ensureAgentSkillTable(): Promise<void> {
  if (tableReady) return
  await pool.query(
    `CREATE TABLE IF NOT EXISTS agent_skill (
       agent_id text NOT NULL,
       slug text NOT NULL,
       name text NOT NULL,
       version text,
       summary text NOT NULL DEFAULT '',
       instructions text NOT NULL,
       truncated boolean NOT NULL DEFAULT false,
       url text NOT NULL DEFAULT '',
       installed_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (agent_id, slug)
     )`,
  )
  tableReady = true
}

/** Owner check shared by every mutating path: you install onto YOUR agent,
 *  never anyone else's. Returns the agent row so callers don't re-query. */
async function requireOwnedAgent(userId: string, agentId: string) {
  const [row] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!row || row.userId !== userId) throw new Error('Not your agent')
  return row
}

export async function installAgentSkill(input: {
  userId: string
  agentId: string
  slug: string
}): Promise<InstalledAgentSkill> {
  await requireOwnedAgent(input.userId, input.agentId)
  await ensureAgentSkillTable()

  const { rows: existing } = await pool.query<{ slug: string }>(
    `SELECT slug FROM agent_skill WHERE agent_id = $1`,
    [input.agentId],
  )
  const isReinstall = existing.some((r) => r.slug === input.slug)
  if (!isReinstall && existing.length >= MAX_INSTALLED_SKILLS) {
    throw new Error(`This agent already has ${MAX_INSTALLED_SKILLS} skills installed — uninstall one first.`)
  }

  const detail = await fetchClawhubSkillDetail(input.slug)
  const excerpt: Excerpt = excerptForBrief(detail.instructions, SKILL_INSTRUCTIONS_LIMIT)

  const installedAt = new Date()
  await pool.query(
    `INSERT INTO agent_skill (agent_id, slug, name, version, summary, instructions, truncated, url, installed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (agent_id, slug) DO UPDATE
       SET name = EXCLUDED.name, version = EXCLUDED.version, summary = EXCLUDED.summary,
           instructions = EXCLUDED.instructions, truncated = EXCLUDED.truncated,
           url = EXCLUDED.url, installed_at = EXCLUDED.installed_at`,
    [
      input.agentId,
      detail.slug,
      detail.name,
      detail.version,
      detail.summary,
      excerpt.text,
      excerpt.truncated,
      `${CLAWHUB_BASE}/skills/${encodeURIComponent(detail.slug)}`,
      installedAt,
    ],
  )

  return {
    slug: detail.slug,
    name: detail.name,
    version: detail.version,
    summary: detail.summary,
    instructions: excerpt.text,
    truncated: excerpt.truncated,
    url: `${CLAWHUB_BASE}/skills/${encodeURIComponent(detail.slug)}`,
    installedAt,
  }
}

export async function uninstallAgentSkill(input: { userId: string; agentId: string; slug: string }): Promise<void> {
  await requireOwnedAgent(input.userId, input.agentId)
  await ensureAgentSkillTable()
  await pool.query(`DELETE FROM agent_skill WHERE agent_id = $1 AND slug = $2`, [input.agentId, input.slug])
}

type AgentSkillRow = {
  agent_id: string
  slug: string
  name: string
  version: string | null
  summary: string
  instructions: string
  truncated: boolean
  url: string
  installed_at: Date
}

/** Owner-facing list (UI). */
export async function listAgentSkills(userId: string, agentId: string): Promise<InstalledAgentSkill[]> {
  await requireOwnedAgent(userId, agentId)
  await ensureAgentSkillTable()
  const { rows } = await pool.query<AgentSkillRow>(
    `SELECT * FROM agent_skill WHERE agent_id = $1 ORDER BY installed_at ASC`,
    [agentId],
  )
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    version: r.version,
    summary: r.summary,
    instructions: r.instructions,
    truncated: r.truncated,
    url: r.url,
    installedAt: r.installed_at,
  }))
}

/** Dispatch-time read (runAgentTask) — no owner check, because the caller
 *  already holds the agent row and is acting AS the platform, and a task
 *  must never fail on this read: callers wrap it and degrade to []. */
export async function skillsForPrompt(
  agentId: string,
): Promise<Array<Pick<InstalledAgentSkill, 'slug' | 'name' | 'version' | 'instructions' | 'truncated'>>> {
  await ensureAgentSkillTable()
  const { rows } = await pool.query<AgentSkillRow>(
    `SELECT * FROM agent_skill WHERE agent_id = $1 ORDER BY installed_at ASC`,
    [agentId],
  )
  return rows.map((r) => ({ slug: r.slug, name: r.name, version: r.version, instructions: r.instructions, truncated: r.truncated }))
}

/** Most recent install per agent within `sinceMs` — the office diorama's
 *  Skill Gym signal (a real install event, not an inferred activity). */
export async function recentSkillInstallByAgentIds(agentIds: string[], sinceMs: number): Promise<Map<string, string>> {
  if (agentIds.length === 0) return new Map()
  await ensureAgentSkillTable()
  const since = new Date(Date.now() - sinceMs)
  const { rows } = await pool.query<{ agent_id: string; name: string }>(
    `SELECT DISTINCT ON (agent_id) agent_id, name
       FROM agent_skill
      WHERE agent_id = ANY($1) AND installed_at >= $2
      ORDER BY agent_id, installed_at DESC`,
    [agentIds, since],
  )
  return new Map(rows.map((r) => [r.agent_id, r.name]))
}
