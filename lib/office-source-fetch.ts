/**
 * Fetching an office's shared source from a document that lives elsewhere.
 *
 * The office source is one document every role in an office reads, injected
 * into each brief at hire time. Until now it had to be pasted, so the copy
 * drifted from the original the moment anyone edited it — and nothing recorded
 * that it ever had an original.
 *
 * ## A snapshot, not a live link
 *
 * The obvious reading of "point the office at a live Notion page" is the wrong
 * one, and lib/office.ts already says why:
 *
 *   editing the source deliberately does NOT rewrite an office already hired,
 *   because a brief that changed under a posted job would change the contract
 *   a worker is being graded against.
 *
 * A live link violates that in the worst available way: the document can move
 * while the job is open, so the worker is graded against something it never
 * read. What the office needs is not a link but a **fetched snapshot with
 * provenance** — the text, plus where it came from, when, and a hash — so a
 * reader can tell whether the source has moved since, and the brief still
 * cannot.
 *
 * ## Reading only
 *
 * This is `observational` in the effect vocabulary (lib/trade-instruments.ts):
 * it reads and changes nothing outside this system, so it is admissible under
 * the ordinary route with no `authorisation` instrument. That is precisely why
 * the read side is the safe half of the Slack/Notion/Drive question and the
 * write side is not.
 */
import { createHash } from 'node:crypto'

export const MAX_FETCH_BYTES = 512_000
export const FETCH_TIMEOUT_MS = 15_000

export type FetchedSource =
  | { ok: true; title: string; body: string; contentHash: string; fetchedAt: string; finalUrl: string }
  | { ok: false; code: string; error: string }

/**
 * Refuse a URL that points back into infrastructure.
 *
 * The caller supplies this address and the server dials it, which is the
 * shape of an SSRF. Cloud metadata endpoints and loopback are the two that
 * turn a document fetcher into a credential reader, so they are refused by
 * name rather than by hoping a fetch fails.
 *
 * Pure and hostname-based. It cannot catch a public name that RESOLVES to a
 * private address — closing that needs resolution-time checking, which this
 * runtime does not expose. Stated rather than implied: this is a floor, not a
 * proof.
 */
export function refuseUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'That is not a URL.'
  }
  if (url.protocol !== 'https:') return 'Only https:// URLs are fetched.'

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return 'That host is internal.'
  }
  // The cloud metadata endpoints, which are the reason this function exists.
  if (host === '169.254.169.254' || host === 'metadata.google.internal' || host.startsWith('169.254.')) {
    return 'That address is a cloud metadata endpoint.'
  }
  if (host === '::1' || host === '0.0.0.0') return 'That address is loopback.'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10 || a === 0) return 'That address is private.'
    if (a === 172 && b >= 16 && b <= 31) return 'That address is private.'
    if (a === 192 && b === 168) return 'That address is private.'
    if (a >= 224) return 'That address is not a document host.'
  }
  // IPv6 unique-local and link-local.
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return 'That address is private.'
  return null
}

/** Strip HTML to something a brief can carry. Deliberately crude: this is a
 *  document for an agent to read, not a page to render, and a real HTML
 *  parser here would be a dependency for no gain. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The document's own title, when it announces one. */
export function titleFrom(html: string, fallbackUrl: string): string {
  const m = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html)
  const found = m?.[1]?.replace(/\s+/g, ' ').trim()
  if (found) return found.slice(0, 120)
  try {
    return new URL(fallbackUrl).hostname
  } catch {
    return 'fetched document'
  }
}

/**
 * Fetch a document to use as an office's shared source.
 *
 * Never throws — a failed fetch returns a coded refusal, because this runs
 * from a connector call and an exception there reads as a platform fault
 * rather than as "that URL did not work".
 */
export async function fetchOfficeSource(raw: string): Promise<FetchedSource> {
  const refusal = refuseUrl(raw)
  if (refusal) return { ok: false, code: 'AUTH-001', error: refusal }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(raw, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5' },
    })
    // A redirect can land somewhere the first check would have refused, so the
    // final URL is checked too. `redirect: 'follow'` means we only see where
    // it ended up — which is the address that actually got dialled.
    const after = refuseUrl(res.url || raw)
    if (after) return { ok: false, code: 'AUTH-001', error: `Redirected to a refused address: ${after}` }
    if (!res.ok) return { ok: false, code: 'DEP-001', error: `The document host answered ${res.status}.` }

    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    const raw_text = await res.text()
    // Capped after reading rather than by Content-Length, which a host may
    // omit or misreport.
    const clipped = raw_text.slice(0, MAX_FETCH_BYTES)
    const body = type.includes('html') ? htmlToText(clipped) : clipped.trim()
    if (!body) return { ok: false, code: 'DAT-001', error: 'The document came back empty.' }

    return {
      ok: true,
      title: type.includes('html') ? titleFrom(clipped, res.url || raw) : titleFrom('', res.url || raw),
      body,
      // Hash of what was actually stored, so "has the source moved?" is
      // answerable without re-fetching and comparing prose.
      contentHash: `0x${createHash('sha256').update(body).digest('hex')}`,
      fetchedAt: new Date().toISOString(),
      finalUrl: res.url || raw,
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      code: aborted ? 'TIM-002' : 'DEP-001',
      error: aborted ? `The document host did not answer within ${FETCH_TIMEOUT_MS / 1000}s.` : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}
