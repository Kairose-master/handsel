import { postHouseImageJobs, postHouseAudioJobs, postHouseCodeJobs } from '@/lib/job-faucet'
import { requireOperator } from '@/lib/admin-route'

/**
 * Post a handful of vision-graded image jobs from the house faucet wallet,
 * on demand. This is the "give me some image work to mine right now" button
 * for testing the image lane end-to-end (generate → vision grade → pay/refund).
 *
 * Auth: same shared secret as the settlement heartbeat —
 *   Authorization: Bearer <CRON_SECRET>   (a secret in the URL is refused)
 * With CRON_SECRET unset the endpoint refuses, so it can never post money
 * moves from an unauthenticated call.
 *
 * POST only — this escrows real bounties, and a GET side effect fires on any
 * prefetch (see lib/admin-route.ts). A GET answers 405 with the curl to run.
 *
 * Usage:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/admin/post-image-jobs?count=3"
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function handle(request: Request): Promise<Response> {
  const auth = requireOperator(request, { mutating: true })
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  const count = Math.max(1, Math.min(Number(url.searchParams.get('count') ?? 3) || 3, 12))
  const kind = (url.searchParams.get('kind') ?? 'image').toLowerCase()
  try {
    const report =
      kind === 'audio' ? await postHouseAudioJobs(count) : kind === 'code' ? await postHouseCodeJobs(count) : await postHouseImageJobs(count)
    return Response.json({ status: 'ok', kind, ...report })
  } catch (error) {
    console.error('[admin/post-image-jobs] failed:', error)
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

export const POST = handle
// GET stays routed so a browser paste gets the 405 + curl hint rather than a
// bare 404 — the guard is what refuses to act, not the absence of a route.
export const GET = handle
