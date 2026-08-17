/**
 * The enterprise compiler: typed economic primitives → an executable
 * micro-enterprise, or a refusal that names what is missing.
 *
 * The thesis this serves is narrower than "compose economic rights", because
 * composing them is not new. A film is assembled exactly this way — script
 * licence, financiers, cast and crew, a location, and a *settlement waterfall*,
 * which is that industry's own word — and dissolved after distribution. So is a
 * construction consortium, and so is consignment retail with inventory
 * financing. What every one of those needs in order to assemble is lawyers,
 * audits, and pre-existing trust between the parties.
 *
 *   The claim is not that rights can be composed. It is that the composition
 *   can be ENFORCED between parties who do not trust each other — escrow and
 *   evidence in place of a contract and an auditor.
 *
 * ## Three decisions in here that a reader will want to argue with
 *
 * **1. There are no dollar constants and no risk tiers.** An `E1 → $20
 * exposure` table would be a number with nothing behind it, printed next to
 * measured ones. The ceiling is money the protocol is actually holding, so it
 * is a live quantity. Evidence enters at one place only: whether posted
 * collateral is *chargeable at all*. See `capitalIsSecurable`.
 *
 * **2. `worstCaseExposure` is derived, never passed in.** A compiler that
 * accepts the risk number as an argument is a calculator with extra steps: the
 * party who benefits from a low number is the party supplying it. It is
 * computed from the nodes — inventory at cost, plus fixed service obligations,
 * plus anything releasable before the sale is observed.
 *
 * **3. One party may hold several roles, and that is disclosed rather than
 * refused.** Requiring six independent suppliers before the mechanism can run
 * would mean staging six, which this repo does not do. The roles are typed and
 * the waterfall is enforced whoever holds them; when one wallet holds three,
 * the compiled graph says so, the same way `/participation` discloses that most
 * requesters are the operator. A sixth real participant needs no code change —
 * that substitutability is the actual evidence that this is a compiler.
 *
 * ## What "dissolve" does and does not destroy
 *
 * Dissolving revokes **capabilities**. It must not destroy the **record**:
 * contextual credit is computed from settled graphs, so a graph that erased
 * itself would erase the only thing that lets the next one be cheaper.
 */

import { classRank, type EvidenceClass } from './evidence-assurance'

/** All money in this module is integer USD cents. Floats drift; a waterfall
 *  that does not sum exactly to the revenue is a waterfall that lost a cent
 *  somewhere, and "somewhere" is someone's. */
export type Cents = number

// ---------------------------------------------------------------------------
// Typed primitives
// ---------------------------------------------------------------------------

interface NodeBase {
  id: string
  /** Who supplies this. Roles are typed; parties are not unique across them. */
  party: string
}

/** Policy discretion plus the residual — the operator. Exactly one per graph. */
export interface OperatingRight extends NodeBase {
  kind: 'OperatingRight'
  /** What they actually decide. A holder who decides nothing is a supplier. */
  discretion: Array<'selection' | 'pricing' | 'discount' | 'reorder-threshold'>
  /** Collateral they posted, and earnings held back. Live balances. */
  bondCents: Cents
  withheldEarningsCents: Cents
}

/** IP under royalty — paid per unit sold, never a share of the residual. */
export interface RecipeLicense extends NodeBase {
  kind: 'RecipeLicense'
  royaltyBps: number
}

/** Machine time. Paid a fee for capacity supplied, outcome-independent. */
export interface CapacityJob extends NodeBase {
  kind: 'CapacityJob'
  feeBps: number
  fixedFeeCents: Cents
}

/** Inventory or working capital. Senior to the residual, junior to nothing. */
export interface CapitalCommitment extends NodeBase {
  kind: 'CapitalCommitment'
  principalCents: Cents
  /** Return on the advance, in bps of principal — not of revenue. A lender
   *  paid out of revenue is an equity holder wearing a lender's name. */
  returnBps: number
  /**
   * Node ids this advance has ALREADY paid, in cash, before the sale.
   *
   * Without this the same tin of Monster is owed twice — once to the supplier
   * who shipped it and once to the financier who paid for it — and the
   * waterfall tries to settle $184 of claims out of $155 of revenue. A funded
   * node's claim is discharged; the financier stands in its place.
   */
  fundsNodeIds: string[]
}

/** Labour at a fixed price: restock, maintenance, fulfilment. */
export interface ServiceJob extends NodeBase {
  kind: 'ServiceJob'
  feeCents: Cents
  /** Owed on performance whether or not anything sells. */
  owedOnPerformance: true
}

/** Cost of goods, owed to whoever supplied them. */
export interface InventorySupply extends NodeBase {
  kind: 'InventorySupply'
  unitCostCents: Cents
  units: number
}

