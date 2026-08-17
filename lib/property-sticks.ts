/**
 * Rights as separable sticks, and priority derived from publicity.
 *
 * `enterprise-graph.ts` enumerates six primitives and pays them in an order I
 * wrote down. Both halves of that were weak: a list is not a decomposition
 * (nothing tells you whether it is complete, or whether two entries overlap),
 * and a hand-written priority order is a fairness intuition wearing a rule's
 * clothes. Property law has worked answers to both, and they are older than
 * every blockchain.
 *
 * ## The frame
 *
 * A thing does not bear one right. It bears a bundle of separable incidents —
 * possession, use, management, income, capital, security, exclusion — and any
 * real arrangement is a subset held by different people. Korean 민법 works
 * exactly this way: 소유권 alongside 제한물권 (지상권·전세권·저당권 …),
 * several of them on one 물건 at once.
 *
 * That gives the type system a **generative basis** instead of a list. Our six
 * primitives stop being axioms and become named subsets of incidents.
 *
 * ## Where priority comes from: publicity, not fairness
 *
 * 민법's ordering is not about who deserves it. It is:
 *
 *   물권 > 채권                 — a right in the thing beats a promise about it
 *   물권 사이: 성립 순위          — earlier-perfected wins
 *   일반채권자 사이: 평등          — equal claimants share pro rata (채권자평등의 원칙)
 *
 * And a real right that is not published does not exist against third parties
 * (부동산 물권변동에 등기; 동산에 인도). **That maps onto our own machinery
 * with no strain at all:** a claim recorded on-chain is 물권적 — it attaches to
 * the escrow and survives the operator's default. A claim that is only a
 * promise between two parties is 채권적. `assignPayee` on LaborMarketV2, which
 * we already shipped, is precisely the act of perfection, and
 * `docs/product-thesis.md` had already reached the same place in different
 * words: *"a lender could see the asset and could not seize it — the whole
 * discipline of secured lending lives in the gap between those two verbs."*
 *
 * So the waterfall stops being my list. It is: perfected tiers in time order,
 * paid in full down the ranks; then unperfected claimants sharing what is left
 * pro rata; then the income stick, which is the residual.
 *
 * This is harsher than what I wrote yesterday and it is truer. An unsecured
 * trade supplier ranks below a perfected financier — that is what happens in
 * every insolvency — and it makes the protocol's offer concrete rather than
 * rhetorical: *we can perfect your stick cheaply, and that is what we are for.*
 *
 * ## The objection this frame has to carry
 *
 * "Bundle of sticks" is contested, and by the strongest available critique of
 * our own thesis. Merrill and Smith's argument against the bundle metaphor is
 * that it implies sticks are freely recombinable, when property law
 * deliberately refuses free recombination — **numerus clausus**, 물권법정주의
 * (민법 185조: 물권은 법률 또는 관습법에 의하지 않으면 창설할 수 없다). The
 * reason is information cost borne by strangers: every novel combination
 * forces every future third party to investigate what rights encumber the
 * thing, so law standardizes the modules and refuses bespoke ones.
 *
 * A compiler for arbitrary combinations is exactly what that doctrine forbids,
 * so the objection is not decoration — it is the reviewer's first question.
 *
 * Our answer, and it is a real one: **numerus clausus is a response to
 * information cost, and publicity that is complete and free relaxes the
 * constraint it was pricing.** A stranger does not search a registry and trust
 * an abstract of title; they read the graph. That is why this module makes
 * `perfection` a required field rather than an optional flag — the claim only
 * holds for sticks that are actually published, and an unpublished stick is
 * demoted to a promise, exactly as the doctrine says it should be.
 *
 * It also explains why the primitive set stays CLOSED, which yesterday I had
 * only asserted: third parties must be able to know what can possibly encumber
 * a thing without reading every contract.
 *
 * ## Anticommons
 *
 * The other standard warning about dividing rights: too many holders with veto
 * power and the resource goes unused (Heller's anticommons). Six people each
 * able to block a sale means the machine never dispenses. `exactly one
 * management stick` was already enforced in the compiler as "one
 * OperatingRight" — this module gives it its reason, and adds the check the
 * reason implies: no other stick may carry a veto.
 */

