/**
 * Evidence assurance → remedy ceiling.
 *
 * Increment 1 of `docs/coordination-layer.md`, and the smallest piece of it
 * that makes money already live on mainnet safer. No new runtime, no new
 * contract: one pure model plus a ceiling the dispute path consults.
 *
 * ## The problem it fixes, in one sentence
 *
 * `lib/dispute-gate.ts` can move real USDC away from a worker on grounds that
 * are not all equally knowable, and nothing in the system says so. A refund on
 * "the delivered bytes do not match the hash committed on-chain" is a fact any
 * stranger can recompute; a refund on "no output and no artifact was ever
 * submitted" is the platform reporting the absence of rows in its own database
 * — while the platform is itself a market participant (`/participation`
 * discloses operator-posted jobs). Both currently move the same money.
 *
 * ## Prior art: RAILS got here first, and we should say so
 *
 * RAILS — *Verification-Native Clearing For Agentic Commerce*, arXiv 2606.08790,
 * 7 June 2026 — states the rule this module enforces, two months before this
 * file existed:
 *
 *   "no financially material settlement is supported by evidence below the
 *    obligation's admissibility floor"
 *
 * That is `MIN_CLASS_FOR_MONEY` in one sentence, and the paper claims the
 * novelty explicitly ("We are not aware of a prior agent-commerce verification
 * mechanism that states a property of this kind"). This module was built
 * without knowledge of it; that makes it convergent, not original, and the
 * honest word for the overlap is prior art.
 *
 * Where the two diverge is narrow and real, and it is worth stating precisely
 * rather than claiming a gap that is not there. RAILS decides **whether this
 * settlement may execute**. It treats collateral as an obligation parameter —
 * "hold the $500 collateral pending the 24h appeal window" — and scopes credit
 * out entirely; the Clearing Passport is noted as feeding "future obligation
 * underwriting". It specifies no slashing, no secured priority, no lien.
 *
 * Handsel asks the next question down: given this evidence, **may the
 * collateral be charged at all?** A bond you cannot take for a loss you cannot
 * prove is not security, and `lib/enterprise-graph.ts` follows that through to
 * refusing a capital structure outright (`THIRD_PARTY_CAPITAL_UNSECURED`,
 * `SENIOR_BUT_UNRECOVERABLE`). Their floor governs a payment. Ours governs
 * whether a financing arrangement may exist.
 *
 * ## Why a vector and not a rank
 *
 * The obvious model is a single ladder — supervisor log beats CI beats LLM.
 * It is wrong, because "how much should I trust this" is at least five
 * questions that come apart:
 *
 *   reproducibility  can a stranger re-derive it from public inputs?
 *   independence     is the issuer disinterested in the outcome?
 *   tamperResistance is it signed / hash-chained / on-chain?
 *   coverage         did the observer's boundary actually include this event?
 *   subjectControl   could the party this is ABOUT have shaped it?
 *
 * A platform supervisor log scores high on tamper resistance and low on
 * independence. A requester's own CI scores high on reproducibility and
 * middling on independence. Collapsing those to one number destroys exactly
 * the distinction that decides whether it may take someone's money.
 *
 * ## Why the class is a POLICY hierarchy, not a truth hierarchy
 *
 * E4 is not "more true" than E2. E4 is *"this may justify a deterministic
 * settlement"* and E2 is *"this may justify a reversible remedy"*. The class
 * answers one question only: **what is the strongest remedy this evidence is
 * allowed to buy?** Getting that backwards is how a system ends up arguing
 * about metaphysics when it should be bounding a payout.
 */

/** All dimensions are 0..3. Four of them are "higher is better"; see
 *  `subjectControl`, which is deliberately not. */
export type Score = 0 | 1 | 2 | 3

export interface EvidenceAssurance {
  /** Can an outsider re-derive this from public inputs? 3 = anyone with the
   *  chain and the brief gets the same answer. */
  reproducibility: Score
  /** Is the issuer disinterested? 3 = a party with nothing to gain either way. */
  independence: Score
  /** Signed, hash-chained, or on-chain? 3 = altering it after the fact is
   *  detectable. */
  tamperResistance: Score
  /** Did the observer's declared boundary actually contain this event? 3 = the
   *  event is squarely inside what this observer can see. A supervisor that
   *  only mediates cross-container calls has coverage 0 for anything that
   *  happened inside a container, and must say so. */
  coverage: Score
  /**
   * **Inverted, on purpose.** How much the party this evidence is ABOUT could
   * have shaped it. 3 = they authored it; 0 = they could not touch it.
   *
   * Kept at this polarity because the published receipt format
   * (`docs/action-receipt-v0.1.md`) uses the same field name, and a spec whose
   * field means the opposite of the implementation is a defect waiting to be
   * copied. The inversion is handled once, here, and pinned by a test.
   */
  subjectControl: Score
}

