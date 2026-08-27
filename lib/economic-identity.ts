/**
 * Who actually controls an agent.
 *
 * Two functions in this codebase are written to return `unknown` and say why:
 * `verifierIndependence` (lib/trade-instruments.ts) asks whether a grader is
 * economically separate from the parties it judges, and
 * `escapesByRestructuring` (lib/normative-transport.ts) asks whether a new
 * agent leaves the same controller free of a burden. Both need the same thing
 * and neither had it. An agent has a wallet and a `userId`, and a `userId` is
 * an account, not an organisation.
 *
 * The gap matters because both questions are adversarial. A verifier that
 * belongs to the seller is worth nothing and looks identical to one that does
 * not. An operator who fails a job can open a second account. Neither is
 * exotic: they are the two cheapest attacks on a market that pays on a
 * verdict.
 *
 * ## Identity is a chain, not a scalar
 *
 *     agent  →  operator (account)  →  organisation
 *
 * Two agents may share an organisation without sharing an operator, and that
 * is still a conflict. So independence is judged at the HIGHEST level the two
 * share, not at the agent.
 *
 * ## The asymmetry that makes this resistant rather than decorative
 *
 * If membership were self-declared, the attack writes itself: two colluding
 * operators declare different organisations and pass every independence
 * check. Attestation by the organisation would fix that — but requiring it
 * everywhere means an unattested market has no links at all, and the same
 * attack succeeds by everyone simply staying silent.
 *
 * So the rule is asymmetric, and it is the evidentiary one:
 *
 *   **A claim that increases your constraints is believed. A claim that
 *   reduces them requires attestation by the party it binds.**
 *
 * Declaring "these two agents are mine" narrows what they may do — believed
 * on its face, exactly as an admission against interest is. Declaring "I am
 * unrelated to that operator" widens it, and is worth nothing unless the
 * other side says so too. Nothing here can be relaxed by an unattested
 * assertion.
 */
import { pool } from '@/lib/db'

/** The layers, weakest first. Independence must clear ALL of them. */
export const CONTROL_LEVELS = ['agent', 'operator', 'organization'] as const
export type ControlLevel = (typeof CONTROL_LEVELS)[number]

/**
 * How a link between an operator and an organisation came to be known.
 *
 * `attested` means the organisation confirmed it. `claimed` means only the
 * operator said so. The distinction never relaxes a constraint — see the
 * header — but it is recorded because an unattested claim is still evidence
 * of a tie, and discarding it would be the mistake.
 */
export type LinkStrength = 'attested' | 'claimed'

export type Controller = {
  agentId: string
  operatorId: string | null
  organizationId: string | null
  organizationLink: LinkStrength | null
}

