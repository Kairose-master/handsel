/**
 * The verified-connector catalog — one-click attach for MCP workers.
 *
 * `docs/external-agents.md` named this Phase 4 of the MCP-worker roadmap and
 * it sat unbuilt while every attach surface asked for a URL paste: the profile
 * Runtime card, the office ConnectorEditor and `connect_mcp_worker` all took a
 * free-typed server URL + tool name, which means every user re-discovers what
 * `docs/office-connectors.md` already measured — which servers actually work
 * as workers, which tool on each, and which argument key it takes.
 *
 * This module is that record as data: the servers probed end-to-end with this
 * repo's own client (`lib/mcp-client.ts`) from this environment with no API
 * key, promoted from the doc's table so a person (or an assistant) picks one
 * by name instead of pasting a URL.
 *
 * Two honesty rules, both load-bearing:
 *
 * 1. **Every entry is `mode: 'assisted'`.** All four are search-shaped
 *    servers, and a search server in 'proxy' mode submits a result dump as
 *    the deliverable — the exact defect found live on 2026-08-26 (an agent
 *    wired to Exa in proxy, unnoticed because nothing fails until a job is
 *    graded). A catalog that one-clicks people into that defect is worse than
 *    no catalog. An agent-shaped server added here later may be 'proxy', but
 *    it must say so deliberately.
 *
 * 2. **`verifiedOn` is shown, not implied away.** These are third-party
 *    services that can rename a tool or add auth without warning; the date is
 *    when the probe ran, and the live check is still the Test button /
 *    `test_mcp_connector`. A card that reads as a guarantee would be a claim
 *    this repo cannot keep.
 *
 * Pure and client-importable (no db, no server imports) so the profile page
 * and the office editor can render it directly. `tests/verified-connectors.
 * test.ts` pins every entry to the doc's "Verified working" table and pins
 * every office template's `defaultConnector` into this catalog, so the three
 * places that name these servers cannot drift apart.
 */
import { toolIdentityOf } from '@/lib/tool-identity'

export type VerifiedConnector = {
  /** Stable id — also accepted by `connect_mcp_worker`'s `connector` arg. */
  id: string
  /** Owner-facing name, shown on the card. */
  label: string
  serverUrl: string
  toolName: string
  /** The single string argument `pickToolArgumentKey` will hand the query to
   *  (display only — the client re-derives it from the live schema). */
  argKey: string
  /** What the tool is good for, in one sentence. */
  blurb: string
  /** When the end-to-end probe ran (docs/office-connectors.md). */
  verifiedOn: string
  /** How the worker should use the tool. See honesty rule 1 above. */
  mode: 'proxy' | 'assisted'
}

export const VERIFIED_CONNECTORS: readonly VerifiedConnector[] = [
  {
    id: 'exa',
    label: 'Exa web search',
    serverUrl: 'https://mcp.exa.ai/mcp',
    toolName: 'web_search_exa',
    argKey: 'query',
    blurb: 'Live web search with dated results and source URLs — the general-purpose research connector.',
    verifiedOn: '2026-08-26',
    mode: 'assisted',
  },
  {
    id: 'aws-knowledge',
    label: 'AWS Knowledge (official docs)',
    serverUrl: 'https://knowledge-mcp.global.api.aws',
    toolName: 'aws___search_documentation',
    argKey: 'search_phrase',
    blurb: "AWS's own current documentation — quotas, limits and pricing straight from the source.",
    verifiedOn: '2026-08-26',
    mode: 'assisted',
  },
  {
    id: 'microsoft-learn',
    label: 'Microsoft Learn (official docs)',
    serverUrl: 'https://learn.microsoft.com/api/mcp',
    toolName: 'microsoft_docs_search',
    argKey: 'query',
    blurb: "Microsoft Learn — Azure limits, tiers and guidance from Microsoft's own published docs.",
    verifiedOn: '2026-08-26',
    mode: 'assisted',
  },
  {
    id: 'cloudflare-docs',
    label: 'Cloudflare Docs (official)',
    serverUrl: 'https://docs.mcp.cloudflare.com/mcp',
    toolName: 'search_cloudflare_documentation',
    argKey: 'query',
    blurb: "Cloudflare's developer documentation — Workers limits and platform behavior, from Cloudflare.",
    verifiedOn: '2026-08-26',
    mode: 'assisted',
  },
]

export function verifiedConnectorById(id: string): VerifiedConnector | null {
  return VERIFIED_CONNECTORS.find((c) => c.id === id) ?? null
}

/**
 * The exact `ToolRecord.toolId` a probed connector would earn once it has
 * graded work — `mcp:<publishable server url>#<tool name>`, computed the
 * same way `lib/tool-record-server.ts` builds it from a real agent's wiring
 * (`toolIdentityOf`), so a lookup against `toolRecords()` output matches by
 * construction rather than by a second, driftable copy of the id format.
 * Null only if the entry's own `serverUrl` somehow fails to parse — which
 * would mean the catalog itself is broken, not that the connector lacks a
 * record.
 */
export function verifiedConnectorToolId(c: VerifiedConnector): string | null {
  return toolIdentityOf({ runtimeType: 'mcp', mcpServerUrl: c.serverUrl, mcpToolName: c.toolName })?.id ?? null
}

/**
 * The catalog entry matching an already-typed wiring, or null.
 *
 * Lets a form that PREFILLS from the catalog (rather than submitting directly)
 * recover the right mode at save time from what is actually in the inputs —
 * matching on the values, not on remembered click-state that goes stale the
 * moment the user edits a field.
 */
export function verifiedConnectorFor(serverUrl: string, toolName: string): VerifiedConnector | null {
  const url = serverUrl.trim().replace(/\/+$/, '')
  const tool = toolName.trim()
  return (
    VERIFIED_CONNECTORS.find((c) => c.serverUrl.replace(/\/+$/, '') === url && c.toolName === tool) ?? null
  )
}
