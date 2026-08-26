/**
 * Minimal MCP (Model Context Protocol) client over Streamable HTTP.
 *
 * This is the "bring any agent in as a worker" adapter: given an external MCP
 * server URL and a tool name, we open a session, call that tool with the job
 * task, and return its text output — which then flows through the platform's
 * independent grading exactly like any other worker's submission. See
 * docs/external-agents.md.
 *
 * We hand-roll the protocol (the app has no MCP SDK dependency — its own
 * /api/mcp server is hand-rolled too). Only the slice a worker call needs:
 * initialize → notifications/initialized → (optional) tools/list → tools/call.
 * The parsing is split into pure functions so it can be unit-tested without a
 * live server.
 */

const PROTOCOL_VERSION = '2025-06-18'

/** A JSON-RPC message (request result or error). */
export interface RpcMessage {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
}

/** Extract JSON-RPC messages from a response body, whether it came back as a
 *  single JSON object/array (`application/json`) or an SSE stream
 *  (`text/event-stream`, one JSON per `data:` line). Non-JSON lines are
 *  skipped so keep-alive comments don't throw. Pure. */
export function parseRpcBody(body: string, contentType: string | null): RpcMessage[] {
  const isSse = (contentType ?? '').includes('text/event-stream')
  if (isSse) {
    const out: RpcMessage[] = []
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        out.push(JSON.parse(payload))
      } catch {
        /* partial / non-JSON data line */
      }
    }
    return out
  }
  const trimmed = body.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** Find the response matching a request id (ignoring notifications / other
 *  ids). Pure. */
export function findRpcResponse(messages: RpcMessage[], id: number): RpcMessage | undefined {
  return messages.find((m) => m && m.id === id && (m.result !== undefined || m.error !== undefined))
}

/** Flatten an MCP tool result's `content` array into text. Handles the common
 *  `{ type: 'text', text }` items; falls back to JSON for structured content
 *  so nothing is silently dropped. Pure. */
export function extractToolText(result: unknown): string {
  if (result == null) return ''
  const r = result as { content?: unknown; structuredContent?: unknown }
  const content = r.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (item && typeof item === 'object') {
        const it = item as { type?: string; text?: string }
        if (it.type === 'text' && typeof it.text === 'string') parts.push(it.text)
        else parts.push(JSON.stringify(item))
      } else if (typeof item === 'string') {
        parts.push(item)
      }
    }
    return parts.join('\n').trim()
  }
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent)
  if (typeof result === 'string') return result
  return ''
}

/** The marker a job brief uses to hand a tool-backed worker a real query.
 *  Lower-case, at the start of its own line. */
const MCP_QUERY_MARKER = '[mcp-query]'

/** A query longer than this is not a query. Cheap guard against a brief that
 *  put a whole paragraph after the marker. */
const MAX_MCP_QUERY_CHARS = 400

/**
 * Pull an explicit search query out of a job brief, if it carries one.
 *
 * Why this exists, measured rather than assumed. The worker call sends the
 * WHOLE brief as the tool's single string argument, which is right for an MCP
 * server that is an agent and wrong for one that is a search index. Against
 * `aws___search_documentation` on AWS's own knowledge server, a real 995-char
 * brief asking for Lambda's quotas returned EKS admission-webhook pages and
 * blog posts — the brief's framing words ("webhook receiver", "p99") drowned
 * the subject — while the 99-character query underneath it returned the
 * "Lambda quotas" page as result 1. Same server, same tool, same minute.
 *
 * So a brief may name its own query on a line beginning `[mcp-query]`, and a
 * tool-backed worker sends that instead of the brief. Absent, behavior is
 * unchanged: the full brief goes, which is what an agent-shaped MCP server
 * wants. The line stays in the brief rather than being stripped, because the
 * same spec is also read by LLM workers, where it lands as a harmless hint
 * about what to look up.
 *
 * Pure. Returns null when there is no marker, or nothing usable after it.
 */
export function extractMcpQuery(task: string): string | null {
  for (const line of (task ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.toLowerCase().startsWith(MCP_QUERY_MARKER)) continue
    const query = trimmed.slice(MCP_QUERY_MARKER.length).trim()
    if (!query) return null
    return query.slice(0, MAX_MCP_QUERY_CHARS)
  }
  return null
}

const TASK_ARG_PREFERENCE = ['task', 'prompt', 'input', 'query', 'message', 'text', 'question', 'q']

/** Decide which argument key to pass the job task under, by inspecting the
 *  tool's JSON-Schema `inputSchema`. Prefers a conventionally-named string
 *  property (task/prompt/input/…), else the first required string, else the
 *  first string, else falls back to `task`. Pure. */
export function pickToolArgumentKey(inputSchema: unknown): string {
  const schema = inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] } | undefined
  const props = schema?.properties
  if (!props || typeof props !== 'object') return 'task'
  const isString = (name: string) => props[name] && (props[name].type === 'string' || props[name].type === undefined)

  for (const pref of TASK_ARG_PREFERENCE) {
    if (props[pref] && isString(pref)) return pref
  }
  const required = Array.isArray(schema?.required) ? schema!.required : []
  for (const name of required) {
    if (isString(name)) return name
  }
  const firstString = Object.keys(props).find((name) => isString(name))
  return firstString ?? 'task'
}