export type EnterpriseNode =
  | OperatingRight
  | RecipeLicense
  | CapacityJob
  | CapitalCommitment
  | ServiceJob
  | InventorySupply

export type NodeKind = EnterpriseNode['kind']

export interface EnterpriseGraph {
  id: string
  status: 'draft' | 'compiled' | 'settled' | 'dissolved'
  nodes: EnterpriseNode[]
  /** The class of the channel that will observe the physical event. */
  evidenceClass: EvidenceClass
}

// ---------------------------------------------------------------------------
// Derived risk
// ---------------------------------------------------------------------------

/** Collateral is only part of the ceiling when the evidence could support
 *  charging it. Below this, taking a bond is a remedy on an assertion. */
export const MIN_CLASS_FOR_CHARGING_COLLATERAL: EvidenceClass = 'E3'

export const capitalIsSecurable = (c: EvidenceClass) =>
  classRank(c) >= classRank(MIN_CLASS_FOR_CHARGING_COLLATERAL)

export interface DerivedRisk {
  /** Money at risk if the operator's policy is simply wrong about demand:
   *  goods bought and unsold, plus labour owed whether or not they sell. */
  worstCaseExposureCents: Cents
  /** What can actually be recovered from the operator. */
  enforceableCeilingCents: Cents
  collateralChargeable: boolean
  /** Positive means the loss would land on someone who did not choose it. */
  uncoveredCents: Cents
}

/** Node ids already paid in cash by some CapitalCommitment. */
export function fundedNodeIds(graph: EnterpriseGraph): Set<string> {
  const funded = new Set<string>()
  for (const n of graph.nodes) {
    if (n.kind === 'CapitalCommitment') for (const id of n.fundsNodeIds) funded.add(id)
  }
  return funded
}

