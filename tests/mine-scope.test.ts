import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  normalizeMineScope,
  defaultMineScope,
  resolveMineScope,
  scopeAllows,
  describeMineScope,
} from '@/lib/mine-scope'

describe('normalizeMineScope', () => {
  it('accepts the documented values and their obvious synonyms', () => {
    expect(normalizeMineScope('own')).toBe('own')
    expect(normalizeMineScope('Own')).toBe('own')
    expect(normalizeMineScope(' office ')).toBe('own')
    expect(normalizeMineScope('market')).toBe('market')
    expect(normalizeMineScope('open_market')).toBe('market')
  })

  it('refuses to guess, rather than defaulting to the wider mandate', () => {
    // The failure mode this guards: an unrecognised scope silently becoming
    // "market" would widen a worker to the open board by typo.
    for (const bad of ['everything', 'all', '', null, undefined, 7, {}]) {
      expect(normalizeMineScope(bad)).toBe(null)
    }
  })
})

describe('defaultMineScope', () => {
  it("keeps an office's hired specialist on its own account's work", () => {
    // The reported harm: hire_office turns auto-mine on for every pipeline
    // role, and one of those workers bid on a third party's job.
    expect(defaultMineScope({ hiredForOfficeRole: true })).toBe('own')
  })

  it('leaves a worker somebody switched on themselves on the open board', () => {
    expect(defaultMineScope({ hiredForOfficeRole: false })).toBe('market')
  })
})

describe('resolveMineScope', () => {
  it('lets an explicit choice beat the derived default in both directions', () => {
    expect(resolveMineScope({ stored: 'market', hiredForOfficeRole: true })).toBe('market')
    expect(resolveMineScope({ stored: 'own', hiredForOfficeRole: false })).toBe('own')
  })

  it('falls back to the derived default when nothing was chosen', () => {
    expect(resolveMineScope({ stored: null, hiredForOfficeRole: true })).toBe('own')
    expect(resolveMineScope({ stored: null, hiredForOfficeRole: false })).toBe('market')
  })
})

describe('scopeAllows', () => {
  it('lets an own-scope worker take only its own account\'s work', () => {
    expect(scopeAllows('own', true)).toBe(true)
    expect(scopeAllows('own', false)).toBe(false)
  })

  it('leaves market scope exactly as permissive as before scope existed', () => {
    expect(scopeAllows('market', true)).toBe(true)
    expect(scopeAllows('market', false)).toBe(true)
  })
})

describe('describeMineScope', () => {
  it('names the scope and says how to change it when it was not chosen', () => {
    const derived = describeMineScope('own', false)
    expect(derived).toContain('scope: own')
    expect(derived).toContain('market') // tells the operator how to widen it
    const chosen = describeMineScope('own', true)
    expect(chosen).toContain('scope: own')
    // No "pass scope:… to change it" nag once the owner has already decided.
    expect(chosen).not.toContain('default for')
  })

  it('says market scope stakes a bond on strangers\' jobs', () => {
    expect(describeMineScope('market', true)).toMatch(/bond/)
  })
})

describe('the scheduler actually applies the scope', () => {
  it('gates isEligibleBlock on scopeAllows', () => {
    // A pure rule nothing calls is not a rule. Pin the call site, not the
    // import — an import survives deleting the gate.
    const body = readFileSync('lib/mining-scheduler.ts', 'utf8')
    expect(body).toMatch(/if \(!scopeAllows\(input\.scope[^)]*\)[^)]*\)\) return false/)
  })

  it('auto-mine resolves a scope and passes an own-account predicate', () => {
    const body = readFileSync('lib/auto-mine.ts', 'utf8')
    expect(body).toContain('effectiveMineScope(agent.id)')
    expect(body).toMatch(/\bscope,/)
    expect(body).toMatch(/isOwnAccountJob:/)
  })
})
