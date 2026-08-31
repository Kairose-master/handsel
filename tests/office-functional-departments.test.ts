import { describe, it, expect } from 'vitest'
import { departmentFor, FUNCTIONAL_DEPARTMENTS, type AgentActivitySignals } from '@/lib/office-functional-departments'

const base: AgentActivitySignals = {
  jobs: [],
  officeReviewSpecHashes: new Set(),
  roleId: null,
  mcpToolName: null,
  isDelegationPrime: false,
  hasCreditDraw: false,
  settledRecently: false,
  recentSkillInstall: null,
  harness: null,
  autoMine: false,
  isExternalRuntime: false,
}

describe('FUNCTIONAL_DEPARTMENTS', () => {
  it('has exactly nine rooms, one per id in the union, no duplicates', () => {
    expect(FUNCTIONAL_DEPARTMENTS).toHaveLength(9)
    const ids = FUNCTIONAL_DEPARTMENTS.map((d) => d.id)
    expect(new Set(ids).size).toBe(9)
  })

  it('none of them is a generic catch-all named after infrastructure', () => {
    // The defect this replaces: "Mining" as a room any unmatched agent fell
    // into. No room name here may read as a status bucket rather than a
    // function.
    const names = FUNCTIONAL_DEPARTMENTS.map((d) => d.name.toLowerCase())
    for (const banned of ['mining', 'idle', 'lounge', 'external', 'template', 'capable']) {
      expect(names.some((n) => n.includes(banned))).toBe(false)
    }
  })
})

describe('departmentFor — priority order', () => {
  it('idle by default — no signal, no room', () => {
    expect(departmentFor(base)).toEqual({ deptId: null, statusLine: 'Idle.' })
  })

  it('a disputed job wins over everything else', () => {
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Disputed', specHash: 'h1', repoJob: false }],
      isDelegationPrime: true,
      hasCreditDraw: true,
      autoMine: true,
    }
    expect(departmentFor(s).deptId).toBe('verification')
  })

  it('an office-scoped review job with a red-team role goes to QA', () => {
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Submitted', specHash: 'h1', repoJob: false }],
      officeReviewSpecHashes: new Set(['h1']),
      roleId: 'red-team',
    }
    expect(departmentFor(s).deptId).toBe('qa')
  })

  it('an office-scoped review job WITHOUT a red-team role goes to Verification Court', () => {
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Submitted', specHash: 'h1', repoJob: false }],
      officeReviewSpecHashes: new Set(['h1']),
      roleId: 'fact-checker',
    }
    expect(departmentFor(s).deptId).toBe('verification')
  })

  it('an office-scoped review job with NO role id at all defaults to Verification Court, not QA', () => {
    // Pessimistic in the safe direction: absence of a role signal must not
    // read as adversarial review.
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Accepted', specHash: 'h1', repoJob: false }],
      officeReviewSpecHashes: new Set(['h1']),
    }
    expect(departmentFor(s).deptId).toBe('verification')
  })

  it('review takes priority over a plain working job on the SAME spec', () => {
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Submitted', specHash: 'h1', repoJob: false }],
      officeReviewSpecHashes: new Set(['h1']),
      isDelegationPrime: true,
    }
    expect(departmentFor(s).deptId).not.toBe('strategy')
  })

  it('a repo job goes to Engineering regardless of role/tool hints', () => {
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Accepted', specHash: 'h1', repoJob: true }],
      mcpToolName: 'web_search_exa', // would otherwise say research
    }
    expect(departmentFor(s).deptId).toBe('engineering')
  })

  it('a non-repo working job with a research-shaped MCP tool goes to Research Lab', () => {
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Submitted', specHash: 'h1', repoJob: false }],
      mcpToolName: 'aws___search_documentation',
    }
    expect(departmentFor(s).deptId).toBe('research')
  })

  it('a non-repo working job with a research-shaped ROLE id (no tool) also goes to Research Lab', () => {
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Submitted', specHash: 'h1', repoJob: false }],
      roleId: 'aws-read',
    }
    expect(departmentFor(s).deptId).toBe('research')
  })

  it('a non-repo working job with no research signal falls to Engineering', () => {
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Accepted', specHash: 'h1', repoJob: false }],
      roleId: 'editor',
    }
    expect(departmentFor(s).deptId).toBe('engineering')
  })

  it('a working job outranks being a delegation prime', () => {
    const s: AgentActivitySignals = {
      ...base,
      jobs: [{ status: 'Accepted', specHash: 'h1', repoJob: false }],
      isDelegationPrime: true,
    }
    expect(departmentFor(s).deptId).toBe('engineering')
  })

  it('delegation prime with no live job goes to Strategy Room', () => {
    expect(departmentFor({ ...base, isDelegationPrime: true }).deptId).toBe('strategy')
  })

  it('a credit draw outranks having settled recently', () => {
    expect(departmentFor({ ...base, hasCreditDraw: true, settledRecently: true }).deptId).toBe('treasury')
  })

  it('a recent skill install, nothing else live, goes to the Skill Gym — the room is finally populated by a real event', () => {
    const a = departmentFor({ ...base, recentSkillInstall: 'PDF Toolkit' })
    expect(a.deptId).toBe('skills')
    expect(a.statusLine).toContain('PDF Toolkit')
    // The line claims the install only — evaluation doesn't exist, so no
    // "trained"/"improved"/"mastered" language may sneak in.
    expect(a.statusLine.toLowerCase()).not.toMatch(/train|improv|master|evaluat/)
  })

  it('a skill install outranks the settled-recently fallback (more specific fact about what changed)', () => {
    expect(departmentFor({ ...base, recentSkillInstall: 'X', settledRecently: true }).deptId).toBe('skills')
  })

  it('a credit draw outranks a skill install — money state beats capability news', () => {
    expect(departmentFor({ ...base, recentSkillInstall: 'X', hasCreditDraw: true }).deptId).toBe('treasury')
  })

  it('a live job outranks a skill install', () => {
    const s: AgentActivitySignals = {
      ...base,
      recentSkillInstall: 'X',
      jobs: [{ status: 'Accepted', specHash: 'h1', repoJob: false }],
    }
    expect(departmentFor(s).deptId).toBe('engineering')
  })

  it('settled recently, nothing else live, goes to Memory Archive', () => {
    const a = departmentFor({ ...base, settledRecently: true })
    expect(a.deptId).toBe('memory')
    // The room must not overclaim what happened — no "retrieved" language for
    // a write-only event.
    expect(a.statusLine.toLowerCase()).not.toMatch(/retriev/)
  })

  it('autoMine with nothing more specific goes to Market, not a mining room', () => {
    expect(departmentFor({ ...base, autoMine: true }).deptId).toBe('market')
  })

  it('an external runtime with nothing more specific also goes to Market', () => {
    expect(departmentFor({ ...base, isExternalRuntime: true }).deptId).toBe('market')
  })

  it('settling recently outranks autoMine — the more specific, more recent signal wins', () => {
    expect(departmentFor({ ...base, autoMine: true, settledRecently: true }).deptId).toBe('memory')
  })
})

