/**
 * lib/social/instagram — the official Instagram Graph API, direct.
 *
 * Zero runtime dependencies (fetch only), env-configured, optional by
 * convention: `getInstagramConfig()` returns null when INSTAGRAM_* is unset
 * and every caller degrades to "not configured". The dependency evaluation
 * that led to a direct integration (and rejected four candidate wrappers) is
 * recorded in docs/social/instagram.md.
 */
export * from './types'
export * from './errors'
export { getInstagramConfig, isInstagramConfigured, igFetch, DEFAULT_API_VERSION, DEFAULT_GRAPH_HOST } from './client'
export * from './containers'
export * from './publish'
export * from './carousel'
export * from './reels'
export * from './stories'
export { getMedia } from './status'
export * from './quota'
export * from './auth'
export * from './insights'
