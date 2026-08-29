/**
 * The storefront price list (lib/storefront-pricing.ts) is a copy — it must
 * stay edge-safe for middleware.ts, so it cannot import the templates it
 * prices. This file is the pin that makes the copy safe, the same pattern
 * that ties MAX_GENOME_SKILLS to the skills installer.
 *
 * The economic invariants matter more than the shape ones: a commission
 * priced below its own pipeline budget is a subsidy wearing a price tag,
 * and a budget below the template's own minimum is a hire_office call that
 * refuses at the moment a stranger has already paid.
 */
import { describe, expect, it } from 'vitest'
import { STOREFRONT_COMMISSIONS } from '@/lib/storefront-pricing'
import { OFFICE_TEMPLATES } from '@/lib/office-world-data'

describe('storefront pricing', () => {
  it('sells only templates that actually exist', () => {
    const known = new Set(OFFICE_TEMPLATES.map((t) => t.id))
    for (const c of STOREFRONT_COMMISSIONS) {
      expect(known.has(c.templateId), c.templateId).toBe(true)
    }
  })

  it('never sells a desk below its own pipeline cost', () => {
    for (const c of STOREFRONT_COMMISSIONS) {
      expect(c.priceUsd, c.templateId).toBeGreaterThan(c.budgetUsd)
    }
  })

  it('budgets at least the template minimum, so a paid commission cannot be refused by hire_office', () => {
    // hire_office enforces >= $1 per pipeline step (MIN_SUBTASK_BOUNTY_USD);
    // the exact constant is asserted via the template's own step count.
    for (const c of STOREFRONT_COMMISSIONS) {
      const template = OFFICE_TEMPLATES.find((t) => t.id === c.templateId)!
      expect(c.budgetUsd, c.templateId).toBeGreaterThanOrEqual(template.pipeline.length * 1)
    }
  })

  it('lists no template twice', () => {
    const ids = STOREFRONT_COMMISSIONS.map((c) => c.templateId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('describes every deliverable concretely', () => {
    for (const c of STOREFRONT_COMMISSIONS) {
      expect(c.deliverable.length, c.templateId).toBeGreaterThan(40)
    }
  })
})
