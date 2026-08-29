import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'
import { STOREFRONT_COMMISSIONS, MAX_COMMISSIONS_PER_DAY } from '@/lib/storefront-pricing'
import { enabledStorefronts, commissionsToday } from '@/lib/office-storefront'
import { officeSlotsByAgentId } from '@/lib/office'
import { absoluteUrl } from '@/lib/origin'

/**
 * GET /api/storefront — the shop window, free to read.
 *
 * Lists which office templates are open for external commission RIGHT NOW,
 * what each delivers, what it costs, and how much daily capacity remains —
 * so a client checks here before paying, because the commission route sits
 * behind an x402 paywall that settles before the handler can refuse
 * (capacity reached, storefront closed). Advertising the refusal reasons up
 * front is what keeps "pay first" honest.
 *
 * Every number is live: the serving desk's agents and their credit scores
 * are read at request time, not copied into marketing copy. A desk with an
 * unimpressive record shows its unimpressive record — that is the product.
 */
export async function GET() {
  const open = await enabledStorefronts()
  const items = []
  for (const pricing of STOREFRONT_COMMISSIONS) {
    const serving = open.filter((s) => s.templateId === pricing.templateId)
    const store = serving[0] ?? null
    let desk: Array<{ name: string; creditScore: number }> = []
    if (store) {
      // The serving desk, by live query — roster names and real scores.
      const mine = await db
        .select({ id: agent.id, name: agent.name, creditScore: agent.creditScore, userId: agent.userId })
        .from(agent)
        .where(inArray(agent.userId, [store.userId]))
      const slotOf = await officeSlotsByAgentId(mine.map((a) => a.id))
      desk = mine
        .filter((a) => (slotOf.get(a.id) ?? 1) === store.slot)
        .map((a) => ({ name: a.name, creditScore: Math.round(Number(a.creditScore)) }))
    }
    const used = store ? await commissionsToday(pricing.templateId) : 0
    items.push({
      template: pricing.templateId,
      deliverable: pricing.deliverable,
      priceUsd: pricing.priceUsd,
      open: !!store,
      capacityRemainingToday: store ? Math.max(0, MAX_COMMISSIONS_PER_DAY - used) : 0,
      desk,
      commission: {
        method: 'POST',
        url: absoluteUrl(`/api/storefront/${pricing.templateId}/commission`),
        protocol: 'x402 (HTTP 402 + X-PAYMENT header, EIP-3009 USDC authorization)',
        body: { scope: 'What the office should deliver — the more specific the better.' },
      },
    })
  }
  return NextResponse.json({
    type: 'HandselOfficeStorefront',
    note:
      'Commission an entire escrowed office pipeline: dependency-ordered steps, an adversarial review gate that ' +
      'holds payment until it passes, independent grading, and an assembled deliverable you poll for by token. ' +
      'Check open/capacity here BEFORE paying — the commission route settles payment before it can refuse.',
    items,
  })
}
