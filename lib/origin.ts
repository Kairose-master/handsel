/**
 * This deployment's public origin, in one place.
 *
 * It used to be a hostname typed out in eighteen files. That was harmless
 * while there was exactly one deployment and became a real defect the moment
 * there were two: a fork inherits every one of those strings, and its users
 * are then handed the ORIGINAL deployment's links. The worst of them were the
 * MCP connect URLs — a user of the new market clicking "connect" would wire
 * their Claude or ChatGPT to the old one — and the email links, which pointed
 * every payout and claim-warning notice at somebody else's site.
 *
 * Resolution order, first hit wins:
 *
 *  1. `PUBLIC_ORIGIN` — set it when the deployment has a custom domain, or
 *     when Vercel's own value is not the URL you want users to see.
 *  2. `VERCEL_PROJECT_PRODUCTION_URL` — the project's stable production host,
 *     which is what belongs in an email that outlives the deployment.
 *  3. `VERCEL_URL` — this specific deployment. Correct on a preview, wrong in
 *     anything durable, which is why it is third.
 *  4. `http://localhost:3000` — development.
 *
 * Note the ordering is deliberate: a per-deployment URL baked into a sent
 * email is a link that dies at the next deploy.
 */

const FALLBACK = 'http://localhost:3000'

function normalise(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** Pure resolver, so the precedence can be tested without an environment. */
export function resolveOrigin(env: {
  PUBLIC_ORIGIN?: string
  VERCEL_PROJECT_PRODUCTION_URL?: string
  VERCEL_URL?: string
}): string {
  for (const candidate of [env.PUBLIC_ORIGIN, env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL]) {
    const normalised = candidate ? normalise(candidate) : ''
    if (normalised) return normalised
  }
  return FALLBACK
}

/** This deployment's origin, with no trailing slash. */
export function origin(): string {
  return resolveOrigin({
    PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    VERCEL_URL: process.env.VERCEL_URL,
  })
}

/** `origin() + path`, tolerating a path with or without its leading slash. */
export function absoluteUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${origin()}${suffix}`
}

/** The MCP endpoint an agent should connect to. Its own helper because
 *  connecting to the wrong one silently attaches a worker to a different
 *  market — the single most confusing way this can go wrong. */
export function mcpUrl(): string {
  return absoluteUrl('/api/mcp')
}