import type { Cents } from './enterprise-graph'

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

/**
 * Honoré's incidents, trimmed to the ones that can encumber a productive asset
 * and mean something economically distinct here.
 */
export type Incident =
  /** 점유 — physically holds the thing. */
  | 'possession'
  /** 사용 — may put it to use. */
  | 'use'
  /** 관리 — decides policy: selection, price, reorder. Discretion. */
  | 'management'
  /** 수익 (fructus) — takes what it produces. Residual or a defined share. */
  | 'income'
  /** 처분 — may alienate it. */
  | 'capital'
  /** 담보 — a claim on value rather than on use. Extinguishes on payment. */
  | 'security'
  /** 배제 — may exclude others. */
  | 'exclusion'

/**
 * How the stick is made good against people who were not party to it.
 *
 * The order of this type is the priority order, and that is not a coincidence
 * — it is the whole content of the module.
 */
export type Perfection =
  /**
   * 등기에 상당. Recorded in the contract itself: `assignPayee`, an on-chain
   * royalty split, the protocol fee. Attaches to the money before anyone can
   * redirect it, and survives the counterparty's default.
   */
  | 'onchain'
  /**
   * The value is in protocol custody. Good for as long as custody holds, which
   * is weaker than on-chain recording but much stronger than a promise: the
   * holder does not have to sue anyone to be paid.
   */
  | 'escrowed'
  /**
   * 소유권유보 — the supplier retained title to the goods. A real right in the
   * thing, arising without any of our machinery, which is why it is worth
   * modelling: it is the one way an ordinary supplier gets seniority for free.
   */
  | 'retained-title'
  /** 채권. Enforceable against one counterparty and nobody else. */
  | 'contractual'
  /** Not a stick against third parties at all. A hope with a number on it. */
  | 'none'

export const PERFECTION_RANK: Record<Perfection, number> = {
  onchain: 0,
  'retained-title': 1,
  escrowed: 2,
  contractual: 3,
  none: 4,
}

/** Ranks that are paid in full, in sequence, before the next rank sees money. */
const PREFERENTIAL: Perfection[] = ['onchain', 'retained-title', 'escrowed']
/** Ranks where nobody outranks anybody, so a shortfall is shared. */
const PARI_PASSU: Perfection[] = ['contractual', 'none']

export const isPreferential = (p: Perfection) => PREFERENTIAL.includes(p)

export interface Stick {
  id: string
  party: string
  incidents: Incident[]
  perfection: Perfection
  /** 성립 순위. Lower is earlier, and earlier wins within a rank. */
  sequence: number
  /** What this stick is owed out of the proceeds, already computed. */
  owedCents: Cents
  /** Can this holder block the operational decision? At most one may. */
  veto?: boolean
  /** For a security stick: the stick ids whose value it secures. */
  secures?: string[]
}

// ---------------------------------------------------------------------------
// 혼동 — merger
// ---------------------------------------------------------------------------

export interface MergerResult {
  sticks: Stick[]
  /** Sticks that extinguished because their holder also takes the residual. */
  merged: Array<{ stickId: string; party: string; reason: string }>
}

/**
 * 민법 191조. When a limited real right and the residual land in the same hand,
 * the limited right extinguishes — you do not hold security against yourself.
 * The article's own exception is kept: it survives where a third party holds a
 * right in it (제3자의 권리의 목적이 된 경우), because extinguishing it would
 * quietly destroy that third party's collateral.
 *
 * This is what the related-party case should have done all along. Yesterday's
 * compiler *disclosed* that B was both operator and financier; disclosure is
 * necessary and not sufficient, because B's self-financing stick was still
 * being paid ahead of everyone else out of the waterfall. It is not a claim.
 * It is B moving B's money.
 */
