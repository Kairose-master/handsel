import { describe, it, expect } from 'vitest'
import { OFFICE_TEMPLATES, officeStepBounties, type OfficeTemplate } from '@/lib/office-world-data'

/**
 * Invariants every office template has to hold, checked for all of them at
 * once. The hire action (app/actions/office.ts) resolves dependencies,
 * reviews and settlement splits through roleId→title and roleId→agentId maps
 * and then trusts them with `!`, so a template that breaks one of these does
 * not fail loudly at hire time — it posts a subtask pointing at `undefined`.
 */
const each = (fn: (t: OfficeTemplate) => void) => {
  for (const t of OFFICE_TEMPLATES) fn(t)
}

describe('office template shape', () => {
  it('has unique template ids', () => {
    const ids = OFFICE_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares every role its pipeline works', () => {
    each((t) => {
      const roleIds = new Set(t.roles.map((r) => r.id))
      for (const step of t.pipeline) expect(roleIds.has(step.roleId), `${t.id}/${step.roleId}`).toBe(true)
    })
  })

  it('uses each role at most once in a pipeline', () => {
    // roleId is the key of titleByRoleId / agentIdByRoleId / the bounty map,
    // so a role appearing twice would silently lose one of its steps.
    each((t) => {
      const used = t.pipeline.map((s) => s.roleId)
      expect(new Set(used).size, t.id).toBe(used.length)
    })
  })

  it('gives every step a distinct title', () => {
    // dependsOn and reviewOf are matched BY TITLE in lib/delegation.ts — two
    // steps sharing one would make a dependency ambiguous.
    each((t) => {
      const titles = t.pipeline.map((s) => s.title)
      expect(new Set(titles).size, t.id).toBe(titles.length)
    })
  })

  it('only depends on roles that are actually pipeline steps', () => {
    each((t) => {
      const stepRoles = new Set(t.pipeline.map((s) => s.roleId))
      for (const step of t.pipeline) {
        for (const dep of step.dependsOnRoleIds) {
          expect(stepRoles.has(dep), `${t.id}: ${step.roleId} depends on ${dep}`).toBe(true)
        }
        expect(step.dependsOnRoleIds).not.toContain(step.roleId)
      }
    })
  })

  it('has an acyclic dependency graph', () => {
    each((t) => {
      const deps = new Map(t.pipeline.map((s) => [s.roleId, [...s.dependsOnRoleIds, ...(s.reviewOfRoleId ? [s.reviewOfRoleId] : [])]]))
      const state = new Map<string, 'open' | 'done'>()
      const walk = (id: string): void => {
        if (state.get(id) === 'done') return
        expect(state.get(id), `${t.id}: cycle at ${id}`).not.toBe('open')
        state.set(id, 'open')
        for (const d of deps.get(id) ?? []) walk(d)
        state.set(id, 'done')
      }
      for (const id of deps.keys()) walk(id)
    })
  })

  it('reviews a real step, and never itself', () => {
    each((t) => {
      const stepRoles = new Set(t.pipeline.map((s) => s.roleId))
      for (const step of t.pipeline) {
        if (!step.reviewOfRoleId) continue
        expect(stepRoles.has(step.reviewOfRoleId), `${t.id}: reviews ${step.reviewOfRoleId}`).toBe(true)
        expect(step.reviewOfRoleId).not.toBe(step.roleId)
      }
    })
  })

  it('splits settlement only to declared roles, never over 100%', () => {
    each((t) => {
      const roleIds = new Set(t.roles.map((r) => r.id))
      for (const step of t.pipeline) {
        if (!step.splitBpsByRoleId) continue
        let total = 0
        for (const [rid, bps] of Object.entries(step.splitBpsByRoleId)) {
          expect(roleIds.has(rid), `${t.id}: split to ${rid}`).toBe(true)
          expect(rid).not.toBe(step.roleId)
          expect(bps).toBeGreaterThan(0)
          total += bps
        }
        expect(total, `${t.id}/${step.roleId} split total`).toBeLessThanOrEqual(10_000)
      }
    })
  })

  it('gives every role and step the text the UI and the workers read', () => {
    each((t) => {
      expect(t.name.trim().length, t.id).toBeGreaterThan(0)
      expect(t.flowSummary.trim().length, t.id).toBeGreaterThan(0)
      expect(t.exampleScope.trim().length, t.id).toBeGreaterThan(0)
      for (const r of t.roles) {
        expect(r.customInstructions.trim().length, `${t.id}/${r.id}`).toBeGreaterThan(40)
        expect(r.mcpHint.trim().length, `${t.id}/${r.id}`).toBeGreaterThan(0)
      }
      for (const s of t.pipeline) {
        // Measured AFTER substitution, because a brief is allowed to be
        // nothing but {scope} — the Talent Agency deliberately hands the
        // owner's own text straight to the worker. What matters is that what
        // the worker ends up reading is a real brief.
        expect(s.brief.replaceAll('{scope}', t.exampleScope).trim().length, `${t.id}/${s.roleId}`).toBeGreaterThan(40)
        expect(s.acceptanceCriteria.trim().length, `${t.id}/${s.roleId}`).toBeGreaterThan(20)
      }
    })
  })

  it('substitutes {scope} into every title that uses it, leaving no placeholder', () => {
    each((t) => {
      for (const s of t.pipeline) {
        const filled = s.title.replaceAll('{scope}', t.exampleScope)
        expect(filled).not.toContain('{scope}')
        expect(s.brief.replaceAll('{scope}', t.exampleScope)).not.toContain('{scope}')
        expect(s.acceptanceCriteria.replaceAll('{scope}', t.exampleScope)).not.toContain('{scope}')
      }
    })
  })

  it('prices every step at its default budget', () => {
    each((t) => {
      const bounties = officeStepBounties(t, t.pipeline.length * 2)
      for (const s of t.pipeline) expect(bounties.get(s.roleId), `${t.id}/${s.roleId}`).toBeGreaterThan(0)
    })
  })
})

describe('the Due Diligence Desk', () => {
  const t = OFFICE_TEMPLATES.find((x) => x.id === 'due-diligence-desk')!

  it('exists', () => {
    expect(t).toBeDefined()
  })

  it('has three independent reads that wait on nothing', () => {
    const roots = t.pipeline.filter((s) => s.dependsOnRoleIds.length === 0 && !s.reviewOfRoleId)
    expect(roots.map((s) => s.roleId).sort()).toEqual(['commercial', 'financial', 'legal'])
  })

  it('has the partner read all three before writing', () => {
    const partner = t.pipeline.find((s) => s.roleId === 'partner')!
    expect(partner.dependsOnRoleIds.sort()).toEqual(['commercial', 'financial', 'legal'])
  })

  it('gates the memo behind a red team that can send it back', () => {
    const red = t.pipeline.find((s) => s.roleId === 'red-team')!
    expect(red.reviewOfRoleId).toBe('partner')
  })

  it('pays the memo more than a single read, since it is the composed work', () => {
    const bounties = officeStepBounties(t, 60)
    expect(bounties.get('partner')!).toBeGreaterThan(bounties.get('commercial')!)
  })
})