async function rpcPost(
  url: string,
  headers: Record<string, string>,
  message: object,
  timeoutMs: number,
): Promise<{ messages: RpcMessage[]; sessionId: string | null; status: number; raw: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await res.text()
  const messages = parseRpcBody(raw, res.headers.get('content-type'))
  return { messages, sessionId: res.headers.get('mcp-session-id'), status: res.status, raw }
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

/**
 * Look up one tool's advertised shape (name + description + input schema) via
 * initialize → tools/list. Used at registration to auto-declare an imported
 * agent's capabilities. Returns null if the server has no such tool; throws
 * only if the server is unreachable / rejects initialize.
 */
export async function probeMcpTool(input: {
  serverUrl: string
  toolName: string
  authHeader?: string | null
  timeoutMs?: number
}): Promise<McpToolInfo | null> {
  const url = input.serverUrl.trim()
  const timeoutMs = input.timeoutMs ?? 20_000
  const auth: Record<string, string> = input.authHeader ? { Authorization: input.authHeader } : {}

  const init = await rpcPost(
    url,
    auth,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'handsel-worker', version: '1' } },
    },
    timeoutMs,
  )
  const initResp = findRpcResponse(init.messages, 1)
  if (!initResp || initResp.error) {
    throw new Error(`MCP initialize failed (${init.status}): ${initResp?.error?.message ?? init.raw.slice(0, 200)}`)
  }
  const sessionHeaders: Record<string, string> = { ...auth, 'MCP-Protocol-Version': PROTOCOL_VERSION }
  if (init.sessionId) sessionHeaders['Mcp-Session-Id'] = init.sessionId

  try {
    await rpcPost(url, sessionHeaders, { jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs)
  } catch {
    /* keep going */
  }

  const list = await rpcPost(url, sessionHeaders, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, timeoutMs)
  const listResp = findRpcResponse(list.messages, 2)
  const tools = (listResp?.result as { tools?: McpToolInfo[] } | undefined)?.tools
  return tools?.find((t) => t.name === input.toolName) ?? null
}

export interface McpCallInput {
  serverUrl: string
  toolName: string
  task: string
  /** Optional Authorization header value (e.g. "Bearer xyz"). */
  authHeader?: string | null
  timeoutMs?: number
}

/**
 * Run one tool call against an external MCP server and return its text output.
 * Throws on protocol/tool error so the caller can record a failed run (which
 * the grader then treats as a non-delivery).
 */
export async function callMcpTool(input: McpCallInput): Promise<string> {
  const url = input.serverUrl.trim()
  const timeoutMs = input.timeoutMs ?? 120_000
  const auth: Record<string, string> = input.authHeader ? { Authorization: input.authHeader } : {}

  // 1. initialize — capture the session id the server may pin the session to.
  const init = await rpcPost(
    url,
    auth,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'handsel-worker', version: '1' },
      },
    },
    timeoutMs,
  )
  const initResp = findRpcResponse(init.messages, 1)
  if (!initResp || initResp.error) {
    throw new Error(`MCP initialize failed (${init.status}): ${initResp?.error?.message ?? init.raw.slice(0, 200)}`)
  }
  const sessionHeaders: Record<string, string> = {
    ...auth,
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  }
  if (init.sessionId) sessionHeaders['Mcp-Session-Id'] = init.sessionId

  // 2. initialized notification (best-effort — servers 202 with no body).
  try {
    await rpcPost(url, sessionHeaders, { jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs)
  } catch {
    /* some servers accept tools/call without this; keep going */
  }

  // 3. tools/list to learn the tool's expected argument shape (best-effort).
  let argKey = 'task'
  try {
    const list = await rpcPost(url, sessionHeaders, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, timeoutMs)
    const listResp = findRpcResponse(list.messages, 2)
    const tools = (listResp?.result as { tools?: Array<{ name?: string; inputSchema?: unknown }> } | undefined)?.tools
    const tool = tools?.find((t) => t.name === input.toolName)
    if (tool) argKey = pickToolArgumentKey(tool.inputSchema)
  } catch {
    /* fall back to the default arg key */
  }

  // 4. tools/call — the actual work. A brief that names its own query gets
  //    that sent instead of the whole brief; see extractMcpQuery for the
  //    measurement that made this necessary.
  const argValue = extractMcpQuery(input.task) ?? input.task
  const call = await rpcPost(
    url,
    sessionHeaders,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: input.toolName, arguments: { [argKey]: argValue } } },
    timeoutMs,
  )
  const callResp = findRpcResponse(call.messages, 3)
  if (!callResp || callResp.error) {
    throw new Error(`MCP tools/call failed (${call.status}): ${callResp?.error?.message ?? call.raw.slice(0, 200)}`)
  }
  const result = callResp.result as { isError?: boolean } | undefined
  const text = extractToolText(result)
  if (result?.isError) {
    throw new Error(`MCP tool "${input.toolName}" returned an error: ${text.slice(0, 200)}`)
  }
  return text
}
