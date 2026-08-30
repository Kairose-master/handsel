/**
 * Naming a TOOL, as distinct from naming an agent.
 *
 * Every graded job on this market already records which tool did the work —
 * `agent.mcpServerUrl` + `agent.mcpToolName` for an external MCP worker, the
 * harness id for a local one — but the record is only ever aggregated per
 * AGENT, because a credit score belongs to one owner's agent. So nobody can
 * ask the question the whole market is uniquely able to answer: *how does the
 * Exa MCP server do on research jobs?* *Does Codex or Cline close more
 * issues?* The answers exist and are scattered across private agents owned by
 * different accounts.
 *
 * This is the missing axis: a stable, publishable identity for the tool
 * itself. See docs/positioning.md §5.
 *
 * ── The part that must not be got wrong ──────────────────────────────────
 *
 * A tool id is PUBLISHED. `mcpServerUrl` is a URL an owner pasted in, and
 * people paste credentials into URLs — an API key in a query string, a token
 * in the userinfo, a per-customer path segment handed out by a vendor. So the
 * identity is built by an ALLOW-list of URL parts (scheme, host, port, path),
 * never by stripping the parts we happen to think of. Anything unparseable is
 * refused an identity rather than published raw.
 */

export type ToolKind = 'mcp' | 'harness' | 'runtime'

export type ToolIdentity = {
  id: string
  kind: ToolKind
  /** What a person should see. Never contains anything the URL carried
   *  beyond scheme/host/port/path. */
  label: string
}

/**
 * The publishable form of an MCP server URL.
 *
 * Keeps scheme, host, port and path. Drops the query, the fragment and any
 * userinfo — the three places a secret actually turns up. Null when the URL
 * cannot be parsed, which is treated as "no identity" everywhere below: a
 * string we could not take apart is a string we must not print.
 */
export function publishableServerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  // Rebuilt from named parts rather than edited in place, so a part nobody
  // thought about cannot survive by default.
  const port = u.port ? `:${u.port}` : ''
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.protocol}//${u.hostname.toLowerCase()}${port}${path}`
}

/** A tool name is printed next to the server. Same posture: a conservative
 *  shape or nothing, because it also ends up in an id. */
function safeToolName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t || t.length > 80) return null
  return /^[A-Za-z0-9_.:-]+$/.test(t) ? t : null
}

export type ToolBearingAgent = {
  runtimeType?: string | null
  mcpServerUrl?: string | null
  mcpToolName?: string | null
  /** Which coding harness this local worker reports running, if any
   *  (lib/worker-harness.ts). Null for a worker on the built-in loop. */
  harnessId?: string | null
}

/**
 * The tool that did the work, or null when there is nothing publishable to
 * attribute it to.
 *
 * Null is the common and correct answer: a `platform` agent is Handsel's own
 * model and attributing its record to "a tool" would be marking our own
 * homework, and a `local` worker on the built-in loop is an owner's private
 * setup that nobody else can go and use.
 */
export function toolIdentityOf(agent: ToolBearingAgent): ToolIdentity | null {
  if (agent.harnessId) {
    const id = safeToolName(agent.harnessId)
    if (!id) return null
    return { id: `harness:${id}`, kind: 'harness', label: id }
  }
  if (agent.runtimeType === 'mcp') {
    const server = publishableServerUrl(agent.mcpServerUrl)
    const tool = safeToolName(agent.mcpToolName)
    if (!server || !tool) return null
    return { id: `mcp:${server}#${tool}`, kind: 'mcp', label: `${displayHost(server)} · ${tool}` }
  }
  return null
}

/** Host plus the last path segment — enough to recognise a server without a
 *  line of URL in a table cell. */
export function displayHost(publishable: string): string {
  try {
    const u = new URL(publishable)
    const tail = u.pathname.split('/').filter(Boolean).pop()
    return tail ? `${u.hostname}/${tail}` : u.hostname
  } catch {
    return publishable
  }
}
