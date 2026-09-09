import { db } from '@/lib/db'
import { oauthClient } from '@/lib/db/schema'
import { nanoid } from 'nanoid'
import { isAllowedRedirectUri } from '@/lib/oauth'

/**
 * Dynamic Client Registration (RFC 7591) — Claude/ChatGPT connectors call
 * this once, unauthenticated, to obtain a client_id before the first
 * authorize. Public clients only: no secret is issued, PKCE is mandatory
 * at the token endpoint, and nothing here grants any account access — a
 * registered client still gets nowhere without a user approving it on
 * /oauth/authorize with their own credentials.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const redirectUris = Array.isArray(body?.redirect_uris)
    ? body.redirect_uris.map((u: unknown) => String(u)).filter(isAllowedRedirectUri)
    : []
  if (redirectUris.length === 0) {
    return Response.json({ error: 'invalid_client_metadata', error_description: 'redirect_uris (https, or http on a loopback address) required' }, { status: 400 })
  }
  const name = String(body?.client_name ?? 'MCP client').slice(0, 100)

  const id = `mcpc_${nanoid(16)}`
  await db.insert(oauthClient).values({ id, name, redirectUris })

  return Response.json(
    {
      client_id: id,
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
    { status: 201 },
  )
}
