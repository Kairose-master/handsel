import { describe, it, expect } from 'vitest'
import {
  admissibleRoute,
  EFFECT_CLASSES,
  INSTRUMENTS,
  INSTRUMENT_TYPES,
  INSTRUMENT_COVERAGE,
  TRADE_STATES,
  instrument,
  issuableIn,
  canIssue,
  hasStanding,
  verifierIndependence,
  missingInstruments,
  type TradeState,
} from '@/lib/trade-instruments'
import { V2_JOB_STATUS } from '@/lib/deadlines'

describe('the route table is complete and consistent', () => {
  it('describes every declared instrument exactly once', () => {
    expect(INSTRUMENTS.map((i) => i.type).sort()).toEqual([...INSTRUMENT_TYPES].sort())
    expect(new Set(INSTRUMENTS.map((i) => i.type)).size).toBe(INSTRUMENTS.length)
  })

  it('reuses the contract\u2019s own states rather than inventing a parallel set', () => {
    // A second state machine is a second thing to disagree about.
    for (const s of V2_JOB_STATUS) {
      expect(TRADE_STATES, `contract state ${s} missing from TRADE_STATES`).toContain(s)
    }
  })

  it('never advances a trade to a state the instrument is not valid in leaving', () => {
    for (const i of INSTRUMENTS) {
      if (i.advancesTo === null) continue
      expect(i.validIn.length, `${i.type} advances but is valid nowhere`).toBeGreaterThan(0)
      expect(i.validIn, `${i.type} advances to a state it is already valid in`).not.toContain(i.advancesTo)
    }
  })

  it('has a producer or an explicit note for every instrument', () => {
    for (const t of INSTRUMENT_TYPES) {
      const c = INSTRUMENT_COVERAGE[t]
      expect(c, `no coverage entry for ${t}`).toBeDefined()
      if (c.emittedBy === null) expect(c.note, `${t} is missing with no explanation`).toBeTruthy()
    }
  })
})

describe('what an instrument commits', () => {
  // The distinction Handsel had no way to express: all four of these look
  // identical today — a row that changed.
  it('binds the buyer on an order and the seller on an acknowledgement', () => {
    // An order commits the buyer's money while the seller has promised
    // nothing. That asymmetry is why they are two instruments.
    expect(instrument('order')).toMatchObject({ from: 'buyer', binds: 'issuer' })
    expect(instrument('acknowledgement')).toMatchObject({ from: 'seller', binds: 'issuer' })
  })

  it('binds nobody on an inspection', () => {
    // Evidence that moves escrow by existing is evidence the accused party
    // authored — the reasoning already in lib/dispute-policy.ts.
    expect(instrument('inspection').binds).toBe('neither')
    expect(instrument('inspection').movesValue).toBe(false)
    expect(instrument('inspection').advancesTo).toBeNull()
  })

  it('keeps money-moving instruments a small, named set', () => {
    // Knowing which documents move value is the difference between a document
    // trail and a payment system.
    const moving = INSTRUMENTS.filter((i) => i.movesValue).map((i) => i.type).sort()
    expect(moving).toEqual(['acknowledgement', 'credit_note', 'order', 'receipt'])
  })

  it('counts an acknowledgement as moving value even though nothing is paid', () => {
    // Accepting stakes the seller's own bond. A trade layer that called this
    // free would let a worker commit money it does not have — which is the
    // TransferFailed() class of defect.
    expect(instrument('acknowledgement').movesValue).toBe(true)
  })
})

describe('standing — who may issue what', () => {
  it('refuses an inspection from a party to the trade', () => {
    // The route IS the value of the verdict. An inspection from the buyer is
    // not an inspection, and nothing currently refuses one.
    expect(hasStanding('inspection', 'verifier')).toBe(true)
    expect(hasStanding('inspection', 'buyer')).toBe(false)
    expect(hasStanding('inspection', 'seller')).toBe(false)
  })

  it('refuses a receipt from the seller', () => {
    expect(hasStanding('receipt', 'escrow')).toBe(true)
    expect(hasStanding('receipt', 'seller')).toBe(false)
  })

  it('lets only the buyer order, and only the seller acknowledge', () => {
    expect(hasStanding('order', 'buyer')).toBe(true)
    expect(hasStanding('order', 'seller')).toBe(false)
    expect(hasStanding('acknowledgement', 'seller')).toBe(true)
    expect(hasStanding('acknowledgement', 'buyer')).toBe(false)
  })
})

describe('illegal transitions', () => {
  it('refuses delivery before acknowledgement', () => {
    expect(canIssue('delivery', 'Open')).toBe(false)
    expect(canIssue('delivery', 'Accepted')).toBe(true)
  })

  it('refuses acknowledgement of an order that was never placed', () => {
    expect(canIssue('acknowledgement', 'draft')).toBe(false)
  })

  it('refuses any instrument once the trade is settled', () => {
    // Completed, Cancelled and Expired are terminal: nothing legitimate is
    // issued into them, and an instrument that could be would be a way to
    // restate a closed trade.
    for (const terminal of ['Completed', 'Cancelled', 'Expired'] as TradeState[]) {
      expect(issuableIn(terminal), `${terminal} should be terminal`).toEqual([])
    }
  })

  it('allows a credit note from more states than a receipt', () => {
    // Money can be given back from places it cannot be released from — an
    // unclaimed order refunds, but it can never settle.
    const credit = instrument('credit_note').validIn
    const receipt = instrument('receipt').validIn
    expect(credit.length).toBeGreaterThan(receipt.length)
    expect(credit).toContain('Open')
    expect(receipt).not.toContain('Open')
  })
})

