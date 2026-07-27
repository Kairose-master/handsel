import { setFaucetOwnerAnthropicKey, setFaucetOwnerOpenAiKey } from '@/lib/job-faucet'

/**
 * Attach an Anthropic key to the house faucet account so house-posted image
 * jobs can be vision-graded (and text jobs LLM-graded) without a per-requester
 * key. The key is read from the POST body — never the URL — so it does not
 * land in access logs, and it is stored encrypted (encryptSecret). The
 * response returns only the last 4 chars for confirmation.
 *
 * Auth: same shared secret as the settlement heartbeat —
 *   Authorization: Bearer <CRON_SECRET>   (a secret in the URL is refused)
 *
 * Usage:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/admin/set-faucet-key" \
 *     -H 'content-type: application/json' -d '{"key":"sk-ant-..."}'
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const { requireOperator } = await import('@/lib/admin-route')
  const auth = requireOperator(request, { mutating: true })
  if (!auth.ok) return auth.response
  const url = new URL(request.url)

  let anthropicKey = ''
  let groqKey = ''
  let hfToken = ''
  try {
    const body = await request.json()
    anthropicKey = String(body?.key ?? body?.anthropicKey ?? '')
    groqKey = String(body?.groqKey ?? body?.openaiKey ?? '')
    hfToken = String(body?.hfToken ?? body?.hf ?? '')
  } catch {
    return Response.json({ error: 'body must be JSON: {"key":"sk-ant-..."} / {"groqKey":"gsk_..."} / {"hfToken":"hf_..."}' }, { status: 400 })
  }
  if (!anthropicKey && !groqKey && !hfToken) {
    return Response.json({ error: 'provide "key" (Anthropic), "groqKey" (Groq/Whisper), and/or "hfToken" (Hugging Face)' }, { status: 400 })
  }

  const email = url.searchParams.get('email') ?? undefined // defaults to the faucet account
  const stored: Record<string, string> = {}
  try {
    if (anthropicKey) stored.anthropicEndsWith = (await setFaucetOwnerAnthropicKey(anthropicKey, email)).keyTail
    if (groqKey) stored.groqEndsWith = (await setFaucetOwnerOpenAiKey(groqKey, undefined, undefined, email)).keyTail
    if (hfToken) {
      // Platform-wide (server-side HF image generation), not per-account.
      const { setPlatformSecret } = await import('@/lib/platform-secret')
      await setPlatformSecret('hf_token', hfToken.trim())
      stored.hfEndsWith = hfToken.trim().slice(-4)
    }
    return Response.json({ status: 'ok', storedFor: email ?? 'faucet@ledgermind.internal', ...stored })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
