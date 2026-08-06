import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { feedMeta } from '@/lib/feed-meta'

/**
 * §27. The audit reported this endpoint as consistent and quoted a `meta` block
 * that did not exist. The fabrication propagated into four documents, a public
 * GitHub comment, and the safety contract of a skill package — because the
 * report was verified where it alleged defects and trusted where it alleged
 * correctness.
 *
 * These tests exist so the shape can never again be something we believe rather
 * than something we run.
 */

describe('the feed states which money it is talking about', () => {
  const meta = feedMeta()

  it('emits every field integrations were told about', () => {
    // The names were published before the implementation existed. Changing them
    // now would break readers who took the published contract at its word.
    for (const field of [
      'environment',
      'chainId',
      'chainName',
      'realMoney',
      'currency',
      'currencyLabel',
      'contractAddress',
      'explorerUrl',
      'warning',
    ]) {
      expect(meta, field).toHaveProperty(field)
    }
  })

  it('agrees with itself about the environment', () => {
    // Two fields saying the same thing is a place they can disagree. If they
    // ever do, a reader checking one gets the opposite answer from a reader
    // checking the other, and both are quoting us.
    expect(meta.environment).toBe(meta.realMoney ? 'mainnet' : 'testnet')
  })

  it('never abbreviates test tokens to a bare ticker', () => {
    // "USDC" on a testnet is the §26 defect in a different field: a string that
    // reads as real money on a deployment where it is not.
    if (!meta.realMoney) {
      expect(meta.currency).toMatch(/test/i)
      expect(meta.currencyLabel).toMatch(/no monetary value/i)
    } else {
      expect(meta.currencyLabel).toMatch(/real/i)
    }
  })

  it('carries a warning in both cases', () => {
    // A warning that appears only on mainnet teaches a reader that its absence
    // means safety — and absence is also what a bug looks like.
    expect(meta.warning.length).toBeGreaterThan(20)
  })

  it('is derived from the chain, never asserted', () => {
    const src = readFileSync(join(process.cwd(), 'lib/feed-meta.ts'), 'utf8')
    // No literal naming a deployment. The whole §26 lesson in one assertion.
    expect(src).not.toMatch(/handsel-(main|nu)\.vercel\.app/)
    expect(src).toMatch(/isRealMoney\(\)/)
    expect(src).toMatch(/CHAIN\.id/)
  })
})

describe('the feed route actually returns it', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/tasks/route.ts'), 'utf8')

  it('on the success path', () => {
    expect(src).toMatch(/count: tasks\.length,[\s\S]{0,400}meta: feedMeta\(\)/)
  })

  it('and on the 503 path, where knowing the chain still matters', () => {
    // A reader that cannot get the jobs can still need to know whether this is
    // the deployment holding real money. Two call sites, not one.
    expect((src.match(/meta: feedMeta\(\)/g) ?? []).length).toBe(2)
  })
})

describe('what the docs and the skill promise about it', () => {
  it('the skill tells agents to read the field this now emits', () => {
    // The skill package shipped this instruction before the field existed. It
    // is only true because of this module, so the two are pinned together.
    const skill = readFileSync(join(process.cwd(), 'skill/handsel/skills/handsel/SKILL.md'), 'utf8')
    for (const field of ['meta.environment', 'meta.chainId', 'meta.realMoney', 'meta.currencyLabel']) {
      expect(skill, field).toContain(field)
    }
  })

  it('every meta field the skill names is one the feed emits', () => {
    // The direction that actually failed: documentation naming fields nobody
    // implemented. An agent told to branch on a key that is never present
    // silently takes the wrong branch.
    const skill = readFileSync(join(process.cwd(), 'skill/handsel/skills/handsel/SKILL.md'), 'utf8')
    const named = [...new Set([...skill.matchAll(/\bmeta\.(\w+)/g)].map((m) => m[1]))]
    expect(named.length).toBeGreaterThan(2)
    const emitted = Object.keys(feedMeta())
    expect(named.filter((f) => !emitted.includes(f))).toEqual([])
  })
})
