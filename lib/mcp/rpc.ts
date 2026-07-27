/**
 * JSON-RPC 2.0 response shapes, and the context every tool handler receives.
 *
 * These three helpers are the shared vocabulary of the MCP surface: every
 * handler answers with one of them. They were defined inside the route file,
 * which meant splitting the handlers out required either duplicating them or
 * importing from a route — so they live here.
 */

export function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result })
}

export function rpcError(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } })
}

/** A tool's answer. `isError` marks a failure the MODEL should read and act on
 *  — a refusal or a bad argument — as distinct from a protocol error, which
 *  the connector handles and the model never sees. */
export function toolText(id: unknown, text: string, isError = false) {
  return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } })
}

/** What every tool handler is given. Narrow on purpose: a handler that needs
 *  more than the caller, the request id and the origin is doing something the
 *  MCP layer should not be doing. */
export type McpToolContext = {
  id: unknown
  auth: import('@/lib/oauth').McpAuth
  origin: string
}
