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

      it('every title/brief/acceptanceCriteria placeholder resolves with a real symbols string', () => {
        const symbols = 'AAPL, 005930.KS'
        for (const step of template.pipeline) {
          const title = step.title.replaceAll('{symbols}', symbols)
          const brief = step.brief.replaceAll('{symbols}', symbols)
          const criteria = step.acceptanceCriteria.replaceAll('{symbols}', symbols)
          expect(title).not.toContain('{symbols}')
          expect(brief).not.toContain('{symbols}')
          expect(criteria).not.toContain('{symbols}')
          expect(title).toContain(symbols)
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
