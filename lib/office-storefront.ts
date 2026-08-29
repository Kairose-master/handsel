/**
 * The office storefront — a whole desk, for sale to strangers.
 *
 * /api/jobs/external made single jobs purchasable from outside: pay the x402
 * fee, the house agent escrows a bounty on your behalf, no account. This
 * module is that door widened to an OFFICE — an external client pays once
 * and a standing desk (Venture Lab, Growth Studio, Research Desk) runs its
 * entire escrowed pipeline on the client's scope: dependency waves, the
 * adversarial review gate holding money until it passes, independent
 * grading, settlement splits, and an assembled final deliverable the client
 * polls for with an unguessable token.
 *
 * Why this is the external-revenue unit rather than a bare agent endpoint:
 * labor is a commodity — anyone who can pay an agent can run one. What a
 * stranger cannot cheaply replicate is the STRUCTURE: escrow that only
 * releases on a passing grade, a reviewer whose approval gates the money,
 * work proofs. The storefront sells that structure with the labor inside it.
 *
 * Money flow, stated because it is the point: the client's x402 payment
 * lands at X402_PAY_TO (the operator's receiving address). The serving
 * office's prime then escrows the pipeline budget from its own balance, and
 * the desk's workers earn it back by passing grading. Every cent of the
 * price is external inflow; the margin over the pipeline budget stays with
 * the operator. This also closes the loop the lineage system was waiting
 * for: graded outcomes on commissioned work are fitness evidence paid for
 * by a NON-owner — the market's judgment, not the owner's allowance.
 *
 * Bounds, same house style as every mandate: opt-in per office
 * (openStorefront is an owner action), a per-day commission cap protecting
 * the prime's float, scope length limits, and full payer attribution into
 * the same x402 ledger everything else uses.
 */
import { pool as pgPool, db } from '@/lib/db'
import { agent, delegation } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { commissionPricing, MAX_COMMISSIONS_PER_DAY } from '@/lib/storefront-pricing'

let tableReady: Promise<void> | null = null
function ensureTables(): Promise<void> {
  tableReady ??= (async () => {
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS office_storefront (
         user_id text NOT NULL,
         slot integer NOT NULL,
         template_id text NOT NULL,
         prime_agent_id text NOT NULL,
         enabled boolean NOT NULL DEFAULT true,
         opened_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, slot, template_id)
       )`,
    )
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS storefront_commission (
         id text PRIMARY KEY,
         template_id text NOT NULL,
         user_id text NOT NULL,
         slot integer NOT NULL,
         payer text,
         price_usd numeric NOT NULL,
         scope text NOT NULL,
         delegation_id text,
         note text,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pgPool.query(
      `CREATE INDEX IF NOT EXISTS storefront_commission_day
         ON storefront_commission (template_id, created_at)`,
    )
  })()
  return tableReady
}

/** Open one of this account's offices for external commissions of a
 *  template. The template must be on the curated commission list, and the
 *  prime must be the owner's — it is the wallet that fronts every
 *  commissioned pipeline. */
export async function openStorefront(
  userId: string,
  slot: number,
  templateId: string,
  primeAgentId: string,
): Promise<{ ok: true } | { error: string }> {
  if (!commissionPricing(templateId)) {
    return { error: `Template "${templateId}" is not open for external commission.` }
  }
  const [prime] = await db.select({ id: agent.id, userId: agent.userId, addr: agent.smartAccountAddress }).from(agent).where(eq(agent.id, primeAgentId))
  if (!prime || prime.userId !== userId) return { error: 'Prime agent not found' }
  if (!prime.addr) return { error: 'Provision the prime agent first — it fronts every commissioned pipeline.' }
  await ensureTables()
  await pgPool.query(
    `INSERT INTO office_storefront (user_id, slot, template_id, prime_agent_id, enabled)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (user_id, slot, template_id) DO UPDATE SET prime_agent_id = $4, enabled = true`,
    [userId, slot, templateId, primeAgentId],
  )
  return { ok: true }
}

export async function closeStorefront(userId: string, slot: number, templateId: string): Promise<void> {
  await ensureTables()
  await pgPool.query(
    `UPDATE office_storefront SET enabled = false WHERE user_id = $1 AND slot = $2 AND template_id = $3`,
    [userId, slot, templateId],
  )
}

export type StorefrontRow = {
  userId: string
  slot: number
  templateId: string
  primeAgentId: string
  openedAt: string
}

/** Enabled storefronts, oldest first — commissioning picks the
 *  longest-standing desk for a template, so seniority is earned by staying
 *  open, not by racing to re-enable. */
export async function enabledStorefronts(templateId?: string): Promise<StorefrontRow[]> {
  await ensureTables()
  const { rows } = await pgPool.query<{
    user_id: string
    slot: number
    template_id: string
    prime_agent_id: string
    opened_at: Date
  }>(
    templateId
      ? `SELECT * FROM office_storefront WHERE enabled AND template_id = $1 ORDER BY opened_at ASC`
      : `SELECT * FROM office_storefront WHERE enabled ORDER BY opened_at ASC`,
    templateId ? [templateId] : [],
  )
  return rows.map((r) => ({
    userId: r.user_id,
    slot: r.slot,
    templateId: r.template_id,
    primeAgentId: r.prime_agent_id,
    openedAt: r.opened_at.toISOString(),
  }))
}

export async function commissionsToday(templateId: string): Promise<number> {
  await ensureTables()
  const { rows } = await pgPool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM storefront_commission
      WHERE template_id = $1 AND created_at > date_trunc('day', now())`,
    [templateId],
  )
  return Number(rows[0]?.n ?? 0) || 0
}

export type CommissionResult =
  | { ok: true; token: string; delegationId: string }
  | { ok: false; error: string; token?: string }