describe('purity and totality', () => {
  it('never throws on an empty-but-well-typed input', () => {
    expect(() => departmentFor(base)).not.toThrow()
  })

  it('does not mutate its input', () => {
    const s: AgentActivitySignals = { ...base, jobs: [{ status: 'Accepted', specHash: 'h1', repoJob: false }] }
    const before = JSON.stringify(s)
    departmentFor(s)
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('a live harness run and the office are one thing', () => {
  const run = (over: Partial<NonNullable<AgentActivitySignals['harness']>> = {}) => ({
    harnessId: 'claude',
    phase: 'code' as const,
    live: 'running' as const,
    lastLine: 'Wrote src/routes/gateway.ts',
    ...over,
  })

  it('walks the agent across the office as the run changes phase', () => {
    // The rooms were named for what an agent is doing, and a harness
    // announces exactly that every few seconds. This is the join that makes
    // the diorama a view of execution rather than of job rows.
    const at = (phase: 'plan' | 'code' | 'test' | 'review' | 'deploy') =>
      departmentFor({ ...base, harness: run({ phase }) }).deptId
    expect(at('plan')).toBe('strategy')
    expect(at('code')).toBe('engineering')
    expect(at('test')).toBe('qa')
    expect(at('review')).toBe('verification')
    expect(at('deploy')).toBe('market')
  })

  it('says what the harness is actually doing, not what the job row says', () => {
    const working = { ...base, jobs: [{ status: 'Accepted', specHash: '0xa', repoJob: true }] }
    expect(departmentFor(working).statusLine).toMatch(/repo job/i)
    const live = departmentFor({ ...working, harness: run() }).statusLine
    expect(live).toContain('claude')
    expect(live).toContain('code')
    expect(live).toContain('gateway.ts')
  })

  it('refines a specific placement instead of overriding it', () => {
    // An agent red-teaming a peer's work through its harness reports phase
    // `code`. Letting the phase win would move it to the Engineering Floor
    // and lose the more specific fact about WHY it is running.
    const reviewing: AgentActivitySignals = {
      ...base,
      roleId: 'red-team-lead',
      jobs: [{ status: 'Submitted', specHash: '0xrev', repoJob: false }],
      officeReviewSpecHashes: new Set(['0xrev']),
    }
    expect(departmentFor(reviewing).deptId).toBe('qa')
    const withRun = departmentFor({ ...reviewing, harness: run({ phase: 'code' }) })
    expect(withRun.deptId).toBe('qa')
    // …but the status line is still the live truth.
    expect(withRun.statusLine).toContain('gateway.ts')
  })

  it('never lets a run outrank a dispute', () => {
    const disputed = { ...base, jobs: [{ status: 'Disputed', specHash: '0xd', repoJob: false }] }
    expect(departmentFor({ ...disputed, harness: run() }).deptId).toBe('verification')
  })

  it('places an idle agent by its run rather than leaving it in the lounge', () => {
    expect(departmentFor(base).deptId).toBeNull()
    expect(departmentFor({ ...base, harness: run({ phase: 'test' }) }).deptId).toBe('qa')
  })

  it('shows a silent worker as silent instead of as working', () => {
    // A worker that stopped talking mid-run is a fact worth seeing, not one
    // to hide behind its last known job status.
    const stalled = departmentFor({ ...base, harness: run({ live: 'stalled' }) })
    expect(stalled.statusLine).toMatch(/no signal/i)
    expect(stalled.statusLine).not.toContain('gateway.ts')
  })

  it('names the built-in loop rather than printing null', () => {
    expect(departmentFor({ ...base, harness: run({ harnessId: null }) }).statusLine).toContain('its worker')
  })

  it('is unchanged for every agent with no run — the whole existing cascade still decides', () => {
    for (const signals of [
      { ...base, autoMine: true },
      { ...base, hasCreditDraw: true },
      { ...base, settledRecently: true },
      { ...base, isDelegationPrime: true },
      { ...base, recentSkillInstall: 'sql' },
    ]) {
      expect(departmentFor(signals)).toEqual(departmentFor({ ...signals, harness: null }))
    }
  })
})
