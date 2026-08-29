import { NextResponse } from 'next/server'
import { commissionStatus } from '@/lib/office-storefront'

/**
 * GET /api/storefront/commission/{token} — the client's window on their
 * commission. Free, and authenticated by nothing but the unguessable token
 * (the same access model as attachment URLs — see the schema's comment):
 * the buyer may have no account, no wallet connection, nothing but the
 * receipt the purchase returned.
 *
 * Polling this drives the underlying delegation's verification tick, so an
 * impatient client is not just watching the pipeline — they are powering
 * the part of it that grades and pays.
 */
export const maxDuration = 60 // the tick this drives can touch the chain

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(token)) {
    return NextResponse.json({ error: 'Malformed token' }, { status: 400 })
  }
  const status = await commissionStatus(token)
  if (!status) return NextResponse.json({ error: 'No commission with this token' }, { status: 404 })
  return NextResponse.json(status)
}
