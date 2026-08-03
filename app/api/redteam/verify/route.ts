import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { getSession } from '@/lib/get-session'
import { redteamOriginProof } from '@/lib/db/schema'
import { CONTROL_PROOF_PATH, controlProofState, mintControlNonce, redTeamTargetKey } from '@/lib/redteam'

/**
 * Proving you control an origin, so you may authorise attacks against it.
 *
 * Two steps. `start` issues a nonce; the owner serves it at
 * /.well-known/handsel-redteam.txt; `check` fetches that file and, if the nonce
 * is there, records a proof. Nothing else in the red-team lane will name an
 * outside origin without one — see lib/redteam.ts for why that gate exists.
 *
 * This endpoint fetches a URL the caller chose, which is a server-side request
 * forgery surface, so it is narrowed to the point of being uninteresting:
 * https only (an http proof proves who is on the path, not who owns the host),
 * one fixed path the caller cannot influence, redirects NOT followed (a
 * redirect is how an attacker turns an allowed origin into an internal one), a
 * short timeout, a truncated read, and — most importantly — the response body
 * is never returned to the caller. The only thing that escapes is one boolean.
 */
export const dynamic = 'force-dynamic'

const FETCH_TIMEOUT_MS = 8000
const MAX_BODY_BYTES = 8192

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return Response.json({ error: 'Not signed in' }, { status: 401 })

  let body: { url?: string; action?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 })
  }

  const targetKey = redTeamTargetKey({ kind: 'endpoint', url: String(body.url ?? '') })
  if (!targetKey) {
    return Response.json({ error: 'Target must be an https origin, e.g. https://agent.example.com' }, { status: 400 })
  }
  const origin = targetKey.slice('endpoint:'.length)

  const { ensureRedteamTables } = await import('@/lib/db/ensure-columns')
  await ensureRedteamTables()

  const [existing] = await db
    .select()
    .from(redteamOriginProof)
    .where(and(eq(redteamOriginProof.targetKey, targetKey), eq(redteamOriginProof.userId, session.user.id)))

  if (body.action !== 'check') {
    // Issue (or re-issue) the challenge. An existing unanswered nonce is reused
    // rather than rotated, so an owner who already pasted the file into their
    // deploy does not have to do it twice.
    const nonce = existing?.nonce ?? mintControlNonce()
    if (!existing) {
      await db.insert(redteamOriginProof).values({ targetKey, userId: session.user.id, nonce })
    }
    return Response.json({
      targetKey,
      nonce,
      serveAt: `${origin}${CONTROL_PROOF_PATH}`,
      instruction: `Serve a file at ${CONTROL_PROOF_PATH} on ${origin} whose body contains exactly this nonce, then call this endpoint again with action:"check".`,
    })
  }

  if (!existing) {
    return Response.json({ error: 'No challenge issued for this origin yet', state: 'absent' }, { status: 400 })
  }

  let served = ''
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(`${origin}${CONTROL_PROOF_PATH}`, {
      signal: controller.signal,
      redirect: 'manual',
      cache: 'no-store',
      headers: { accept: 'text/plain' },
    })
    clearTimeout(timer)
    if (!res.ok) {
      return Response.json({ verified: false, reason: `The origin answered ${res.status} for ${CONTROL_PROOF_PATH}` })
    }
    served = (await res.text()).slice(0, MAX_BODY_BYTES)
  } catch {
    // Deliberately not echoing the underlying error: it can carry resolved
    // addresses and connection details for a host the caller may not own.
    return Response.json({ verified: false, reason: `Could not read ${CONTROL_PROOF_PATH} from ${origin}` })
  }

  if (!served.includes(existing.nonce)) {
    return Response.json({ verified: false, reason: 'The file did not contain the issued nonce' })
  }

  const verifiedAt = new Date()
  await db
    .update(redteamOriginProof)
    .set({ verifiedAt })
    .where(and(eq(redteamOriginProof.targetKey, targetKey), eq(redteamOriginProof.userId, session.user.id)))

  return Response.json({ verified: true, targetKey, verifiedAt: verifiedAt.toISOString() })
}

/** What we currently believe about this account's control of an origin — the
 *  three-state answer, not a boolean, so the caller can tell "never proven"
 *  from "proven and expired". */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return Response.json({ error: 'Not signed in' }, { status: 401 })

  const targetKey = redTeamTargetKey({ kind: 'endpoint', url: new URL(request.url).searchParams.get('url') ?? '' })
  if (!targetKey) return Response.json({ error: 'url must be an https origin' }, { status: 400 })

  const { ensureRedteamTables } = await import('@/lib/db/ensure-columns')
  await ensureRedteamTables()

  const [row] = await db
    .select()
    .from(redteamOriginProof)
    .where(and(eq(redteamOriginProof.targetKey, targetKey), eq(redteamOriginProof.userId, session.user.id)))

  const proof = row?.verifiedAt
    ? { targetKey, userId: session.user.id, verifiedAt: row.verifiedAt.getTime() }
    : null
  return Response.json({ targetKey, state: controlProofState(proof, Date.now()) })
}
