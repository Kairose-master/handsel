/**
 * The shared guard for operator endpoints that MOVE MONEY.
 *
 * Two of them accepted `GET`, with a comment saying so on purpose: "allowed
 * too so it can be fired from a browser address bar with ?secret= during
 * testing." That convenience is a live trigger. A GET whose side effect is
 * escrowing bounties fires whenever anything **fetches the URL**, and URLs
 * with secrets in them travel: they get pasted into chat, and Slack, Discord,
 * iMessage and every other client unfurl links by fetching them. Paste
 * `…/post-image-jobs?secret=…&count=12` into a channel and the unfurl bot
 * escrows twelve bounties before anyone reads the message. I have pasted
 * admin URLs into chat in this very project.
 *
 * So: state-changing operator endpoints are POST-only. A GET answers 405
 * with the exact `curl` to run — the browser-address-bar workflow keeps its
 * discoverability and loses its ability to act by accident. Read-only
 * diagnostics (`/api/admin/health`, `job-diag`) stay on GET; nothing happens
 * when they're prefetched.
 *
 * **The secret is NOT accepted from the query string here.** The original
 * deployment kept `?secret=` working because breaking every saved operator
 * command would have been worse than the exposure — a migration compromise,
 * and a reasonable one. This deployment has no saved commands to break, so it
 * inherits the compromise's cost without any of its benefit. Residual risk R4
 * in `docs/security-audit.md` is closed here rather than deferred.
 *
 * The exposure it avoids: Vercel logs the full request path, so a secret in a
 * URL is written into log storage and stays there. Rejecting the request does
 * NOT undo that for the request itself — by the time this code runs, the value
 * has already been logged — which is why the refusal says so and tells the
 * caller to rotate.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

export type AdminAuth = { ok: true } | { ok: false; response: Response }

/** How the operator should call a mutating endpoint, as copy-pasteable text. */
export function curlHint(request: Request): string {
  const url = new URL(request.url)
  url.searchParams.delete('secret')
  return `curl -X POST -H "Authorization: Bearer $CRON_SECRET" "${url.toString()}"`
}

/**
 * Shared-secret check for operator endpoints. Pass `mutating: true` for
 * anything with a side effect — it additionally refuses GET.
 */
export function requireOperator(request: Request, opts?: { mutating?: boolean }): AdminAuth {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return { ok: false, response: Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 }) }
  }

  if (opts?.mutating && request.method === 'GET') {
    return {
      ok: false,
      response: Response.json(
        {
          error: 'This endpoint changes state, so it is POST-only.',
          why: 'A GET that escrows money fires on any prefetch — including the link unfurl that happens when its URL is pasted into a chat.',
          run: curlHint(request),
        },
        { status: 405, headers: { Allow: 'POST' } },
      ),
    }
  }

  const url = new URL(request.url)

  // Refused BEFORE the comparison, and answered differently from a plain 401.
  // A bare Unauthorized would send someone with a v1-era command hunting for a
  // wrong secret, when the problem is where they put it.
  if (url.searchParams.has('secret')) {
    console.warn(
      `[admin] ${url.pathname} was called with ?secret= in the URL. This deployment never accepts that, but the ` +
        'value has already been written to log storage by the request path — it should be rotated.',
    )
    return {
      ok: false,
      response: Response.json(
        {
          error: 'This deployment does not accept a secret in the URL.',
          why: 'The full request path is written to log storage, so a secret in a query string stays there permanently.',
          important:
            'Refusing this request did not undo that. The value you just sent is already in the logs — rotate it.',
          run: curlHint(request),
        },
        { status: 401 },
      ),
    }
  }

  const given = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!timingSafeEquals(given, secret)) {
    return { ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  return { ok: true }
}

/**
 * Constant-time comparison, via SHA-256 digests so the two sides are always the
 * same length — `timingSafeEqual` throws otherwise, and a length check before
 * it would reintroduce the leak it exists to remove. Same construction as
 * `lib/webhook.ts`; see audit finding F25 for why a money gate that compares
 * secrets differently from the rest of the repo is the defect worth fixing.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()
  return timingSafeEqual(digest(a), digest(b))
}