describe('verifier independence is a route question, not a self-declaration', () => {
  it('reports unknown when the controller cannot be resolved', () => {
    // The honest answer while Handsel has no Agent↔Operator↔Organization
    // relation. Never 'independent' — a policy string the issuer writes about
    // itself is a claim, not a guarantee.
    expect(verifierIndependence({ buyerController: 'a', sellerController: 'b', verifierController: null })).toBe('unknown')
    expect(verifierIndependence({ buyerController: null, sellerController: 'b', verifierController: 'c' })).toBe('unknown')
  })

  it('catches a verifier controlled by either party', () => {
    expect(verifierIndependence({ buyerController: 'a', sellerController: 'b', verifierController: 'a' })).toBe('conflicted')
    expect(verifierIndependence({ buyerController: 'a', sellerController: 'b', verifierController: 'b' })).toBe('conflicted')
  })

  it('passes only a third controller', () => {
    expect(verifierIndependence({ buyerController: 'a', sellerController: 'b', verifierController: 'c' })).toBe('independent')
  })

  it('catches the same controller on both sides of the trade', () => {
    // Self-dealing seen from the verifier's angle: if buyer and seller are one
    // controller, a verifier matching either is conflicted with both.
    expect(verifierIndependence({ buyerController: 'a', sellerController: 'a', verifierController: 'a' })).toBe('conflicted')
  })
})

describe('the gaps this exercise exists to surface', () => {
  it('names exactly the instruments nothing produces', () => {
    // Two of these explain failures already seen in production, one is what
    // an inter-office market needs before an office can sell anything, and
    // `authorisation` is what any capability acting on the world needs before
    // it ships.
    expect(missingInstruments().sort()).toEqual(['authorisation', 'invoice', 'quote', 'rfq'])
  })

  it('records that an award exists but only as an expiring priority', () => {
    // A desk lost four assigned reads to a stranger once the window lapsed.
    const award = INSTRUMENT_COVERAGE.award
    expect(award.emittedBy).toContain('job-reservation')
    expect(award.note).toMatch(/priority/i)
  })
})

describe('capabilities that act on the world', () => {
  // The property every instrument above was written for without saying so.
  // credit_note reads as making the buyer whole, which is true for text and
  // false the moment a capability sends an email or updates someone's CRM.
  it('refuses to sell irreversible work under verify-after-deliver', () => {
    const r = admissibleRoute('irreversible')
    expect(r.ok).toBe(false)
    expect(r.requires).toContain('authorisation')
    expect(r.why).toMatch(/credit note|money and not the world/i)
  })

  it('allows reversible and observational work on the ordinary route', () => {
    for (const e of ['reversible', 'observational'] as const) {
      expect(admissibleRoute(e).ok, e).toBe(true)
      expect(admissibleRoute(e).requires).toEqual([])
    }
  })

  it('has an answer for every declared effect class', () => {
    // A class added and not handled would default to admissible, which is the
    // permissive direction and the wrong one.
    for (const e of EFFECT_CLASSES) expect(() => admissibleRoute(e)).not.toThrow()
  })
})

describe('the authorisation instrument', () => {
  it('runs buyer → seller and binds the buyer', () => {
    // It moves the decision to the party that can still change its mind,
    // while changing its mind is still possible — so the buyer owns the
    // consequences of what it authorised.
    expect(instrument('authorisation')).toMatchObject({ from: 'buyer', to: 'seller', binds: 'issuer' })
  })

  it('is issuable only against a delivered plan, never before one', () => {
    // Authorising in Open or Accepted would be a blank cheque: there is
    // nothing yet to have inspected.
    expect(canIssue('authorisation', 'Submitted')).toBe(true)
    for (const s of ['draft', 'Open', 'Accepted'] as const) {
      expect(canIssue('authorisation', s), s).toBe(false)
    }
  })

  it('sits alongside inspection rather than replacing it', () => {
    // The plan is inspected by someone independent; the buyer then decides.
    // Collapsing the two would let a buyer authorise unreviewed work, or a
    // verifier commit the buyer.
    expect(instrument('inspection').validIn).toContain('Submitted')
    expect(instrument('authorisation').from).not.toBe(instrument('inspection').from)
  })

  it('moves no value itself', () => {
    expect(instrument('authorisation').movesValue).toBe(false)
    expect(instrument('authorisation').advancesTo).toBeNull()
  })

  it('is recorded as not yet produced, with the reason', () => {
    expect(INSTRUMENT_COVERAGE.authorisation.emittedBy).toBeNull()
    expect(INSTRUMENT_COVERAGE.authorisation.note).toMatch(/un-send|Zapier|world/i)
  })
})
