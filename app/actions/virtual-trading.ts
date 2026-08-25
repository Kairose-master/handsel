'use server'

/**
 * Server actions for Handsel's own account-less paper trading ledger — see
 * lib/virtual-trading.ts's header. This is the zero-setup default on
 * /office/orders; lib/kis-orders.ts (a real KIS paper account) is the
 * opt-in "Advanced" path on the same page.
 */
import { getSession } from '@/lib/get-session'
import { virtualPortfolio, placeVirtualOrder, type VirtualOrderInput, type VirtualPortfolio, type VirtualOrderResult } from '@/lib/virtual-trading'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function myVirtualPortfolio(): Promise<VirtualPortfolio | { error: string }> {
  const userId = await requireUser()
  try {
    return await virtualPortfolio(userId)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function placeMyVirtualOrder(input: VirtualOrderInput): Promise<VirtualOrderResult | { error: string }> {
  const userId = await requireUser()
  try {
    return await placeVirtualOrder(userId, input)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
