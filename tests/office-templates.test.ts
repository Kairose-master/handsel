/**
 * OFFICE_TEMPLATES — pure data validation. A malformed template here would
 * corrupt a real delegation's dependsOn wiring (lib/delegation.ts's cycle
 * and unknown-dependency checks reject it, but only at hire time) or leave
 * a role with no matching pipeline step. Catch that at test time instead.
 */
import { describe, it, expect } from 'vitest'
import { OFFICE_TEMPLATES } from '@/lib/office-world-data'

describe('OFFICE_TEMPLATES', () => {
  for (const template of OFFICE_TEMPLATES) {
    describe(template.id, () => {
      it('has a non-empty flowSummary and exampleScope for the one-touch hire flow', () => {
        expect(template.flowSummary.trim().length).toBeGreaterThan(0)
        expect(template.exampleScope.trim().length).toBeGreaterThanOrEqual(2)
      })

      it('has at least one role and one pipeline step', () => {
        expect(template.roles.length).toBeGreaterThan(0)
        expect(template.pipeline.length).toBeGreaterThan(0)
      })

      it('role ids are unique', () => {
        const ids = template.roles.map((r) => r.id)
        expect(new Set(ids).size).toBe(ids.length)
      })

      it('every pipeline step references a real role id', () => {
        const roleIds = new Set(template.roles.map((r) => r.id))
        for (const step of template.pipeline) {
          expect(roleIds.has(step.roleId)).toBe(true)
        }
      })

      it('every dependsOnRoleIds entry references a real pipeline step, never itself', () => {
        const stepRoleIds = new Set(template.pipeline.map((s) => s.roleId))
        for (const step of template.pipeline) {
          for (const dep of step.dependsOnRoleIds) {
            expect(dep).not.toBe(step.roleId)
            expect(stepRoleIds.has(dep)).toBe(true)
          }
        }
      })

      it('the dependency graph is acyclic', () => {
        const byRoleId = new Map(template.pipeline.map((s) => [s.roleId, s]))
        const state = new Map<string, 0 | 1 | 2>()
        const visit = (roleId: string): void => {
          if (state.get(roleId) === 2) return
          expect(state.get(roleId)).not.toBe(1) // 1 = in-stack — a repeat visit here is a cycle
          state.set(roleId, 1)
          for (const dep of byRoleId.get(roleId)?.dependsOnRoleIds ?? []) visit(dep)
          state.set(roleId, 2)
        }
        for (const step of template.pipeline) visit(step.roleId)
      })

      it('every title/brief/acceptanceCriteria placeholder resolves, and at least one step uses the real scope', () => {
        const scope = 'AAPL, 005930.KS'
        let sawScope = false
        for (const step of template.pipeline) {
          const title = step.title.replaceAll('{scope}', scope)
          const brief = step.brief.replaceAll('{scope}', scope)
          const criteria = step.acceptanceCriteria.replaceAll('{scope}', scope)
          expect(title).not.toContain('{scope}')
          expect(brief).not.toContain('{scope}')
          expect(criteria).not.toContain('{scope}')
          if (title.includes(scope) || brief.includes(scope) || criteria.includes(scope)) sawScope = true
        }
        // A dependent step is allowed to work purely off the injected upstream
        // output instead of the original scope text (e.g. bootstrap-desk's
        // underwriter) — but the template as a whole must use the owner's
        // input somewhere, or the scope field would be pointless.
        expect(sawScope).toBe(true)
      })

      it('every splitBpsByRoleId references a real, DIFFERENT role id and sums to at most 10000', () => {
        const roleIds = new Set(template.roles.map((r) => r.id))
        for (const step of template.pipeline) {
          if (!step.splitBpsByRoleId) continue
          let total = 0
          for (const [roleId, bps] of Object.entries(step.splitBpsByRoleId)) {
            expect(roleIds.has(roleId)).toBe(true)
            expect(roleId).not.toBe(step.roleId) // a role can't take a cut of its own payout
            expect(bps).toBeGreaterThan(0)
            total += bps
          }
          expect(total).toBeLessThanOrEqual(10_000)
        }
      })

      it('every bountyWeight, when set, is a positive number', () => {
        for (const step of template.pipeline) {
          if (step.bountyWeight !== undefined) expect(step.bountyWeight).toBeGreaterThan(0)
        }
      })

      it('pipeline step titles are unique (delegation dependsOn is wired by title)', () => {
        const titles = template.pipeline.map((s) => s.title)
        expect(new Set(titles).size).toBe(titles.length)
      })

      it('roles that place real orders are framed as a draft, never an execution', () => {
        for (const role of template.roles) {
          if (/order|trade|rebalance/i.test(role.name)) {
            expect(role.customInstructions.toLowerCase()).toMatch(/draft|proposal|no authority|not.*(execute|executed)/)
          }
        }
      })
    })
  }
})

/**
 * research-desk's whole claim is the verification chain: the checker must see
 * the researcher's output, and the editor must see BOTH — the findings and the
 * rulings on them. Drop either edge and the template still hires, still runs,
 * and still produces a confident-looking answer, but the editor is now writing
 * from unchecked research with nothing to flag it. That is a silent failure,
 * so it gets an explicit guard rather than relying on the generic DAG checks.
 */
describe('research-desk verification chain', () => {
  const template = OFFICE_TEMPLATES.find((t) => t.id === 'research-desk')

  it('exists', () => {
    expect(template).toBeDefined()
  })

  it('the fact checker consumes the researcher, and the editor consumes both', () => {
    const byRoleId = new Map(template!.pipeline.map((s) => [s.roleId, s]))
    expect(byRoleId.get('fact-checker')?.dependsOnRoleIds).toContain('researcher')
    expect(byRoleId.get('editor')?.dependsOnRoleIds).toContain('researcher')
    expect(byRoleId.get('editor')?.dependsOnRoleIds).toContain('fact-checker')
  })

  it('the editor is bound to the rulings rather than free to re-assert', () => {
    const editor = template!.roles.find((r) => r.id === 'editor')!
    expect(editor.customInstructions).toMatch(/MISREAD/)
    expect(editor.customInstructions).toMatch(/UNVERIFIABLE/)
  })

  it('both searching roles are pointed at a real search tool, not left blank', () => {
    for (const roleId of ['researcher', 'fact-checker']) {
      const role = template!.roles.find((r) => r.id === roleId)!
      expect(role.mcpHint.toLowerCase()).toMatch(/search/)
    }
  })
})
