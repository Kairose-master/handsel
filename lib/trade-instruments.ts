/**
 * The instruments of a trade: which document moves it, who may issue that
 * document, and to whom.
 *
 * Handsel collapses a whole commercial sequence into four verbs — post,
 * accept, submit, settle. That is enough to move money and not enough to say
 * what happened. Real commerce does not work in verbs; it works in
 * INSTRUMENTS, each with an issuer, a recipient, and an effect the other
 * party can rely on:
 *
 *   an order is not a request, an acknowledgement is not a delivery, an
 *   inspection certificate is not an invoice, and a credit note is not a
 *   refusal to pay.
 *
 * Naming them buys three things this codebase currently lacks.
 *
 * **A route.** Every instrument has a direction. `inspection` runs
 * verifier → both parties, and the fact that it runs FROM someone who is
 * neither of them is the entire value of the verdict. When the same fact is
 * just "the grader wrote a row", that property is invisible and nothing
 * checks it.
 *
 * **A legal effect, separated from a state change.** `acknowledgement` binds
 * the SELLER only; `order` binds the BUYER only; `inspection` binds NEITHER —
 * it is evidence, and evidence that binds is evidence the accused party
 * authored (the reasoning already in lib/dispute-policy.ts). Today all four
 * look identical: a row that changed.
 *
 * **A gap list you can read.** Mapping each instrument onto what Handsel
 * actually emits makes the missing ones obvious rather than theoretical, and
 * three of them are missing. See INSTRUMENT_COVERAGE.
 *
 * This is a re-ordering, not a new system. Nothing here writes state; every
 * instrument is projected from a fact that already exists on-chain or in
 * job_specs, in the same way lib/agent-contract.ts projects the agreement.
 */

/** Where a trade is. The contract's own vocabulary, not a parallel one — a
 *  second state machine is a second thing to disagree about. */
export const TRADE_STATES = [
  'draft',
  'Open',
  'Accepted',
  'Submitted',
  'Completed',
  'Refunded',
  'Disputed',
  'Cancelled',
  'Expired',
] as const
export type TradeState = (typeof TRADE_STATES)[number]

export type PartyRole = 'buyer' | 'seller' | 'verifier' | 'escrow' | 'arbiter' | 'market'

export const INSTRUMENT_TYPES = [
  'rfq',
  'quote',
  'order',
  'acknowledgement',
  'delivery',
  'inspection',
  'invoice',
  'receipt',
  'credit_note',
  'dispute',
  'award',
] as const
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number]

/**
 * Who the instrument commits.
 *
 * The distinction that matters most, and the one Handsel has no way to
 * express today. An `order` commits the buyer's money and asks nothing of a
 * seller who has not answered. An `inspection` commits nobody — it is a
 * finding, and a finding that moved escrow by existing would be a verdict its
 * subject could have authored.
 */
export type Binds = 'issuer' | 'both' | 'neither'

export type Instrument = {
  type: InstrumentType
  /** Plain-language name, the one a person would use for the paper form. */
  label: string
  from: PartyRole
  to: PartyRole
  binds: Binds
  /** Does issuing this move money? Only four of eleven do, and knowing which
   *  is the difference between a document trail and a payment system. */
  movesValue: boolean
  /** States in which this may legitimately be issued. */
  validIn: readonly TradeState[]
  /** Where the trade is once it has been. `null` = it records something
   *  without advancing the trade, which is true of most real paperwork. */
  advancesTo: TradeState | null
}

/**
 * The route table. Order is the commercial sequence, not an enum's.
 */
export const INSTRUMENTS: readonly Instrument[] = [
  {
    type: 'rfq',
    label: 'Request for quote',
    from: 'buyer',
    to: 'market',
    binds: 'neither',
    movesValue: false,
    validIn: ['draft'],
    advancesTo: null,
  },
  {
    type: 'quote',
    label: 'Quotation',
    from: 'seller',
    to: 'buyer',
    // Binds the issuer: a quote a seller may walk away from is not a quote,
    // it is an opinion. This is what makes a priced capability sellable.
    binds: 'issuer',
    movesValue: false,
    validIn: ['draft'],
    advancesTo: null,
  },
  {
    type: 'award',
    label: 'Award / assignment to a named seller',
    from: 'buyer',
    to: 'seller',
    binds: 'neither',
    movesValue: false,
    // Reservation happens at posting time; the award is the record of WHO the
    // work was meant for, which survives the priority window expiring.
    validIn: ['draft', 'Open'],
    advancesTo: null,
  },
  {
    type: 'order',
    label: 'Purchase order',
    from: 'buyer',
    to: 'seller',
    // The buyer's money is committed the moment this exists. The seller has
    // promised nothing yet — which is exactly why `acknowledgement` is a
    // separate instrument and not a formality.
    binds: 'issuer',
    movesValue: true,
    validIn: ['draft'],
    advancesTo: 'Open',
  },
  {
    type: 'acknowledgement',
    label: 'Order acknowledgement',
    from: 'seller',
    to: 'buyer',
    binds: 'issuer',
    // Accepting stakes the seller's own bond (lib/agent-bond.ts), so this is
    // a money-moving instrument even though nothing is being paid.
    movesValue: true,
    validIn: ['Open'],
    advancesTo: 'Accepted',
  },
  {
    type: 'delivery',
    label: 'Delivery note',
    from: 'seller',
    to: 'buyer',
    binds: 'issuer',
    movesValue: false,
    validIn: ['Accepted'],
    advancesTo: 'Submitted',
  },
  {
    type: 'inspection',
    label: 'Inspection certificate',
    from: 'verifier',
    to: 'market',
    // Binds NEITHER party. It is evidence. Escrow moves on the deadline or on
    // an approval, never on the finding by itself — see lib/dispute-policy.ts.
    binds: 'neither',
    movesValue: false,
    validIn: ['Submitted', 'Disputed'],
    advancesTo: null,
  },
  {
    type: 'invoice',
    label: 'Invoice',
    from: 'seller',
    to: 'buyer',
    binds: 'issuer',
    movesValue: false,
    validIn: ['Submitted'],
    advancesTo: null,
  },
  {
    type: 'receipt',
    label: 'Settlement receipt',
    from: 'escrow',
    to: 'market',
    binds: 'both',
    movesValue: true,
    validIn: ['Submitted', 'Disputed'],
    advancesTo: 'Completed',
  },
  {
    type: 'credit_note',
    label: 'Credit note (refund)',
    from: 'escrow',
    to: 'buyer',
    binds: 'both',
    movesValue: true,
    validIn: ['Open', 'Accepted', 'Submitted', 'Disputed'],
    advancesTo: 'Refunded',
  },
  {
    type: 'dispute',
    label: 'Notice of dispute',
    from: 'buyer',
    to: 'arbiter',
    binds: 'neither',
    movesValue: false,
    validIn: ['Submitted'],
    advancesTo: 'Disputed',
  },
]

