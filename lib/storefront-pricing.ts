/**
 * Storefront pricing — what a stranger pays to commission a whole office.
 *
 * This module is imported by middleware.ts (edge runtime), so it must stay
 * tiny and dependency-free: no db, no chain, no office-world-data (which is
 * thousands of lines of template prose). The price list is duplicated here
 * from the templates ON PURPOSE, and tests/storefront-pricing.test.ts pins
 * every entry against OFFICE_TEMPLATES so the copy cannot drift — the same
 * copy-plus-pin pattern MAX_GENOME_SKILLS uses for the same reason.
 *
 * The economics, stated plainly because they are the product:
 *
 *   priceUsd  — what the external client pays over x402, once, up front.
 *   budgetUsd — what the serving office's pipeline escrows across its steps
 *               (bounties its own worker agents earn back by passing
 *               independent grading).
 *
 * The margin between them is the operator's, and it exists because what is
 * being sold is not the labor — labor is a commodity anyone with an API key
 * has — but the STRUCTURE around it: escrowed steps, an adversarial review
 * gate that holds money until it passes, independent grading, and a signed
 * work proof per deliverable. `priceUsd > budgetUsd` is asserted by test:
 * a storefront that sells below its own pipeline cost is a subsidy wearing
 * a price tag.
 */

export type StorefrontCommission = {
  templateId: string
  /** What the client pays, as the x402 middleware price string wants it. */
  priceUsd: number
  /** What the pipeline escrows. Must satisfy the template's own minimum
   *  (>= $1 per pipeline step — hire_office refuses less). */
  budgetUsd: number
  /** One line of what the buyer actually receives. */
  deliverable: string
}

/**
 * The templates open for external commission. A curated subset, not all of
 * them: a storefront row is a promise that a real desk exists and will
 * serve, so only templates whose pipelines have been run live belong here.
 */
export const STOREFRONT_COMMISSIONS: readonly StorefrontCommission[] = [
  {
    templateId: 'venture-lab',
    priceUsd: 6,
    budgetUsd: 4,
    deliverable:
      'Business ventures that survived an adversarial kill screen: sourced demand evidence, candidate ventures each traceable to a real complaint, and a priced business case for the survivors.',
  },
  {
    templateId: 'growth-studio',
    priceUsd: 12,
    budgetUsd: 8,
    deliverable:
      'Launch copy whose every factual claim survived an independent fact check, plus a per-channel launch kit — hype dies in escrow, not in a style guide.',
  },
  {
    templateId: 'research-desk',
    priceUsd: 9,
    budgetUsd: 6,
    deliverable:
      'A researched answer where every source was re-opened by an independent fact checker and only verified findings survive into the final document.',
  },
]

export function commissionPricing(templateId: string): StorefrontCommission | null {
  return STOREFRONT_COMMISSIONS.find((c) => c.templateId === templateId) ?? null
}

/** Commissions one storefront will take in a UTC day. Protects the serving
 *  prime's float, not the client's money — the client pays full freight;
 *  what is bounded is how much escrow the desk can be asked to front at
 *  once before earlier commissions settle back. */
export const MAX_COMMISSIONS_PER_DAY = 5