/** Who issued the evidence, relative to the dispute it is offered in. */
export type IssuerRelationship = 'INDEPENDENT' | 'PLATFORM' | 'COUNTERPARTY' | 'SELF' | 'UNKNOWN'

/**
 * The compiled class. Ordinal, and the ordering is about permitted remedies.
 *
 * E0 claim only — someone asserted it
 * E1 single-party attested — one interested party signed it
 * E2 mechanically evidenced — a machine produced it, checkable in principle
 * E3 independently corroborated — a disinterested party stands behind it
 * E4 independently reproducible — a stranger can re-derive it and get the same answer
 */
export type EvidenceClass = 'E0' | 'E1' | 'E2' | 'E3' | 'E4'

export const EVIDENCE_CLASSES: EvidenceClass[] = ['E0', 'E1', 'E2', 'E3', 'E4']
export const classRank = (c: EvidenceClass): number => EVIDENCE_CLASSES.indexOf(c)

/**
 * What a remedy can be, weakest to strongest. Everything at or below
 * `REVERSIBLE_REMEDY` is undoable or costs nobody money.
 */
export type Remedy =
  | 'NONE'
  | 'REPUTATION_NOTE'
  | 'CAPABILITY_RESTRICTION'
  | 'REVERSIBLE_REMEDY'
  | 'BOUNDED_RESTITUTION'
  | 'DETERMINISTIC_SETTLEMENT'

export const REMEDIES: Remedy[] = [
  'NONE',
  'REPUTATION_NOTE',
  'CAPABILITY_RESTRICTION',
  'REVERSIBLE_REMEDY',
  'BOUNDED_RESTITUTION',
  'DETERMINISTIC_SETTLEMENT',
]
export const remedyRank = (r: Remedy): number => REMEDIES.indexOf(r)

/** The line this whole file exists to draw: which remedies take someone's
 *  money. Below it, being wrong is recoverable; above it, it is not. */
export function movesMoney(r: Remedy): boolean {
  return remedyRank(r) >= remedyRank('BOUNDED_RESTITUTION')
}

/** Class → the strongest remedy it may justify ON ITS OWN. */
export const REMEDY_CEILING: Record<EvidenceClass, Remedy> = {
  E0: 'REPUTATION_NOTE',
  E1: 'REPUTATION_NOTE',
  E2: 'REVERSIBLE_REMEDY',
  E3: 'BOUNDED_RESTITUTION',
  E4: 'DETERMINISTIC_SETTLEMENT',
}

/**
 * The lowest class that is allowed to move money at all. Stated as its own
 * constant because it is the invariant the tests defend: **nothing below E3
 * may take a counterparty's funds, no matter how many weak signals agree.**
 * Semantic judgment — an LLM saying "A appears to have obstructed B" — cannot
 * exceed E1 by construction, so this is the rule that keeps a hallucination
 * from being a payout.
 */
export const MIN_CLASS_FOR_MONEY: EvidenceClass = 'E3'

/**
 * Compile the vector (plus who issued it) into a class.
 *
 * ## The rescue rule, which is the load-bearing part
 *
 * A related-party issuer normally caps the class: you cannot corroborate
 * yourself, and a platform that is also a market participant cannot be its own
 * disinterested witness. But **reproducibility rescues the issuer**, because a
 * reader who can re-derive the claim from public inputs does not have to trust
 * whoever handed it to them.
 *
 * That is not a loophole, it is the reason on-chain commitments are worth
 * having: `hashMismatch` is reported by the platform and is still E4, because
 * anyone with the brief and the chain gets the same answer. Meanwhile "our
 * database has no rows for this task" is also reported by the platform and is
 * NOT E4, because nobody outside can check it.
 */
export function compileClass(a: EvidenceAssurance, issuer: IssuerRelationship): EvidenceClass {
  // Inversion handled exactly once (see EvidenceAssurance.subjectControl).
  const subjectIndependence = (3 - a.subjectControl) as Score

  let cls: EvidenceClass
  if (a.reproducibility >= 3 && a.independence >= 2 && subjectIndependence >= 2) cls = 'E4'
  else if (a.independence >= 2 && a.tamperResistance >= 2 && subjectIndependence >= 2) cls = 'E3'
  else if (a.reproducibility >= 2 || (a.tamperResistance >= 2 && a.coverage >= 2)) cls = 'E2'
  else if (a.tamperResistance >= 1 || a.coverage >= 1) cls = 'E1'
  else cls = 'E0'

  // Coverage 0 means the observer's own boundary did not contain the event.
  // Whatever else the evidence has going for it, it is then a claim about
  // something this issuer could not see.
  if (a.coverage === 0 && classRank(cls) > classRank('E1')) cls = 'E1'

  const reproducible = a.reproducibility >= 3
  if (!reproducible) {
    if (issuer === 'SELF' || issuer === 'COUNTERPARTY') cls = capAt(cls, 'E1')
    else if (issuer === 'PLATFORM' || issuer === 'UNKNOWN') cls = capAt(cls, 'E2')
  }
  return cls
}

