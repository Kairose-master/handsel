/**
 * A regression pin for a defect that was invisible on every screen:
 * `openStorefront` shipped reachable from exactly ONE caller, the
 * `set_storefront` MCP handler. No server action, no route, no UI — so
 * opening the office's only autonomous sales channel required an assistant
 * with the Handsel connector loaded, and the owner sitting on their own
 * `/office` could not do it at all.
 *
 * It survived because it produced a plausible reading. Every storefront
 * template was `open: false` on every deployment, the Mail Desk answered
 * every order email with "not open for commission right now", and the whole
 * thing read as "we built a shop and nobody came" — a story about demand.
 * A closed desk looks exactly like an open desk nobody found.
 *
 * There is no way to unit-test "a human can click this". What CAN be pinned
 * is the property whose absence caused it: that the money-side capability
 * has a caller reachable from the dashboard, not only from the connector.
 * If someone later deletes the panel or the action, this fails with a reason
 * instead of the feature going quietly back to being unopenable.
 *
 * See docs/failure-modes.md §42, invariants 42-43.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const actions = readFileSync('app/actions/office.ts', 'utf8')
const page = readFileSync('app/(dashboard)/office/page.tsx', 'utf8')

describe('opening a storefront does not require the MCP connector', () => {
  it('has server actions to read and set it', () => {
    expect(actions).toContain('export async function myStorefronts')
    expect(actions).toContain('export async function setStorefrontOpen')
  })

  it('those actions call the real storefront module, not a reimplementation', () => {
    expect(actions).toContain("import('@/lib/office-storefront')")
    expect(actions).toContain('openStorefront')
    expect(actions).toContain('closeStorefront')
  })

  it('the office page MOUNTS the panel, not merely defines it', () => {
    // Asserting the bare name passes on the function declaration alone, so
    // deleting the mount leaves the test green and the panel unreachable —
    // the same "present but not wired" shape as the defect this pins.
    // Verified by deleting the mount and watching this fail.
    expect(page).toMatch(/<OfficeStorefrontPanel\b/)
    expect(page).toContain('myStorefronts')
    expect(page).toContain('setStorefrontOpen')
  })

  it('warns before the click that an unprovisioned prime cannot front escrow', () => {
    // openStorefront refuses a prime with no smart account. Surfacing that
    // in the picker is the difference between "you cannot pick this yet"
    // and a desk that opens and fails on its first paying customer.
    expect(actions).toContain('provisioned')
    expect(page).toContain('not provisioned')
  })
})
