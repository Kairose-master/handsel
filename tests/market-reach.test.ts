import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MIN_SCORE, marketReach, type ReachWorker } from '@/lib/market-reach'

/**
 * The self-inflicted half of the cold start.
 *
 * A job nobody is permitted to claim does not fail — it sits Open until its
 * deadline, and the board reads "posted, ignored" when the truth is "posted,
 * unreachable". Those call for opposite responses: raise the price, or unlock
 * the door. We shipped the second and read it as the first.
 */

const w = (creditScore: number, capabilities: string[] = ['text']): ReachWorker => ({
  agentId: `a${creditScore}-${capabilities.join('')}`,
  creditScore,
  capabilities,
})

describe('the three states of "can anybody take this"', () => {
  it('ok — somebody can', () => {
    const r = marketReach([w(0), w(700)], { minScore: 600, kind: 'text' })
    expect(r.verdict).toBe('ok')
    expect(r.reachable).toBe(1)
    expect(r.gatedOut).toBe(1)
  })

  /**
   * The one that was live. Workers exist, can do the work, and the score field
   * excludes all of them — fixable in one field, and invisible until named.
   */
  it('gated — they can do the work and the score field locks them out', () => {
    const r = marketReach([w(0), w(120), w(300)], { minScore: 600, kind: 'text' })
    expect(r.verdict).toBe('gated')
    expect(r.reachable).toBe(0)
    expect(r.gatedOut).toBe(3)
    expect(r.reason).toMatch(/Lower it and the job becomes claimable/)
  })

  it('empty — nobody has the capability, and lowering the gate will not help', () => {
    const r = marketReach([w(900, ['text'])], { minScore: 0, kind: 'image' })
    expect(r.verdict).toBe('empty')
    expect(r.incapable).toBe(1)
    expect(r.reason).toMatch(/will not help/)
  })

  it('never confuses the two — they have opposite fixes', () => {
    // Collapsing "gated" and "empty" into "no takers" is what let the 600
    // default run for weeks.
    const gated = marketReach([w(10)], { minScore: 600, kind: 'text' })
    const empty = marketReach([w(900, ['audio'])], { minScore: 0, kind: 'text' })
    expect(gated.verdict).not.toBe(empty.verdict)
  })

  it('an empty market is empty, not gated', () => {
    const r = marketReach([], { minScore: 0, kind: 'text' })
    expect(r.verdict).toBe('empty')
    expect(r.gatedOut).toBe(0)
  })
})

describe('it models the same gate the claim path enforces', () => {
  it('honours required capabilities, not just the kind', () => {
    // A reach estimate that disagrees with the dispatcher it models is worse
    // than none — it would promise claimability the claim path then refuses.
    const capable = marketReach([w(500, ['text', 'web'])], {
      minScore: 0,
      kind: 'text',
      requiredCapabilities: ['web'],
    })
    const not = marketReach([w(500, ['text'])], { minScore: 0, kind: 'text', requiredCapabilities: ['web'] })
    expect(capable.verdict).toBe('ok')
    expect(not.verdict).toBe('empty')
  })

  it('a worker exactly at the minimum is in, not out', () => {
    expect(marketReach([w(600)], { minScore: 600, kind: 'text' }).verdict).toBe('ok')
  })
})

describe('the default that was excluding everyone', () => {
  it('is zero', () => {
    expect(DEFAULT_MIN_SCORE).toBe(0)
  })

  it('admits a brand-new agent, which starts at 0', () => {
    const r = marketReach([w(0)], { minScore: DEFAULT_MIN_SCORE, kind: 'text' })
    expect(r.verdict).toBe('ok')
  })

  it('is actually used by every posting path', () => {
    // The point of the fix is that no posting surface carries its own number.
    // A default corrected in one place and left in three is not corrected.
    const form = readFileSync(join(process.cwd(), 'app/(dashboard)/jobs/page.tsx'), 'utf8')
    expect(form).toMatch(/useState\('0'\)[\s\S]{0,40}$|const \[minScore, setMinScore\] = useState\('0'\)/m)
    expect(form).not.toMatch(/useState\('600'\)/)

    const external = readFileSync(join(process.cwd(), 'app/api/jobs/external/route.ts'), 'utf8')
    expect(external).toMatch(/import \{ DEFAULT_MIN_SCORE \} from '@\/lib\/market-reach'/)

    // seed-jobs.ts exists specifically so "a freshly connected worker always
    // finds real work within seconds" — and posted at 200, above the 0 every
    // freshly connected worker has. A cold-start remedy gated above the cold
    // start it was written for.
    const seed = readFileSync(join(process.cwd(), 'app/actions/seed-jobs.ts'), 'utf8')
    expect(seed).not.toMatch(/minScore: 200/)
    expect(seed).toMatch(/minScore: 0/)
  })
})
