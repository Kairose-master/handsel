/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // The /examples routes read docs/test-scenarios/*.md; make sure those files
  // ship in the serverless bundle even if a route ever renders dynamically.
  outputFileTracingIncludes: {
    '/examples': ['./docs/test-scenarios/**'],
    '/examples/[slug]': ['./docs/test-scenarios/**'],
    '/api/mcp': ['./docs/test-scenarios/**'],
    // Docs-translation jobs read their source files at post time (the server
    // action bundles under the admin page that invokes it).
    '/admin/access': ['./docs/*.md', './minecraft/README.md'],
  },
  async rewrites() {
    // OAuth discovery documents for MCP connectors (Claude/ChatGPT).
    // RFC 8414/9728 fix these paths at the origin root; the :path* suffix
    // covers clients that append the resource path to the well-known URL.
    return [
      { source: '/.well-known/oauth-authorization-server/:path*', destination: '/api/oauth/metadata' },
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/metadata' },
      { source: '/.well-known/oauth-protected-resource/:path*', destination: '/api/oauth/protected-resource' },
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/protected-resource' },
      // What this deployment sells over x402 (lib/x402-catalog.ts), readable
      // without triggering a 402 — for crawlers that look for a well-known.
      { source: '/.well-known/x402.json', destination: '/api/x402/catalog' },
    ]
  },
}

export default nextConfig
