/**
 * Functional department taxonomy for the Office diorama.
 *
 * Replaces the STATUS taxonomy in lib/office-world-data.ts's old
 * `OfficeDeptId` (disputed/reviewing/working/delegating/credit/settled/
 * governance/mining/external/template/erc8004/capable) — twelve buckets that
 * described an agent's CONDITION, not what it was doing. "Mining" read as a
 * generic catch-all room because it effectively was one: any autoMine agent
 * not otherwise busy landed there regardless of what its actual work looked
 * like. Space communicated status, not function.
 *
 * These nine rooms are the functional read of the SAME underlying signals —
 * what real capability the agent is currently exercising: research,
 * synthesis/coordination, building, adversarial review, independent
 * verification, ledger writes, skill installs, treasury, or the market
 * boundary. One (`memory`) is an honest best-effort substitute rather than
 * the thing the original design doc names, called out where derived; the
 * Skill Gym, which shipped as "reserved, not populated" for the same
 * reason, is now driven by a REAL event — lib/agent-skills.ts's owner
 * installs, which change what the agent is told on every job (skill
 * evaluation is lib/skill-eval.ts's correlation-only window comparison,
 * shown in the roster panel; no rule HERE reads it). Nothing
 * here invents an activity: every rule reads a real row (a live job, a
 * delegation, an agentEvent, a skill install, a role id, an MCP tool
 * binding). An agent that matches nothing has no department, by design —
 * see docFor(null): permanent identity and current activity are different
 * dimensions, and idle is not a room.
 */

export type FunctionalDeptId =
  | 'research'
  | 'strategy'
  | 'engineering'
  | 'qa'
  | 'verification'
  | 'memory'
  | 'skills'
  | 'treasury'
  | 'market'

export const FUNCTIONAL_DEPARTMENTS: Array<{
  id: FunctionalDeptId
  name: string
  short: string
  icon: string
  blurb: string
}> = [
  { id: 'research', name: 'Research Lab', short: 'research.lab', icon: '🔎', blurb: 'Searching the web or a vendor doc set for a live job.' },
  { id: 'strategy', name: 'Strategy Room', short: 'strategy.hq', icon: '🧭', blurb: 'Prime on an active delegation — decomposing, routing, coordinating subtasks.' },
  { id: 'engineering', name: 'Engineering Floor', short: 'eng.floor', icon: '🛠️', blurb: 'Building — Accepted or Submitted on a real escrowed job.' },
  { id: 'qa', name: 'QA / Red Team', short: 'qa.redteam', icon: '🧨', blurb: 'An adversarial peer review — attacking a deliverable before it settles.' },
  { id: 'verification', name: 'Verification Court', short: 'verify.court', icon: '⚖️', blurb: 'An independent peer review, or a job under dispute — evidence and verdict, not production.' },
  { id: 'memory', name: 'Memory Archive', short: 'memory.log', icon: '🗄️', blurb: 'Just settled a job — writing the outcome into the credit ledger.' },
  { id: 'skills', name: 'Skill Gym', short: 'skill.gym', icon: '🏋️', blurb: 'Just had a new ClawHub skill installed — a real change to what it is told on every job.' },
  { id: 'treasury', name: 'Treasury', short: 'treasury.vault', icon: '💰', blurb: 'Has an open credit draw against its score.' },
  { id: 'market', name: 'Market', short: 'market.gate', icon: '🌐', blurb: 'Watching the open board, or running outside the platform — the boundary with the outside economy.' },
]

const RED_TEAM_ROLE_RE = /red.?team|adversarial|attack/i
const RESEARCH_SIGNAL_RE = /search|docs|research|read|discover/i

/**
 * The real signals this derivation reads — gathered by
 * lib/office-world-server.ts, kept here as a plain type so the derivation
 * itself stays pure and testable without a database.
 */