export function applyMerger(sticks: Stick[], residualParty: string): MergerResult {
  const securedIds = new Set<string>()
  for (const s of sticks) {
    if (!s.secures) continue
    // A third party's security over another stick keeps that stick alive.
    if (s.party !== residualParty) for (const id of s.secures) securedIds.add(id)
  }

  const merged: MergerResult['merged'] = []
  const kept = sticks.filter((s) => {
    const isLimitedRight = s.incidents.includes('security')
    if (!isLimitedRight || s.party !== residualParty) return true
    if (securedIds.has(s.id)) return true
    merged.push({
      stickId: s.id,
      party: s.party,
      reason: `security held by the residual holder (${s.party}) against themselves — extinguished by merger, not paid as a claim`,
    })
    return false
  })

  return { sticks: kept, merged }
}

// ---------------------------------------------------------------------------
// Anticommons
// ---------------------------------------------------------------------------

export interface AnticommonsFinding {
  code: 'NO_MANAGEMENT' | 'MULTIPLE_MANAGEMENT' | 'VETO_WITHOUT_MANAGEMENT'
  reason: string
}

/**
 * Fragmenting a resource among holders who can each block its use is how a
 * bundle becomes an anticommons: everybody has a right and nobody can act.
 * Exactly one stick may carry management, and nobody but that stick may veto.
 */
