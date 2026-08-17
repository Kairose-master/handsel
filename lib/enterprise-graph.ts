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
import {
  applyMerger,
  distribute,
  type Distribution,
  type MergerResult,
  type Perfection,
  type Stick,
  type StickPayment,
} from './property-sticks'

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
  /**
   * How this node's claim is made good against third parties. Absent means
   * `contractual` — a promise between two parties, which is where an unstated
   * right belongs. See `lib/property-sticks.ts`: publicity decides seniority,
   * so a generous default would hand out priority nobody published.
   */
  perfection?: Perfection
  /** 성립 순위. Absent means "in graph order", which is only a tiebreak. */
  sequence?: number
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
    | 'SENIOR_BUT_UNRECOVERABLE'
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

  // Senior over an empty pool: the trap the two axes only reveal together.
  // A financier can be recorded on-chain, first in line, and still recover
  // nothing, because the evidence channel cannot support charging the bond
  // sitting right there. Refusing to compile is the only honest answer — the
  // alternative is issuing a priority we know cannot be enforced.
  const perfectedThirdParty = graph.nodes.find(
    (n) =>
      n.kind === 'CapitalCommitment' &&
      n.party !== op?.party &&
      (n.perfection ?? 'contractual') === 'onchain',
  )
  if (perfectedThirdParty && !risk.collateralChargeable && (op?.bondCents ?? 0) > 0) {
    denials.push({
      code: 'SENIOR_BUT_UNRECOVERABLE',
      reason: `${perfectedThirdParty.id} is perfected on-chain and would rank first, but at ${graph.evidenceClass} the operator's ${usd(op?.bondCents ?? 0)} bond cannot be charged — priority over a pool we may not touch is not security`,
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
  /** Sticks extinguished by 혼동 — security the residual holder held against
   *  themselves. Reported rather than silently dropped: the money did not
   *  disappear, it was never a claim. */
  merged: MergerResult['merged']
  /** What short claimants could reach from the operator, and in what order. */
  recovery: Recovery
}

/**
 * What each node is owed out of one sale, and how its claim is perfected.
 *
 * `perfection` is a property of the node rather than of its kind, because two
 * financiers can be differently secured — one with `assignPayee` set on the
 * escrow, one with a promise — and that difference is the whole point. It is a
 * required field: an unstated perfection defaults to `contractual`, never to
 * something generous.
 */
export function claimsOf(graph: EnterpriseGraph, revenueCents: Cents): Stick[] {
  const funded = fundedNodeIds(graph)
  const sticks: Stick[] = []
  let seq = 0

  for (const n of graph.nodes) {
    seq += 1
    const base = { id: n.id, party: n.party, sequence: n.sequence ?? seq }
    switch (n.kind) {
      case 'InventorySupply':
        // A funded supplier was already paid in cash and is owed nothing here.
        if (funded.has(n.id)) continue
        sticks.push({
          ...base,
          incidents: ['capital'],
          // 소유권유보 if they retained title, otherwise an ordinary trade creditor.
          perfection: n.perfection ?? 'contractual',
          owedCents: n.unitCostCents * n.units,
        })
        break
      case 'ServiceJob':
        if (funded.has(n.id)) continue
        sticks.push({
          ...base,
          incidents: ['use'],
          perfection: n.perfection ?? 'contractual',
          owedCents: n.feeCents,
        })
        break
      case 'CapitalCommitment':
        sticks.push({
          ...base,
          incidents: ['security'],
          perfection: n.perfection ?? 'contractual',
          owedCents: n.principalCents + Math.round((n.principalCents * n.returnBps) / 10_000),
          secures: n.fundsNodeIds,
        })
        break
      case 'CapacityJob':
        sticks.push({
          ...base,
          incidents: ['possession', 'income'],
          perfection: n.perfection ?? 'contractual',
          owedCents: n.fixedFeeCents + Math.round((revenueCents * n.feeBps) / 10_000),
        })
        break
      case 'RecipeLicense':
        sticks.push({
          ...base,
          incidents: ['income'],
          perfection: n.perfection ?? 'contractual',
          owedCents: Math.round((revenueCents * n.royaltyBps) / 10_000),
        })
        break
      case 'OperatingRight':
        // The residual is not a claim in the queue; it is what is left.
        break
    }
  }
  return sticks
}

/**
 * Pay out one sale.
 *
 * The order is NOT written here. It comes from `lib/property-sticks.ts`:
 * perfected claims in time order, then equal claimants pro rata, then the
 * residual. Yesterday this function contained a hand-written sequence
 * justified by an economic argument — outcome-independent claims are senior —
 * which was a fairness intuition dressed as a rule, and which paid whichever
 * equal claimant I happened to filter first in full while another got nothing.
 *
 * The doctrine's answer is harsher and truer: publicity decides seniority
 * (물권 > 채권, 성립 순위), and claimants of equal rank share the shortfall
 * (채권자평등의 원칙).
 */
export function settle(compiled: Compiled, revenueCents: Cents): Settlement {
  const { graph, risk } = compiled
  const op = graph.nodes.find((n): n is OperatingRight => n.kind === 'OperatingRight')!
  const kindOf = new Map<string, NodeKind>(graph.nodes.map((n) => [n.id, n.kind]))

  // 혼동: security the residual holder holds against themselves is not a claim.
  const { sticks, merged } = applyMerger(claimsOf(graph, revenueCents), op.party)
  const dist = distribute(sticks, revenueCents)

  const allocations: Allocation[] = dist.payments.map((p) => ({
    nodeId: p.stickId,
    party: p.party,
    kind: kindOf.get(p.stickId)!,
    cents: p.paidCents,
    shortfallCents: p.shortfallCents,
  }))

  const residualCents = dist.shortfallCents > 0 ? -dist.shortfallCents : dist.remainingCents

  allocations.push({
    nodeId: op.id,
    party: op.party,
    kind: 'Residual',
    cents: residualCents,
    shortfallCents: 0,
  })

  const recovery = recover(graph, sticks, dist)

  return {
    revenueCents,
    allocations,
    residualCents,
    unrecoveredCents: recovery.unrecoveredCents,
    merged,
    recovery,
  }
}

/**
 * Where the two axes finally meet.
 *
 * Until now they ran past each other. **Publicity** decided who gets paid first
 * out of proceeds that exist (`lib/property-sticks.ts`). **Evidence** decided
 * whether the operator's collateral may be charged at all
 * (`MIN_CLASS_FOR_CHARGING_COLLATERAL`). Neither function answered the question
 * a short claimant actually asks: *given that the sale did not cover me, what
 * can I reach, and am I ahead of the others reaching for it?*
 *
 * The answer is the product of both, and it is a second distribution over a
 * different pool:
 *
 *   pool  = withheld earnings + (collateral, only if the class allows charging)
 *   order = the same priority order — a perfected claim is senior here too
 *
 * The state this exposes is the one worth naming, because it looks safe and is
 * not: **senior over an empty pool.** A financier can be first in line, recorded
 * on-chain, and recover nothing, because the evidence channel cannot support
 * taking the bond that is sitting right there. Priority is not recovery. That
 * is why `unreachableCents` is reported separately instead of being netted
 * away — an audit panel that shows "$80 held, $0 recoverable" tells a lender
 * something a single "recovered: $0" never would.
 */
export interface Recovery {
  /** What may actually be taken from the operator to cover shortfalls. */
  poolCents: Cents
  /** Held by the protocol and NOT chargeable at this evidence class. */
  unreachableCents: Cents
  /** Who was made whole, in priority order, out of the pool. */
  payments: StickPayment[]
  /** Loss that stays with the claimants after the pool is exhausted. */
  unrecoveredCents: Cents
}

export function recover(
  graph: EnterpriseGraph,
  claims: Stick[],
  dist: Distribution,
): Recovery {
  const op = graph.nodes.find((n): n is OperatingRight => n.kind === 'OperatingRight')!
  const chargeable = capitalIsSecurable(graph.evidenceClass)
  const poolCents = op.withheldEarningsCents + (chargeable ? op.bondCents : 0)
  const unreachableCents = chargeable ? 0 : op.bondCents

  const byId = new Map(claims.map((c) => [c.id, c]))
  // Each shortfall becomes a claim on the recovery pool, at its own rank: the
  // party who was senior to the revenue is senior to the collateral too.
  const shortfalls: Stick[] = dist.payments
    .filter((p) => p.shortfallCents > 0)
    .map((p) => {
      const original = byId.get(p.stickId)!
      return { ...original, owedCents: p.shortfallCents }
    })

  const rec = distribute(shortfalls, poolCents)
  return {
    poolCents,
    unreachableCents,
    payments: rec.payments,
    unrecoveredCents: rec.shortfallCents,
  }
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