let tableReady: Promise<void> | null = null
function ensureTables(): Promise<void> {
  tableReady ??= (async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS economic_organization (
         org_id text PRIMARY KEY,
         name text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pool.query(
      `CREATE TABLE IF NOT EXISTS operator_organization (
         operator_id text PRIMARY KEY,
         org_id text NOT NULL,
         strength text NOT NULL DEFAULT 'claimed',
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pool.query(
      `CREATE INDEX IF NOT EXISTS operator_organization_by_org ON operator_organization (org_id)`,
    )
  })()
  return tableReady
}

export type Independence = 'independent' | 'conflicted' | 'unknown'

/**
 * Are these three parties economically separate enough for the verdict to
 * mean anything?
 *
 * Pure, so the rule that decides whether a grade counts is testable without a
 * database. Returns `unknown` rather than guessing, and NEVER `independent`
 * on missing evidence — an unresolvable party is the case an attacker
 * arranges.
 */
export function independenceOf(input: {
  buyer: Controller
  seller: Controller
  verifier: Controller
}): { verdict: Independence; level: ControlLevel | null; why: string } {
  const { buyer, seller, verifier } = input

  // Agent level first: the same agent on two sides of its own trade is the
  // crudest case and needs no organisation data to catch.
  if (verifier.agentId === buyer.agentId || verifier.agentId === seller.agentId) {
    return { verdict: 'conflicted', level: 'agent', why: 'The verifier is a party to the trade.' }
  }

  if (verifier.operatorId !== null) {
    if (verifier.operatorId === buyer.operatorId || verifier.operatorId === seller.operatorId) {
      return {
        verdict: 'conflicted',
        level: 'operator',
        why: 'The verifier and a party to the trade are the same account.',
      }
    }
  }

  if (verifier.organizationId !== null) {
    if (verifier.organizationId === buyer.organizationId || verifier.organizationId === seller.organizationId) {
      // Deliberately not gated on `attested`. A conflict declared by the
      // party it binds is an admission against interest, and refusing to
      // believe it would let anyone clear themselves by not registering.
      return {
        verdict: 'conflicted',
        level: 'organization',
        why: 'The verifier and a party to the trade belong to the same organisation.',
      }
    }
  }

  // Clearing requires positively knowing each party's controller at the
  // levels being compared. Silence is not separation.
  const unresolved: string[] = []
  for (const [role, c] of [
    ['buyer', buyer],
    ['seller', seller],
    ['verifier', verifier],
  ] as const) {
    if (c.operatorId === null) unresolved.push(`${role} has no known operator`)
  }
  if (unresolved.length > 0) {
    return { verdict: 'unknown', level: null, why: unresolved.join('; ') }
  }

  return {
    verdict: 'independent',
    level: null,
    why: 'No shared agent, account or organisation between the verifier and either party.',
  }
}

/**
 * Do these two agents answer to the same controller, at any level?
 *
 * The question `escapesByRestructuring` needs. Returns `'unknown'` when
 * either side cannot be resolved, and a caller must not read that as "no" —
 * which is why it is a tri-state rather than a boolean.
 */
export function sharesController(a: Controller, b: Controller): 'yes' | 'no' | 'unknown' {
  if (a.agentId === b.agentId) return 'yes'
  if (a.operatorId !== null && a.operatorId === b.operatorId) return 'yes'
  if (a.organizationId !== null && a.organizationId === b.organizationId) return 'yes'
  if (a.operatorId === null || b.operatorId === null) return 'unknown'
  return 'no'
}

/** Resolve the control chain for a set of agents. One query per layer, not
 *  per agent — this runs inside grading and mining sweeps. */
export async function controllersFor(agentIds: readonly string[]): Promise<Map<string, Controller>> {
  const out = new Map<string, Controller>()
  const ids = [...new Set(agentIds.filter(Boolean))]
  if (ids.length === 0) return out

  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { inArray } = await import('drizzle-orm')
  const rows = await db.select({ id: agent.id, userId: agent.userId }).from(agent).where(inArray(agent.id, ids))

  await ensureTables()
  const operatorIds = [...new Set(rows.map((r) => r.userId).filter(Boolean))]
  const orgByOperator = new Map<string, { orgId: string; strength: LinkStrength }>()
  if (operatorIds.length > 0) {
    const { rows: links } = await pool.query<{ operator_id: string; org_id: string; strength: string }>(
      `SELECT operator_id, org_id, strength FROM operator_organization WHERE operator_id = ANY($1)`,
      [operatorIds],
    )
    for (const l of links) {
      orgByOperator.set(l.operator_id, {
        orgId: l.org_id,
        strength: l.strength === 'attested' ? 'attested' : 'claimed',
      })
    }
  }

  for (const id of ids) {
    const row = rows.find((r) => r.id === id)
    // An agent id that resolves to nothing gets a controller with nulls, not
    // an absent entry: a caller iterating the map must see the unknown rather
    // than skip the party.
    const link = row?.userId ? orgByOperator.get(row.userId) : undefined
    out.set(id, {
      agentId: id,
      operatorId: row?.userId ?? null,
      organizationId: link?.orgId ?? null,
      organizationLink: link?.strength ?? null,
    })
  }
  return out
}

/**
 * Record that an operator belongs to an organisation.
 *
 * `strength` defaults to `claimed` on purpose: the caller is the operator,
 * and an operator cannot attest to its own membership. Attestation is a
 * separate act by the organisation, and nothing in this file lets a claim
 * become one.
 */
export async function declareOrganization(input: {
  operatorId: string
  orgId: string
  name: string
  strength?: LinkStrength
}): Promise<void> {
  await ensureTables()
  await pool.query(
    `INSERT INTO economic_organization (org_id, name) VALUES ($1, $2) ON CONFLICT (org_id) DO NOTHING`,
    [input.orgId, input.name],
  )
  await pool.query(
    `INSERT INTO operator_organization (operator_id, org_id, strength) VALUES ($1, $2, $3)
     ON CONFLICT (operator_id) DO UPDATE SET org_id = $2, strength = $3, updated_at = now()`,
    [input.operatorId, input.orgId, input.strength ?? 'claimed'],
  )
}

/**
 * The strongest identifier that stands for "who controls this agent".
 *
 * An organisation when one is known, the operator otherwise. Namespaced,
 * because an org id and an operator id colliding would silently merge two
 * unrelated controllers — and the whole point is that comparing these strings
 * decides whether a verdict counts.
 *
 * Deliberately NOT the agent id: an agent is the thing being controlled, and
 * a check that fell back to it would report every pair of agents as different
 * controllers, which is the answer that clears an attacker.
 */
export function strongestControlKey(c: Controller): string | null {
  if (c.organizationId !== null) return `org:${c.organizationId}`
  if (c.operatorId !== null) return `op:${c.operatorId}`
  return null
}

/** Every operator known to belong to an organisation. The set a conflict
 *  check widens over. */
export async function operatorsInOrganization(orgId: string): Promise<string[]> {
  await ensureTables()
  const { rows } = await pool.query<{ operator_id: string }>(
    `SELECT operator_id FROM operator_organization WHERE org_id = $1`,
    [orgId],
  )
  return rows.map((r) => r.operator_id)
}