export function checkAnticommons(sticks: Stick[]): AnticommonsFinding[] {
  const out: AnticommonsFinding[] = []
  const managers = sticks.filter((s) => s.incidents.includes('management'))

  if (managers.length === 0) {
    out.push({
      code: 'NO_MANAGEMENT',
      reason: 'no stick carries management — nobody decides, so nothing happens and no loss has an owner',
    })
  }
  if (managers.length > 1) {
    out.push({
      code: 'MULTIPLE_MANAGEMENT',
      reason: `${managers.length} sticks carry management (${managers.map((m) => m.party).join(', ')}) — each can countermand the other and the asset idles`,
    })
  }
  for (const s of sticks) {
    if (s.veto && !s.incidents.includes('management')) {
      out.push({
        code: 'VETO_WITHOUT_MANAGEMENT',
        reason: `${s.id} (${s.party}) can block the operation without holding management — a veto with no residual is free to use`,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

export interface RankedClaim {
  stick: Stick
  rank: number
  /** True when this claim shares its rank pro rata rather than outranking it. */
  pariPassu: boolean
}

/**
 * Sort claims into payment order.
 *
 * Perfected ranks first, and within a rank by 성립 순위 — earlier wins, with
 * the stick id as a deterministic tiebreak so two sticks created in the same
 * tick never settle in map-iteration order.
 */
export function rankClaims(sticks: Stick[]): RankedClaim[] {
  return [...sticks]
    .filter((s) => s.owedCents > 0)
    .sort(
      (a, b) =>
        PERFECTION_RANK[a.perfection] - PERFECTION_RANK[b.perfection] ||
        a.sequence - b.sequence ||
        a.id.localeCompare(b.id),
    )
    .map((stick) => ({
      stick,
      rank: PERFECTION_RANK[stick.perfection],
      pariPassu: PARI_PASSU.includes(stick.perfection),
    }))
}

export interface StickPayment {
  stickId: string
  party: string
  paidCents: Cents
  shortfallCents: Cents
  rank: number
  /** How the payment was decided, for the audit panel. */
  basis: 'preferential' | 'pro-rata'
}

export interface Distribution {
  payments: StickPayment[]
  remainingCents: Cents
  /** Total owed and not paid. The residual holder absorbs this. */
  shortfallCents: Cents
}

/**
 * Pay the claims out of `proceeds`.
 *
 * Preferential ranks are paid in full in order until the money runs out.
 * Within a pari passu rank the shortfall is **shared in proportion to what
 * each is owed** (채권자평등의 원칙), not resolved by list position — which was
 * the arbitrary part of yesterday's waterfall: whoever I happened to filter
 * first was paid in full while an equal claimant got nothing.
 *
 * Rounding goes to the largest claim in the rank, and the totals are exact by
 * construction: a distribution that does not sum to the proceeds has lost a
 * cent, and the cent was somebody's.
 */
export function distribute(sticks: Stick[], proceeds: Cents): Distribution {
  const ranked = rankClaims(sticks)
  const payments: StickPayment[] = []
  let remaining = proceeds

  // Group by rank, preserving the sorted order.
  const groups: RankedClaim[][] = []
  for (const c of ranked) {
    const last = groups.at(-1)
    if (last && last[0]!.rank === c.rank) last.push(c)
    else groups.push([c])
  }

  for (const group of groups) {
    if (!group[0]!.pariPassu) {
      for (const { stick, rank } of group) {
        const paid = Math.max(0, Math.min(stick.owedCents, remaining))
        remaining -= paid
        payments.push({
          stickId: stick.id,
          party: stick.party,
          paidCents: paid,
          shortfallCents: stick.owedCents - paid,
          rank,
          basis: 'preferential',
        })
      }
      continue
    }

    const owed = group.reduce((s, c) => s + c.stick.owedCents, 0)
    const pot = Math.max(0, Math.min(owed, remaining))
    if (owed === 0) continue

    // Proportional shares, with the remainder to the largest claim so the
    // group's payments sum to `pot` exactly.
    const shares = group.map((c) => Math.floor((pot * c.stick.owedCents) / owed))
    const dust = pot - shares.reduce((s, x) => s + x, 0)
    if (dust > 0) {
      let biggest = 0
      for (let i = 1; i < group.length; i++) {
        if (group[i]!.stick.owedCents > group[biggest]!.stick.owedCents) biggest = i
      }
      shares[biggest] = shares[biggest]! + dust
    }

    group.forEach((c, i) => {
      const paid = shares[i]!
      payments.push({
        stickId: c.stick.id,
        party: c.stick.party,
        paidCents: paid,
        shortfallCents: c.stick.owedCents - paid,
        rank: c.rank,
        basis: 'pro-rata',
      })
    })
    remaining -= pot
  }

  return {
    payments,
    remainingCents: remaining,
    shortfallCents: payments.reduce((s, p) => s + p.shortfallCents, 0),
  }
}

/**
 * 물상대위. When the thing is destroyed or damaged and money arrives in its
 * place — insurance, a refund, a chargeback reversal — a security stick
 * follows that money instead of dying with the goods (민법 342·370조).
 *
 * `settle()` only ever saw revenue, so a financier whose inventory was
 * destroyed had no claim on the payout that replaced it. That is a real gap in
 * yesterday's model, found by asking what the doctrine covers that we did not.
 */
export function subrogatedClaims(sticks: Stick[], destroyedStickIds: string[]): Stick[] {
  const destroyed = new Set(destroyedStickIds)
  return sticks.filter(
    (s) => s.incidents.includes('security') && (s.secures ?? []).some((id) => destroyed.has(id)),
  )
}

/**
 * Distribute money that arrived because the thing was lost rather than sold.
 *
 * Only sticks secured on what was destroyed reach it, at their original rank
 * and sequence — subrogation moves what the security attaches to, never its
 * priority. Whatever is left over falls to the residual holder like any other
 * surplus, and a shortfall is their loss, because they chose the exposure.
 */
export function distributeLossProceeds(
  sticks: Stick[],
  destroyedStickIds: string[],
  proceedsCents: Cents,
): Distribution {
  return distribute(subrogatedClaims(sticks, destroyedStickIds), proceedsCents)
}
