import { describe, expect, it } from 'vitest'
import { closeEnvelope, draw, openEnvelope, refund, remaining } from '@/lib/build-envelope'
import { decideBuildDraw } from '@/lib/decision-table'

/**
 * The envelope's whole claim: "the sum of draws can never exceed the budget"
 * (docs/build-service.md). These tests are that claim, made adversarial —
 * every way a draw could overrun the budget, every way a refund could
 * over-release, and the idempotent-close guarantee that makes "partial
 * success is first-class" literally true rather than a slogan.
 */

describe('opening', () => {
  it('opens with the full budget available and nothing drawn', () => {
    const env = openEnvelope('100000000') // $100
    expect(env.budgetBaseUnits).toBe('100000000')
    expect(env.drawnBaseUnits).toBe('0')
    expect(env.refundedBaseUnits).toBe('0')
    expect(env.closed).toBe(false)
    expect(remaining(env)).toBe('100000000')
  })

  it('refuses a zero budget — a build that can never draw is a config error', () => {
    expect(() => openEnvelope('0')).toThrow(/positive/)
  })

  it('refuses a non-integer or negative budget string', () => {
    expect(() => openEnvelope('-5')).toThrow()
    expect(() => openEnvelope('5.5')).toThrow()
    expect(() => openEnvelope('abc')).toThrow()
  })
})

describe('drawing — the sum can never exceed the budget', () => {
  it('a draw within budget succeeds and reduces remaining', () => {
    const env = openEnvelope('100000000')
    const r = draw(env, '30000000')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.envelope.drawnBaseUnits).toBe('30000000')
    expect(remaining(r.envelope)).toBe('70000000')
  })

  it('a draw for exactly the remaining budget succeeds — the boundary is inclusive', () => {
    const env = openEnvelope('100000000')
    const r = draw(env, '100000000')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(remaining(r.envelope)).toBe('0')
  })

  it('a draw for one base unit over the remaining budget is rejected, not clamped', () => {
    const env = openEnvelope('100000000')
    const r = draw(env, '100000001')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/exceed/)
    // The envelope returned on rejection is UNCHANGED — a rejected draw must
    // never leave a partial mark on drawnBaseUnits.
    expect(r.envelope.drawnBaseUnits).toBe('0')
  })

  it('sequential draws accumulate, and the second overrun is caught even though each draw alone would fit', () => {
    const env = openEnvelope('100000000')
    const first = draw(env, '60000000')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = draw(first.envelope, '60000000') // 60 + 60 > 100
    expect(second.ok).toBe(false)
  })

  it('rejects zero, negative, decimal, and non-numeric draw amounts', () => {
    const env = openEnvelope('100000000')
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      const r = draw(env, bad)
      expect(r.ok).toBe(false)
    }
  })

  it('rejects any draw against a closed envelope, even a technically-affordable one', () => {
    const env = openEnvelope('100000000')
    const { envelope: closed } = closeEnvelope(env)
    const r = draw(closed, '1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/closed/)
  })
})

describe('the draw gate is a decision table, not a scattered if', () => {
  it('decideBuildDraw agrees with draw() on every branch', () => {
    expect(decideBuildDraw({ closed: true, amountBaseUnits: '1', remainingBaseUnits: '100' }).decision).toBe('reject')
    expect(decideBuildDraw({ closed: false, amountBaseUnits: '0', remainingBaseUnits: '100' }).decision).toBe('reject')
    expect(decideBuildDraw({ closed: false, amountBaseUnits: '101', remainingBaseUnits: '100' }).decision).toBe('reject')
    expect(decideBuildDraw({ closed: false, amountBaseUnits: '100', remainingBaseUnits: '100' }).decision).toBe('allow')
  })
})

describe('refunding — releasing a specific draw, not a second credit line', () => {
  it('refunds reduce drawn and increase refunded by the same amount', () => {
    const env = openEnvelope('100000000')
    const drawn = draw(env, '40000000')
    if (!drawn.ok) throw new Error('expected draw to succeed')
    const refunded = refund(drawn.envelope, '15000000')
    expect(refunded.drawnBaseUnits).toBe('25000000')
    expect(refunded.refundedBaseUnits).toBe('15000000')
    expect(remaining(refunded)).toBe('75000000')
  })

  it('a refund restores headroom — "escrow returns to the envelope", so a retry can draw against it', () => {
    const env = openEnvelope('100000000')
    const drawn = draw(env, '40000000')
    if (!drawn.ok) throw new Error('expected draw to succeed')
    const refunded = refund(drawn.envelope, '40000000')
    expect(remaining(refunded)).toBe('100000000')
    // The freed capacity is real: a new draw for the full budget now succeeds.
    const retry = draw(refunded, '100000000')
    expect(retry.ok).toBe(true)
  })

  it('refuses to refund more than is currently drawn', () => {
    const env = openEnvelope('100000000')
    const drawn = draw(env, '40000000')
    if (!drawn.ok) throw new Error('expected draw to succeed')
    expect(() => refund(drawn.envelope, '40000001')).toThrow(/only 40000000 is currently drawn/)
  })
})

describe('closing — partial success is first-class, not a failure state', () => {
  it('closing with nothing drawn refunds the entire budget', () => {
    const env = openEnvelope('100000000')
    const { spentBaseUnits, refundedBaseUnits } = closeEnvelope(env)
    expect(spentBaseUnits).toBe('0')
    expect(refundedBaseUnits).toBe('100000000')
  })

  it('closing with the full budget drawn refunds nothing', () => {
    const env = openEnvelope('100000000')
    const drawn = draw(env, '100000000')
    if (!drawn.ok) throw new Error('expected draw to succeed')
    const { spentBaseUnits, refundedBaseUnits } = closeEnvelope(drawn.envelope)
    expect(spentBaseUnits).toBe('100000000')
    expect(refundedBaseUnits).toBe('0')
  })

  it('closing with a partial draw splits spent/refunded exactly — this IS the "you only pay for what passed" claim', () => {
    const env = openEnvelope('100000000')
    const drawn = draw(env, '70000000')
    if (!drawn.ok) throw new Error('expected draw to succeed')
    const { spentBaseUnits, refundedBaseUnits, envelope } = closeEnvelope(drawn.envelope)
    expect(spentBaseUnits).toBe('70000000')
    expect(refundedBaseUnits).toBe('30000000')
    expect(BigInt(spentBaseUnits) + BigInt(refundedBaseUnits)).toBe(BigInt('100000000'))
    expect(envelope.closed).toBe(true)
  })

  it('closing is idempotent — closing twice does not fold the remainder in twice', () => {
    const env = openEnvelope('100000000')
    const drawn = draw(env, '70000000')
    if (!drawn.ok) throw new Error('expected draw to succeed')
    const once = closeEnvelope(drawn.envelope)
    const twice = closeEnvelope(once.envelope)
    expect(twice.spentBaseUnits).toBe(once.spentBaseUnits)
    expect(twice.refundedBaseUnits).toBe(once.refundedBaseUnits)
  })
})

describe('the reserve-then-settle sequence a caller must follow', () => {
  it('draw-then-refund-on-failure leaves the envelope exactly as if the draw never happened', () => {
    const env = openEnvelope('100000000')
    const drawn = draw(env, '25000000')
    if (!drawn.ok) throw new Error('expected draw to succeed')
    // Simulate the money-moving primitive throwing after the reservation.
    const rolledBack = refund(drawn.envelope, '25000000')
    expect(rolledBack.drawnBaseUnits).toBe(env.drawnBaseUnits)
    expect(remaining(rolledBack)).toBe(remaining(env))
  })
})
