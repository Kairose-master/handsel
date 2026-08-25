'use server'

/**
 * Server actions for the paper-account order UI (app/(dashboard)/office/orders).
 * See lib/kis-orders.ts's header for why this exists outside the MCP/job
 * pipeline: order placement has a real side effect, so it's only ever
 * reachable from a human clicking "Place" here — never from an agent
 * completing a job.
 */
import { getSession } from '@/lib/get-session'
import {
  setKisPaperCredentials,
  clearKisPaperCredentials,
  kisPaperCredentialsStatus,
  inquirePaperBalance,
  placePaperOrder,
  type OrderInput,
  type PaperHolding,
  type OrderResult,
} from '@/lib/kis-orders'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function saveKisPaperCredentials(input: { appKey: string; appSecret: string; cano: string; prdtCd?: string }) {
  const userId = await requireUser()
  await setKisPaperCredentials(userId, input)
}

export async function removeKisPaperCredentials() {
  const userId = await requireUser()
  await clearKisPaperCredentials(userId)
}

export async function kisCredentialsStatus() {
  const userId = await requireUser()
  return kisPaperCredentialsStatus(userId)
}

export async function kisBalance(): Promise<PaperHolding[] | { error: string }> {
  const userId = await requireUser()
  try {
    return await inquirePaperBalance(userId)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** The one function that moves anything — called only by a human clicking
 *  "Place" in the UI with numbers they typed themselves. */
export async function placeKisOrder(input: OrderInput): Promise<OrderResult | { error: string }> {
  const userId = await requireUser()
  try {
    return await placePaperOrder(userId, input)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