function capAt(cls: EvidenceClass, ceiling: EvidenceClass): EvidenceClass {
  return classRank(cls) > classRank(ceiling) ? ceiling : cls
}

export interface CappedRemedy {
  remedy: Remedy
  /** True when the proposal was stronger than the evidence could carry. */
  capped: boolean
  evidenceClass: EvidenceClass
  reason: string
}

/**
 * Apply the ceiling to a proposed remedy.
 *
 * Returns the remedy that may actually be executed. When it caps, the reason
 * names both the class and what was asked for — a party told "denied" with no
 * reason cannot produce better evidence next time, and producing better
 * evidence is the behaviour this whole model is trying to buy.
 */
export function capRemedy(proposed: Remedy, evidenceClass: EvidenceClass): CappedRemedy {
  const ceiling = REMEDY_CEILING[evidenceClass]
  if (remedyRank(proposed) <= remedyRank(ceiling)) {
    return { remedy: proposed, capped: false, evidenceClass, reason: `${evidenceClass} permits ${proposed}` }
  }
  return {
    remedy: ceiling,
    capped: true,
    evidenceClass,
    reason:
      `${proposed} requires stronger evidence than ${evidenceClass}; ` +
      `the strongest remedy this evidence may justify is ${ceiling}`,
  }
}

/** Convenience for the money question, which is the one most call sites ask. */
export function mayMoveMoney(evidenceClass: EvidenceClass): boolean {
  return classRank(evidenceClass) >= classRank(MIN_CLASS_FOR_MONEY)
}

// ---------------------------------------------------------------------------
// The assurance profile of each ground the live dispute gate can rule on
// ---------------------------------------------------------------------------

/**
 * Every refund ground in `lib/decision-table.ts`, scored honestly.
 *
 * These are claims about THIS deployment, not universal truths: they describe
 * what the platform can actually show for each ground today. If a ground later
 * gains an independent witness (an external runtime's ActionReceipt, a second
 * grader), its profile changes here and the ceiling follows automatically.
 */
export const GROUND_ASSURANCE: Record<
  string,
  { assurance: EvidenceAssurance; issuer: IssuerRelationship; note: string }
> = {
  /**
   * The bytes do not match the hash committed on-chain.
   *
   * The strongest thing this market can produce: the commitment is on a public
   * chain, the brief is published, and the comparison is a hash. The platform
   * reports it and that does not matter — anyone can rerun it.
   */
  SUBSTITUTED: {
    assurance: { reproducibility: 3, independence: 2, tamperResistance: 3, coverage: 3, subjectControl: 0 },
    issuer: 'PLATFORM',
    note: 'on-chain commitment vs published brief — recomputable by any stranger',
  },

  /**
   * The artifact type contradicts the sealed brief.
   *
   * Mechanical and reproducible from the same sealed brief, but it reads a
   * MIME the platform recorded at upload time rather than a chain commitment,
   * so a stranger cannot fully re-derive it.
   */
  WRONG_KIND: {
    assurance: { reproducibility: 2, independence: 2, tamperResistance: 2, coverage: 3, subjectControl: 1 },
    issuer: 'PLATFORM',
    note: 'sealed brief verified; artifact MIME as recorded by the platform',
  },

  /**
   * Platform-authored reference tests failed.
   *
   * Deterministic and re-runnable by anyone who has the suite, which is why
   * `authorOfRule` already refuses to accept a requester-authored rule here.
   */
  PLATFORM_TESTS_FAIL: {
    assurance: { reproducibility: 3, independence: 2, tamperResistance: 2, coverage: 3, subjectControl: 0 },
    issuer: 'PLATFORM',
    note: 'platform-authored reference suite — deterministic and re-runnable',
  },

  /**
   * No output and no artifact was ever submitted.
   *
   * The honest one, and the reason this file exists. It is the platform
   * asserting the ABSENCE of rows in its own database. There is nothing to
   * recompute, no external witness, and the asserting party is a participant
   * in the market. Mechanically checked, but only by us.
   *
   * Under the ceiling this can restrict capability or trigger a reversible
   * remedy; it can no longer, on its own, take a worker's escrow.
   */
  NO_DELIVERABLE: {
    assurance: { reproducibility: 0, independence: 1, tamperResistance: 1, coverage: 3, subjectControl: 0 },
    issuer: 'PLATFORM',
    note: 'absence of rows in the platform’s own database — no external witness exists',
  },

  NONE: {
    assurance: { reproducibility: 0, independence: 0, tamperResistance: 0, coverage: 0, subjectControl: 0 },
    issuer: 'UNKNOWN',
    note: 'no ground',
  },
}

/** The class of a named refund ground, or E0 for a ground with no profile —
 *  an unmodelled ground must not inherit somebody else's strength. */
export function classOfGround(ground: string): EvidenceClass {
  const profile = GROUND_ASSURANCE[ground]
  if (!profile) return 'E0'
  return compileClass(profile.assurance, profile.issuer)
}