export type AgentActivitySignals = {
  /** This agent's own on-chain jobs where it is the WORKER, right now. */
  jobs: ReadonlyArray<{ status: string; specHash: string; repoJob: boolean }>
  /** specHashes (subset of `jobs`) that are office-scoped peer-review jobs. */
  officeReviewSpecHashes: ReadonlySet<string>
  /** agent_office_slot.role_id for this agent in this office, if any. */
  roleId: string | null
  /** agent.mcpToolName — which external tool this agent is wired to. */
  mcpToolName: string | null
  /** True iff this agent is the prime on a currently `posted` delegation. */
  isDelegationPrime: boolean
  /** True iff this agent has ever drawn against its own credit line. */
  hasCreditDraw: boolean
  /** True iff this agent has an agentEvent row in the last 24h. */
  settledRecently: boolean
  /** Name of a skill installed on this agent in the last 24h (lib/agent-
   *  skills.ts — a real owner action that changes what the agent is told on
   *  every subsequent job), or null. The signal that finally populates the
   *  Skill Gym, which docs/office-departments.md carried as "reserved, not
   *  populated" until installs became real. */
  recentSkillInstall: string | null
  /** agent.autoMine */
  autoMine: boolean
  /** agent.runtimeType !== 'platform' */
  isExternalRuntime: boolean
}

export type DepartmentAssignment = { deptId: FunctionalDeptId | null; statusLine: string }

/**
 * One agent's current functional department. Priority-ordered: the most
 * specific, most urgent live signal wins, exactly like the status cascade
 * this replaces — an agent under dispute is never shown as merely "working."
 *
 * Pure and total: never throws, and unmatched signals fall through to
 * `{ deptId: null, ... }` (idle — no room) rather than a guessed default.
 */
export function departmentFor(s: AgentActivitySignals): DepartmentAssignment {
  const disputed = s.jobs.find((j) => j.status === 'Disputed')
  if (disputed) {
    return { deptId: 'verification', statusLine: 'A job is in dispute — under adjudication.' }
  }

  const reviewing = s.jobs.find(
    (j) => (j.status === 'Accepted' || j.status === 'Submitted') && s.officeReviewSpecHashes.has(j.specHash),
  )
  if (reviewing) {
    return RED_TEAM_ROLE_RE.test(s.roleId ?? '')
      ? { deptId: 'qa', statusLine: "Red-teaming a peer's work." }
      : { deptId: 'verification', statusLine: "Reviewing a peer's work." }
  }

  const working = s.jobs.find((j) => j.status === 'Accepted' || j.status === 'Submitted')
  if (working) {
    if (working.repoJob) return { deptId: 'engineering', statusLine: `On a repo job — ${working.status.toLowerCase()}.` }
    if (RESEARCH_SIGNAL_RE.test(s.roleId ?? '') || RESEARCH_SIGNAL_RE.test(s.mcpToolName ?? '')) {
      return { deptId: 'research', statusLine: `Researching via ${s.mcpToolName ?? 'the web'} — ${working.status.toLowerCase()}.` }
    }
    return { deptId: 'engineering', statusLine: `On a job — ${working.status.toLowerCase()}.` }
  }

  if (s.isDelegationPrime) {
    return { deptId: 'strategy', statusLine: 'Coordinating a delegation.' }
  }

  if (s.hasCreditDraw) {
    return { deptId: 'treasury', statusLine: 'Has drawn credit.' }
  }

  // A real install event, not inferred activity: the owner installed a
  // skill document that now joins this agent's every job brief
  // (lib/agent-skills.ts → lib/agent-tasks.ts). Placed above the
  // settled-recently fallback because acquiring a capability is the more
  // specific fact about what just changed for this agent; both fade after
  // 24h. The line claims the install, nothing more — evaluation numbers
  // (lib/skill-eval.ts) live in the roster panel, where their sample sizes
  // and correlation-only caveat fit; a status bubble can't carry those.
  if (s.recentSkillInstall) {
    return { deptId: 'skills', statusLine: `Installed the "${s.recentSkillInstall}" skill.` }
  }

  // A best-effort substitute — no real memory-retrieval subsystem exists yet.
  // Writing an agentEvent row IS a real write to the credit-scoring ledger,
  // which is the closest true analog to "memory" this platform has: the
  // agent's own decision history, consulted by every future credit
  // recalculation. It is not retrieval, and the room says so.
  if (s.settledRecently) {
    return { deptId: 'memory', statusLine: 'Settled recently — wrote to the credit ledger.' }
  }

  if (s.autoMine) {
    return { deptId: 'market', statusLine: 'Watching the board for open jobs.' }
  }
  if (s.isExternalRuntime) {
    return { deptId: 'market', statusLine: 'Runs outside the platform — bridges to the outside economy.' }
  }

  return { deptId: null, statusLine: 'Idle.' }
}
