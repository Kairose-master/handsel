/**
 * Instagram Graph API error taxonomy.
 *
 * The one decision that matters here: WHICH failures may be retried. A
 * transient failure (rate limit, 5xx, network) retries with backoff; a
 * permanent one (bad token, missing permission, invalid media) must NOT be
 * retried blindly — retrying an OAuth error 190 in a loop is how an app gets
 * its token invalidated for abuse, and retrying a validation error can never
 * succeed. The queue also maps `isAuthError` to the NEEDS_AUTH job state so
 * a dead token surfaces as "reconnect the account", not as a retry storm.
 */

/** The JSON error envelope Graph API returns. */
export type GraphApiErrorBody = {
  message?: string
  type?: string
  code?: number
  error_subcode?: number
  error_user_title?: string
  error_user_msg?: string
  fbtrace_id?: string
}

/**
 * Graph API top-level error codes that are safe to retry.
 *  1/2  — unknown/temporary API issue
 *  4    — application request limit reached
 *  17   — user request limit reached
 *  32   — page request limit reached
 *  613  — custom rate limit
 *  9007 — media not ready yet (container fetched too early)
 */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613, 9007])

/**
 * Codes that mean the token or its permissions are dead. These flip the job
 * to NEEDS_AUTH — no amount of retrying fixes an expired token.
 *  190      — access token expired/invalidated
 *  10       — permission denied
 *  200..299 — assorted permission errors
 */
function isAuthCode(code: number | undefined): boolean {
  if (code === undefined) return false
  return code === 190 || code === 10 || (code >= 200 && code <= 299)
}

export class InstagramApiError extends Error {
  readonly httpStatus: number
  readonly code?: number
  readonly subcode?: number
  readonly errorType?: string
  readonly fbtraceId?: string
  /** Meta's user-facing explanation, when present — often the useful one. */
  readonly userMessage?: string

  constructor(httpStatus: number, body: GraphApiErrorBody | undefined, fallbackMessage: string) {
    super(body?.message || fallbackMessage)
    this.name = 'InstagramApiError'
    this.httpStatus = httpStatus
    this.code = body?.code
    this.subcode = body?.error_subcode
    this.errorType = body?.type
    this.fbtraceId = body?.fbtrace_id
    this.userMessage = body?.error_user_msg
  }

  /** Token/permission failure → NEEDS_AUTH, never retried. */
  get isAuthError(): boolean {
    return this.errorType === 'OAuthException' || isAuthCode(this.code)
  }

  /** Safe to retry with backoff. Auth errors are never transient, whatever the HTTP status says. */
  get isTransient(): boolean {
    if (this.isAuthError) return false
    if (this.code !== undefined && TRANSIENT_CODES.has(this.code)) return true
    return this.httpStatus >= 500 || this.httpStatus === 429
  }

  /** Rate limited specifically — the queue backs off the whole account, not just the job. */
  get isRateLimit(): boolean {
    return this.httpStatus === 429 || (this.code !== undefined && [4, 17, 32, 613].includes(this.code))
  }
}

/** A container reported ERROR or EXPIRED — the container is unusable; a fresh attempt needs a NEW container. */
export class ContainerFailedError extends Error {
  readonly containerId: string
  readonly statusCode: 'ERROR' | 'EXPIRED'
  readonly detail?: string

  constructor(containerId: string, statusCode: 'ERROR' | 'EXPIRED', detail?: string) {
    super(`Instagram container ${containerId} ${statusCode}${detail ? `: ${detail}` : ''}`)
    this.name = 'ContainerFailedError'
    this.containerId = containerId
    this.statusCode = statusCode
    this.detail = detail
  }
}

/** Polling budget ran out while the container was still IN_PROGRESS. The container may still finish — resumable. */
export class ContainerTimeoutError extends Error {
  readonly containerId: string

  constructor(containerId: string, waitedMs: number) {
    super(`Instagram container ${containerId} still processing after ${Math.round(waitedMs / 1000)}s`)
    this.name = 'ContainerTimeoutError'
    this.containerId = containerId
  }
}

/**
 * Redact an access token wherever it might appear in a message or URL.
 * Tokens travel in the Authorization header (never the query string), but a
 * defensive scrub before anything is logged or stored costs nothing.
 * Mirrors the platform convention: echo only last-4.
 */
export function redactToken(text: string, token: string | undefined): string {
  if (!token || token.length < 8) return text
  const last4 = token.slice(-4)
  return text.split(token).join(`[ig-token…${last4}]`)
}

/** Errors that were caused by the network itself (fetch threw, no HTTP response). */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof Error && /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(e.message))
}

/** Unified "may this failure be retried?" — the queue and the client both ask this one function. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof InstagramApiError) return e.isTransient
  if (e instanceof ContainerTimeoutError) return true
  if (e instanceof ContainerFailedError) return false
  return isNetworkError(e)
}