/**
 * Run one paid commission: pick the serving storefront, draft the office
 * pipeline on the client's scope, escrow it from the storefront's prime,
 * and hand back the unguessable token that is the client's only key.
 *
 * The commission row is written BEFORE the escrow attempt — the client has
 * already paid by the time this runs (the x402 middleware settled first),
 * and a paid commission that failed to escrow must exist somewhere the
 * operator can see and make right. A failure therefore returns the token
 * too: it is a receipt either way.
 */
export async function commissionOffice(input: {
  templateId: string
  scope: string
  payer: string | null
}): Promise<CommissionResult> {
  const pricing = commissionPricing(input.templateId)
  if (!pricing) return { ok: false, error: 'This template is not open for external commission.' }

  const stores = await enabledStorefronts(input.templateId)
  const store = stores[0]
  if (!store) {
    return {
      ok: false,
      error:
        'No open storefront serves this template right now. GET /api/storefront lists what is open — checking it before paying avoids this.',
    }
  }

  const today = await commissionsToday(input.templateId)
  if (today >= MAX_COMMISSIONS_PER_DAY) {
    return {
      ok: false,
      error: `This storefront is at its daily capacity (${MAX_COMMISSIONS_PER_DAY}). Try after 00:00 UTC.`,
    }
  }

  await ensureTables()
  const token = nanoid(24)
  await pgPool.query(
    `INSERT INTO storefront_commission (id, template_id, user_id, slot, payer, price_usd, scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [token, input.templateId, store.userId, store.slot, input.payer, pricing.priceUsd, input.scope],
  )

  try {
    const { hireOfficeTemplateFor } = await import('@/lib/office-hire')
    const hired = await hireOfficeTemplateFor(store.userId, {
      templateId: input.templateId,
      primeAgentId: store.primeAgentId,
      scope: input.scope,
      budgetUsd: pricing.budgetUsd,
      officeSlot: store.slot,
      // Reuse the standing desk — its agents carry the wallets, wiring and
      // graded history the storefront is selling. A fresh anonymous desk
      // would be exactly the commodity labor this product is not.
      freshAgents: false,
    })
    if ('error' in hired) throw new Error(hired.error)

    const { confirmDelegationJobs } = await import('@/lib/delegation')
    const confirmed = await confirmDelegationJobs(hired.delegationId, store.userId)
    if (!confirmed.ok) throw new Error(confirmed.error)

    await pgPool.query(`UPDATE storefront_commission SET delegation_id = $2 WHERE id = $1`, [
      token,
      hired.delegationId,
    ])
    console.info(
      `[storefront] commission ${token}: ${input.templateId} escrowed as ${hired.delegationId} for payer ${input.payer ?? 'unattributed'}`,
    )
    return { ok: true, token, delegationId: hired.delegationId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await pgPool
      .query(`UPDATE storefront_commission SET note = $2 WHERE id = $1`, [token, `ESCROW FAILED: ${message.slice(0, 400)}`])
      .catch(() => undefined)
    console.error(`[storefront] commission ${token} failed to escrow:`, error)
    return {
      ok: false,
      token,
      error:
        `Payment received but the pipeline could not be escrowed (${message}). Keep this token — it is your receipt; ` +
        `the operator can see it and make it right.`,
    }
  }
}

export type CommissionStatus = {
  token: string
  templateId: string
  createdAt: string
  status: 'failed' | 'running' | 'completed'
  note: string | null
  subtasks: Array<{ title: string; status: string }>
  /** The assembled deliverable — present only when the pipeline completed. */
  finalOutput: string | null
}

/** What a commission's token holder may see. Polling this also nudges the
 *  delegation's own tick, so an external client polling for their result is
 *  simultaneously driving its verification — the same trick
 *  delegation_status plays for owners. */
export async function commissionStatus(token: string): Promise<CommissionStatus | null> {
  await ensureTables()
  const { rows } = await pgPool.query<{
    id: string
    template_id: string
    delegation_id: string | null
    note: string | null
    created_at: Date
  }>(`SELECT id, template_id, delegation_id, note, created_at FROM storefront_commission WHERE id = $1`, [token])
  const row = rows[0]
  if (!row) return null

  if (!row.delegation_id) {
    return {
      token: row.id,
      templateId: row.template_id,
      createdAt: row.created_at.toISOString(),
      status: 'failed',
      note: row.note,
      subtasks: [],
      finalOutput: null,
    }
  }

  const [dlg] = await db.select().from(delegation).where(eq(delegation.id, row.delegation_id))
  if (!dlg) {
    return {
      token: row.id,
      templateId: row.template_id,
      createdAt: row.created_at.toISOString(),
      status: 'failed',
      note: 'delegation record missing',
      subtasks: [],
      finalOutput: null,
    }
  }

  const { tickDelegation, subtaskViews } = await import('@/lib/delegation')
  await tickDelegation(dlg).catch(() => undefined)
  const [fresh] = await db.select().from(delegation).where(eq(delegation.id, row.delegation_id))
  const views = await subtaskViews(fresh ?? dlg)

  return {
    token: row.id,
    templateId: row.template_id,
    createdAt: row.created_at.toISOString(),
    status: (fresh ?? dlg).status === 'completed' ? 'completed' : 'running',
    note: row.note,
    // The client-facing status per step: the on-chain job status when the
    // job exists, a terminal marker when it failed, 'Queued' while a
    // dependency wave holds it back. Never the internal spec hash or worker
    // identity — the token holder bought the deliverable, not the roster.
    subtasks: views.map((v) => ({
      title: v.title,
      status: v.failed ? `failed${v.failReason ? ` (${v.failReason})` : ''}` : (v.jobStatus ?? 'Queued'),
    })),
    finalOutput: (fresh ?? dlg).finalOutput ?? null,
  }
}