export function deriveRisk(graph: EnterpriseGraph): DerivedRisk {
  const op = graph.nodes.find((n): n is OperatingRight => n.kind === 'OperatingRight')
  const funded = fundedNodeIds(graph)

  // Only UNFUNDED goods are still owed to their supplier; the rest were paid
  // in cash and the financier's principal stands in their place. Counting both
  // would double the same tin of Monster.
  const unfundedInventory = graph.nodes
    .filter((n): n is InventorySupply => n.kind === 'InventorySupply' && !funded.has(n.id))
    .reduce((sum, n) => sum + n.unitCostCents * n.units, 0)

  const labourOwed = graph.nodes
    .filter((n): n is ServiceJob => n.kind === 'ServiceJob' && !funded.has(n.id))
    .reduce((sum, n) => sum + n.feeCents, 0)

  const capital = graph.nodes.filter((n): n is CapitalCommitment => n.kind === 'CapitalCommitment')
  const advanced = capital.reduce((sum, n) => sum + n.principalCents, 0)
  const capitalReturn = capital.reduce(
    (sum, n) => sum + Math.round((n.principalCents * n.returnBps) / 10_000),
    0,
  )

  const worstCaseExposureCents = unfundedInventory + labourOwed + advanced + capitalReturn

  const collateralChargeable = capitalIsSecurable(graph.evidenceClass)
  const enforceableCeilingCents =
    (op?.withheldEarningsCents ?? 0) + (collateralChargeable ? (op?.bondCents ?? 0) : 0)

  return {
    worstCaseExposureCents,
    enforceableCeilingCents,
    collateralChargeable,
    uncoveredCents: Math.max(0, worstCaseExposureCents - enforceableCeilingCents),
  }
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export interface Denial {
  code:
    | 'NO_OPERATOR'
    | 'MULTIPLE_OPERATORS'
    | 'NO_DISCRETION'
    | 'THIRD_PARTY_CAPITAL_UNSECURED'
    | 'EXPOSURE_EXCEEDS_CEILING'
    | 'ROYALTY_OVERSUBSCRIBED'
    | 'ADVANCE_DOES_NOT_COVER_WHAT_IT_FUNDS'
    | 'FUNDS_UNKNOWN_NODE'
  reason: string
}

/** One wallet holding several typed roles. Legal, disclosed, never silent. */
export interface RelatedParty {
  party: string
  roles: NodeKind[]
}

export interface Compiled {
  graph: EnterpriseGraph
  risk: DerivedRisk
  relatedParties: RelatedParty[]
  /** True when no single party holds two roles — the case this whole design is
   *  for, and the case we have not yet observed. */
  fullyIndependent: boolean
}

export type CompileResult = { ok: true; compiled: Compiled } | { ok: false; denials: Denial[] }

export function relatedParties(nodes: EnterpriseNode[]): RelatedParty[] {
  const byParty = new Map<string, NodeKind[]>()
  for (const n of nodes) {
    const roles = byParty.get(n.party) ?? []
    if (!roles.includes(n.kind)) roles.push(n.kind)
    byParty.set(n.party, roles)
  }
  return [...byParty.entries()]
    .filter(([, roles]) => roles.length > 1)
    .map(([party, roles]) => ({ party, roles }))
    .sort((a, b) => a.party.localeCompare(b.party))
}

export function compileEnterprise(graph: EnterpriseGraph): CompileResult {
  const denials: Denial[] = []

  const operators = graph.nodes.filter((n): n is OperatingRight => n.kind === 'OperatingRight')
  if (operators.length === 0) {
    denials.push({
      code: 'NO_OPERATOR',
      reason: 'no OperatingRight: nobody holds the residual, so a loss has no home',
    })
  }
  if (operators.length > 1) {
    denials.push({
      code: 'MULTIPLE_OPERATORS',
      reason: `${operators.length} OperatingRights: the residual cannot be split without making both holders lenders to each other`,
    })
  }
  const op = operators[0]
  if (op && op.discretion.length === 0) {
    denials.push({
      code: 'NO_DISCRETION',
      reason: 'the OperatingRight holder decides nothing — that is capacity supply or labour, not operatorship',
    })
  }

  const royaltyBps = graph.nodes
    .filter((n): n is RecipeLicense => n.kind === 'RecipeLicense')
    .reduce((s, n) => s + n.royaltyBps, 0)
  const capacityBps = graph.nodes
    .filter((n): n is CapacityJob => n.kind === 'CapacityJob')
    .reduce((s, n) => s + n.feeBps, 0)
  if (royaltyBps + capacityBps >= 10_000) {
    denials.push({
      code: 'ROYALTY_OVERSUBSCRIBED',
      reason: `revenue-proportional claims total ${royaltyBps + capacityBps} bps — at or above the whole sale, the residual is negative by construction`,
    })
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  for (const n of graph.nodes) {
    if (n.kind !== 'CapitalCommitment') continue
    let fundedCost = 0
    for (const id of n.fundsNodeIds) {
      const target = byId.get(id)
      if (!target) {
        denials.push({
          code: 'FUNDS_UNKNOWN_NODE',
          reason: `${n.id} claims to have funded ${id}, which is not in this graph`,
        })
        continue
      }
      fundedCost += costOf(target)
    }
    if (fundedCost > n.principalCents) {
      denials.push({
        code: 'ADVANCE_DOES_NOT_COVER_WHAT_IT_FUNDS',
        reason: `${n.id} advances ${usd(n.principalCents)} but claims to have paid ${usd(fundedCost)} of costs — the uncovered part is owed to a supplier who thinks it was settled`,
      })
    }
  }

  const risk = deriveRisk(graph)

  const thirdPartyCapital = graph.nodes.some(
    (n) => n.kind === 'CapitalCommitment' && n.party !== op?.party,
  )
  if (thirdPartyCapital && !risk.collateralChargeable) {
    denials.push({
      code: 'THIRD_PARTY_CAPITAL_UNSECURED',
      reason: `someone else's principal is at risk and the evidence channel is ${graph.evidenceClass}: a lender's loss must be provable to be remediable, so ${MIN_CLASS_FOR_CHARGING_COLLATERAL} is the floor`,
    })
  }

  if (risk.uncoveredCents > 0) {
    denials.push({
      code: 'EXPOSURE_EXCEEDS_CEILING',
      reason: `worst case ${usd(risk.worstCaseExposureCents)} exceeds the enforceable ceiling ${usd(risk.enforceableCeilingCents)} by ${usd(risk.uncoveredCents)} — not a pricing problem; a bigger bond that cannot be charged bounds nothing`,
    })
  }

  if (denials.length > 0) return { ok: false, denials }

  const related = relatedParties(graph.nodes)
  return {
    ok: true,
    compiled: {
      graph: { ...graph, status: 'compiled' },
      risk,
      relatedParties: related,
      fullyIndependent: related.length === 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Settlement waterfall
// ---------------------------------------------------------------------------

export interface Allocation {
  nodeId: string
  party: string
  kind: NodeKind | 'Residual'
  cents: Cents
  /** Owed but unpaid because the revenue ran out above this claim. */
  shortfallCents: Cents
}

export interface Settlement {
  revenueCents: Cents
  allocations: Allocation[]
  /** The operator's residual. Negative when senior claims exceeded revenue —
   *  that is what taking the residual means, and the reason it is checked
   *  against the enforceable ceiling at compile time. */
  residualCents: Cents
  /** Loss that lands on senior claimants because the operator could not cover
   *  it. Non-zero here means the compile-time check was wrong, or the graph
   *  was mutated after compiling. */
  unrecoveredCents: Cents
}

/**
 * Pay out one sale, strictly in priority order.
 *
 * The order is not a preference. Each rank is senior to the next because its
 * claim is outcome-independent: goods were supplied, labour was performed,
 * capital was advanced, capacity was used. The operator is last because the
 * operator is the only party who *chose* the exposure.
 *
 *   1. InventorySupply  — cost of goods
 *   2. ServiceJob       — labour, owed on performance
 *   3. CapitalCommitment— principal, then return
 *   4. CapacityJob      — machine fee
 *   5. RecipeLicense    — royalty
 *   6. OperatingRight   — residual, which may be negative
 *
 * Royalty and capacity fees are bps of revenue and sit *below* the fixed
 * claims deliberately: a percentage claim on a sale that did not cover its own
 * cost of goods would be paying a fee out of someone else's principal.
 */
export function settle(compiled: Compiled, revenueCents: Cents): Settlement {
  const { graph, risk } = compiled
  const op = graph.nodes.find((n): n is OperatingRight => n.kind === 'OperatingRight')!
  const funded = fundedNodeIds(graph)
  let remaining = revenueCents
  const allocations: Allocation[] = []

  const pay = (nodeId: string, party: string, kind: NodeKind, owed: Cents) => {
    const paid = Math.max(0, Math.min(owed, remaining))
    remaining -= paid
    allocations.push({ nodeId, party, kind, cents: paid, shortfallCents: owed - paid })
  }

  // A node someone already paid in cash is not owed again out of revenue.
  for (const n of graph.nodes.filter(
    (x): x is InventorySupply => x.kind === 'InventorySupply' && !funded.has(x.id),
  )) {
    pay(n.id, n.party, n.kind, n.unitCostCents * n.units)
  }
  for (const n of graph.nodes.filter(
    (x): x is ServiceJob => x.kind === 'ServiceJob' && !funded.has(x.id),
  )) {
    pay(n.id, n.party, n.kind, n.feeCents)
  }
  for (const n of graph.nodes.filter((x): x is CapitalCommitment => x.kind === 'CapitalCommitment')) {
    pay(n.id, n.party, n.kind, n.principalCents + Math.round((n.principalCents * n.returnBps) / 10_000))
  }
  for (const n of graph.nodes.filter((x): x is CapacityJob => x.kind === 'CapacityJob')) {
    pay(n.id, n.party, n.kind, n.fixedFeeCents + Math.round((revenueCents * n.feeBps) / 10_000))
  }
  for (const n of graph.nodes.filter((x): x is RecipeLicense => x.kind === 'RecipeLicense')) {
    pay(n.id, n.party, n.kind, Math.round((revenueCents * n.royaltyBps) / 10_000))
  }

  const shortfall = allocations.reduce((s, a) => s + a.shortfallCents, 0)
  const residualCents = shortfall > 0 ? -shortfall : remaining

  allocations.push({
    nodeId: op.id,
    party: op.party,
    kind: 'Residual',
    cents: residualCents,
    shortfallCents: 0,
  })

  // A negative residual is charged against the operator's holdings. Anything
  // beyond them lands on the senior claimants, which is the failure the
  // compile-time check exists to make impossible.
  const unrecoveredCents =
    residualCents < 0 ? Math.max(0, -residualCents - risk.enforceableCeilingCents) : 0

  return { revenueCents, allocations, residualCents, unrecoveredCents }
}

/**
 * Revoke the capabilities; keep the record.
 *
 * `settlement` is returned alongside rather than dropped, because contextual
 * credit is computed from settled graphs. A graph that erased itself on
 * dissolution would erase the only thing that makes the operator's next graph
 * cheaper than this one.
 */
export function dissolve(compiled: Compiled, settlement: Settlement) {
  return {
    graph: { ...compiled.graph, status: 'dissolved' as const },
    record: {
      graphId: compiled.graph.id,
      evidenceClass: compiled.graph.evidenceClass,
      relatedParties: compiled.relatedParties,
      fullyIndependent: compiled.fullyIndependent,
      revenueCents: settlement.revenueCents,
      residualCents: settlement.residualCents,
      unrecoveredCents: settlement.unrecoveredCents,
      allocations: settlement.allocations,
    },
  }
}

/** What a node costs, for the funding-coverage check. Revenue-proportional
 *  claims have no fixed cost and cannot be prepaid. */
function costOf(n: EnterpriseNode): Cents {
  switch (n.kind) {
    case 'InventorySupply':
      return n.unitCostCents * n.units
    case 'ServiceJob':
      return n.feeCents
    case 'CapacityJob':
      return n.fixedFeeCents
    default:
      return 0
  }
}

const usd = (c: Cents) => `$${(c / 100).toFixed(2)}`
