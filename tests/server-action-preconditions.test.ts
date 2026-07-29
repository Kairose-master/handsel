import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A server action must not use `throw` to tell a user something they can fix.
 *
 * Next.js strips server-action error messages in production and replaces them
 * with a digest. The browser gets:
 *
 *   An error occurred in the Server Components render. The specific message is
 *   omitted in production builds to avoid leaking sensitive details.
 *
 * So `throw new Error('Set a payout wallet first')` — a perfectly clear
 * sentence — arrived as that paragraph plus `digest: '1363688840'`. Worse, the
 * client's `catch (e) { setError(e.message) }` looks like it handles this, and
 * in development it does: the message survives there. The mechanism only fails
 * where nobody is watching a console.
 *
 * Two things had to change, and this pins both:
 *
 *   1. The precondition is checked in the UI where it is knowable, so the click
 *      never happens. Withdraw-all was gated on the INPUT BOX rather than on
 *      the saved address, so typing an address and pressing Withdraw instead of
 *      Save enabled the button while the server still had nothing stored.
 *   2. Where the UI cannot know (the per-agent card never receives the payout
 *      address), the action RETURNS the failure. A returned value crosses the
 *      boundary intact.
 */

const mine = readFileSync('app/(dashboard)/mine/page.tsx', 'utf8')
const treasury = readFileSync('app/actions/treasury.ts', 'utf8')

/** Source with comments removed — a rule that matches its own explanation is
 *  not checking anything. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('the withdraw preconditions are checked where they are knowable', () => {
  it('reads the files — the parse is the test here', () => {
    expect(mine).toContain('withdrawAllEarnings')
    expect(treasury).toContain('export async function withdrawAgentEarnings')
  })

  it('gates Withdraw-all on the SAVED address, not the input box', () => {
    const src = code(mine)
    // The whole defect in one expression.
    expect(src).toMatch(/disabled=\{withdrawing \|\| !savedAddress \|\| !hasProvisionedWorker\}/)
    expect(src).not.toMatch(/disabled=\{withdrawing \|\| !address \|\| !hasProvisionedWorker\}/)
  })

  it('tracks the saved address separately from what is being typed', () => {
    const src = code(mine)
    expect(src).toContain('const [savedAddress, setSavedAddress]')
    // Seeded from the server on mount and updated from the server's echo on
    // save — never from the input, or it would drift back into the same bug.
    expect(src).toMatch(/setSavedAddress\(r\.payoutAddress \?\? ''\)/)
  })

  it('says which precondition is missing instead of just disabling', () => {
    // A disabled button with no reason is the same puzzle the digest was.
    for (const key of ['mine.payout.saveFirst', 'mine.payout.needAddress', 'mine.payout.needWorker']) {
      expect(code(mine)).toContain(key)
    }
  })

  it('translates those three in every maintained locale', () => {
    // en / ko / zh are the locales this repo keeps current; the rest lag by
    // hundreds of keys already and i18n:check reports them separately.
    const dict = readFileSync('lib/i18n-dict.ts', 'utf8')
    for (const key of ['mine.payout.saveFirst', 'mine.payout.needAddress', 'mine.payout.needWorker']) {
      const occurrences = dict.split(`'${key}':`).length - 1
      expect(occurrences, `${key} should appear in en, ko and zh`).toBe(3)
    }
  })
})

describe('the payout precondition is returned, not thrown', () => {
  it('no longer throws it from either withdraw action', () => {
    // The string that reached a user as a digest.
    expect(code(treasury)).not.toContain("throw new Error('Set a payout wallet first')")
  })

  it('returns a shape the existing client already renders', () => {
    const src = code(treasury)
    // withdrawAgentEarnings: WorkerCard reads result.error, so no client change.
    expect(src).toMatch(/result: \{[^}]*sent: 0,[^}]*error: 'Set a payout wallet on this page first'/)
    // withdrawAllEarnings: an explicit error field, because empty results alone
    // would render as "No USDC to withdraw yet" — a false statement, since
    // nothing was checked.
    expect(src).toMatch(/return \{ to: '', totalSent: 0, results: \[\], error: /)
  })

  it('has the client report that returned error before the balance messages', () => {
    const src = code(mine)
    const withdrawAll = src.slice(src.indexOf('const r = await withdrawAllEarnings()'))
    const errorAt = withdrawAll.indexOf('if (r.error)')
    const noEarningsAt = withdrawAll.indexOf('noEarnings')
    expect(errorAt).toBeGreaterThan(-1)
    expect(noEarningsAt).toBeGreaterThan(-1)
    // Order matters: "no earnings" must not be shown for a call that never ran.
    expect(errorAt).toBeLessThan(noEarningsAt)
  })
})