const BY_TYPE = new Map(INSTRUMENTS.map((i) => [i.type, i]))

export function instrument(type: InstrumentType): Instrument {
  const found = BY_TYPE.get(type)
  if (!found) throw new Error(`unknown instrument ${type}`)
  return found
}

/** What may legitimately be issued from here. The doc's "illegal transition"
 *  rule, expressed once rather than re-derived at each call site. */
export function issuableIn(state: TradeState): Instrument[] {
  return INSTRUMENTS.filter((i) => i.validIn.includes(state))
}

export function canIssue(type: InstrumentType, state: TradeState): boolean {
  return instrument(type).validIn.includes(state)
}

/**
 * Does the claimed issuer have standing?
 *
 * The check the route exists for. An inspection from the buyer is not an
 * inspection, and a receipt from the seller is not a receipt — both are
 * common, both look like ordinary rows, and neither is currently refused
 * anywhere.
 */
export function hasStanding(type: InstrumentType, issuer: PartyRole): boolean {
  return instrument(type).from === issuer
}

/**
 * Verifier independence, as a route question rather than a policy string.
 *
 * The design doc asks for `independencePolicy: "not-buyer-or-seller"` inside
 * the proof envelope — but a policy the issuer writes about itself is a
 * claim, not a guarantee. This asks the only version that can be checked:
 * does the verifier's economic controller differ from both parties'?
 *
 * `controllerOf` is supplied by the caller because Handsel cannot answer it
 * yet: an agent has a wallet and a userId, and no Agent↔Operator↔Organization
 * relation. Until that exists this returns 'unknown', which is the honest
 * answer and NOT 'independent'.
 */
export type Independence = 'independent' | 'conflicted' | 'unknown'

export function verifierIndependence(input: {
  buyerController: string | null
  sellerController: string | null
  verifierController: string | null
}): Independence {
  const { buyerController, sellerController, verifierController } = input
  if (verifierController === null) return 'unknown'
  if (buyerController === null || sellerController === null) return 'unknown'
  return verifierController === buyerController || verifierController === sellerController
    ? 'conflicted'
    : 'independent'
}

/**
 * Which instruments Handsel actually emits today, and which are names for
 * something nothing produces yet.
 *
 * The point of the exercise. Written down here rather than left to be
 * rediscovered, because two of the gaps explain failures already observed in
 * production, and the third is the one the inter-office market needs.
 */
export const INSTRUMENT_COVERAGE: Record<
  InstrumentType,
  { emittedBy: string | null; note?: string }
> = {
  rfq: {
    emittedBy: null,
    note: 'No request phase exists. A job is posted already escrowed, so a buyer cannot ask what something costs before committing money.',
  },
  quote: {
    emittedBy: null,
    note: 'No seller-side offer. Prices are set by the buyer alone, which is why a capability cannot be listed for sale by the office that provides it.',
  },
  award: {
    emittedBy: 'lib/job-reservation.ts (reserveJobForAgent)',
    note: 'Exists, but only as claim PRIORITY with a window. Nothing records the award as a durable fact, which is how a desk lost four assigned reads to a stranger once the window lapsed.',
  },
  order: { emittedBy: 'postJob — lib/onchain/labor-v2.ts' },
  acknowledgement: { emittedBy: 'acceptJob — lib/labor-dispatch.ts' },
  delivery: { emittedBy: 'submitWork — lib/labor-settle.ts' },
  inspection: { emittedBy: 'lib/job-grade.ts, lib/test-suite-grading.ts' },
  invoice: {
    emittedBy: null,
    note: 'Amounts are fixed at order time and never restated by the seller, so there is nothing to reconcile against and no way to bill for less than was escrowed.',
  },
  receipt: { emittedBy: 'approveJob / expireReview — lib/labor-settle.ts' },
  credit_note: { emittedBy: 'expireReview, expireOpen, resolveDispute' },
  dispute: { emittedBy: 'raiseDispute — lib/onchain/labor.ts' },
}

/** The instruments with no producer. */
export function missingInstruments(): InstrumentType[] {
  return INSTRUMENT_TYPES.filter((t) => INSTRUMENT_COVERAGE[t].emittedBy === null)
}
