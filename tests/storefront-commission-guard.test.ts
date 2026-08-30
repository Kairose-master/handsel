/**
 * Defense in depth on the storefront paywall.
 *
 * The commission route's header states that middleware.ts settles payment
 * before the handler runs, and everything after that line — the x402 ledger
 * write, the hire, the on-chain escrow — is written on that assumption. It
 * was false for the whole life of the feature: the route was priced in the
 * middleware's map and absent from its `matcher`, so Next never ran the
 * middleware there and every commission was free (docs/failure-modes.md
 * §43, verified by exploiting it against the rehearsal deployment).
 *
 * Fixing the matcher closes the hole. This pins the second line of defense,
 * which is what makes the assumption falsifiable instead of load-bearing:
 * a request arriving without the header the paywall would have required did
 * not come through the paywall, and must be refused before anything is
 * spent or recorded.
 *
 * Ordering matters as much as the check. `recordX402Payment` ran
 * unconditionally and BEFORE scope validation, so during the vulnerable
 * window it wrote revenue entries for payments that never happened — the
 * ledger overstated income, which is the one thing a "no fake data" rule
 * cannot tolerate. The guard therefore has to sit above the ledger write,
 * not merely somewhere in the handler.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync('app/api/storefront/[template]/commission/route.ts', 'utf8')

describe('the commission route refuses an unpaid request on its own', () => {
  it('checks for the payment header', () => {
    expect(src).toContain("request.headers.get('x-payment')")
  })

  it('answers 402, the status a payer can act on', () => {
    const guard = src.slice(src.indexOf("if (!request.headers.get('x-payment'))"))
    expect(guard.slice(0, 600)).toContain('status: 402')
  })

  it('guards BEFORE the ledger write, so an unpaid call records no revenue', () => {
    const guardAt = src.indexOf("if (!request.headers.get('x-payment'))")
    const ledgerAt = src.indexOf('recordX402Payment')
    expect(guardAt).toBeGreaterThan(-1)
    expect(ledgerAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(ledgerAt)
  })

  it('guards BEFORE the office is commissioned, so nothing is escrowed unpaid', () => {
    expect(src.indexOf("if (!request.headers.get('x-payment'))")).toBeLessThan(src.indexOf('commissionOffice('))
  })
})
