import { db } from '@/lib/db'
import { oauthClient } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/get-session'
import { AuthorizeForm } from './authorize-form'

/**
 * OAuth consent screen for MCP connectors (Claude / ChatGPT / any MCP
 * client). Reached via a redirect from the connector with the standard
 * authorization-request query params. The user sees exactly what they're
 * granting before any token exists.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const q = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '')

  const clientId = q('client_id')
  const redirectUri = q('redirect_uri')
  const problem = await validate(clientId, redirectUri, q('response_type'), q('code_challenge_method'))

  const session = await getSession()
  const clientName = problem ? '' : (await db.select().from(oauthClient).where(eq(oauthClient.id, clientId)))[0]?.name ?? ''

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <h1 className="mb-1 text-2xl font-bold">Connect to Handsel</h1>
      {problem ? (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{problem}</p>
      ) : (
        <AuthorizeForm
          clientName={clientName || 'An MCP client'}
          sessionEmail={session?.user?.email ?? null}
          fields={{
            client_id: clientId,
            redirect_uri: redirectUri,
            state: q('state'),
            code_challenge: q('code_challenge'),
            scope: q('scope') || 'mcp',
          }}
        />
      )}
    </div>
  )
}

async function validate(clientId: string, redirectUri: string, responseType: string, challengeMethod: string) {
  if (!clientId || !redirectUri) return 'Malformed authorization request (client_id / redirect_uri missing).'
  if (responseType !== 'code') return 'Only response_type=code is supported.'
  if (challengeMethod && challengeMethod !== 'S256') return 'Only PKCE S256 is supported.'
  const [client] = await db.select().from(oauthClient).where(eq(oauthClient.id, clientId))
  if (!client) return 'Unknown connector — it must register first (dynamic client registration).'
  if (!client.redirectUris.includes(redirectUri)) return 'redirect_uri is not registered for this connector.'
  return null
}
