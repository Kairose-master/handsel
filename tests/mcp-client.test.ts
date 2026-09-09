import { describe, expect, it } from 'vitest'
import {
  parseRpcBody,
  findRpcResponse,
  extractToolText,
  pickToolArgumentKey,
  initializeFailureMessage,
} from '@/lib/mcp-client'

describe('parseRpcBody', () => {
  it('parses a single application/json response', () => {
    const msgs = parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 'application/json')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe(1)
  })

  it('parses a JSON array of messages', () => {
    const msgs = parseRpcBody('[{"id":1,"result":1},{"id":2,"result":2}]', 'application/json')
    expect(msgs.map((m) => m.id)).toEqual([1, 2])
  })

  it('extracts JSON from an SSE (text/event-stream) body', () => {
    const body = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"hi"}]}}',
      '',
    ].join('\n')
    const msgs = parseRpcBody(body, 'text/event-stream')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe(3)
  })

  it('skips keep-alive / non-JSON data lines in SSE', () => {
    const body = ['data: ping', 'data: {"id":1,"result":true}', 'data: [DONE]'].join('\n')
    const msgs = parseRpcBody(body, 'text/event-stream')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe(1)
  })

  it('returns [] for an empty or unparseable body', () => {
    expect(parseRpcBody('', 'application/json')).toEqual([])
    expect(parseRpcBody('not json', 'application/json')).toEqual([])
  })
})

describe('findRpcResponse', () => {
  it('finds the message matching the id that has a result or error', () => {
    const msgs = [
      { method: 'notifications/x' },
      { id: 1, result: { a: 1 } },
      { id: 2, result: { b: 2 } },
    ]
    expect(findRpcResponse(msgs, 2)?.result).toEqual({ b: 2 })
  })

  it('ignores notifications and unmatched ids', () => {
    expect(findRpcResponse([{ method: 'x' }, { id: 9, result: 1 }], 1)).toBeUndefined()
  })
})

describe('extractToolText', () => {
  it('joins text content items', () => {
    expect(extractToolText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })

  it('serializes non-text content rather than dropping it', () => {
    const out = extractToolText({ content: [{ type: 'image', data: 'x' }] })
    expect(out).toContain('image')
  })

  it('falls back to structuredContent', () => {
    expect(extractToolText({ structuredContent: { n: 1 } })).toBe('{"n":1}')
  })

  it('returns empty string for null', () => {
    expect(extractToolText(null)).toBe('')
  })
})

describe('pickToolArgumentKey', () => {
  it('prefers a conventionally-named string property', () => {
    expect(pickToolArgumentKey({ properties: { foo: { type: 'string' }, prompt: { type: 'string' } } })).toBe('prompt')
  })

  it('prefers task over prompt when both exist', () => {
    expect(pickToolArgumentKey({ properties: { prompt: { type: 'string' }, task: { type: 'string' } } })).toBe('task')
  })

  it('falls back to the first required string when no conventional name matches', () => {
    expect(
      pickToolArgumentKey({ properties: { alpha: { type: 'string' }, beta: { type: 'string' } }, required: ['beta'] }),
    ).toBe('beta')
  })

  it('falls back to the first string property when nothing required', () => {
    expect(pickToolArgumentKey({ properties: { onlyOne: { type: 'string' } } })).toBe('onlyOne')
  })

  it('defaults to "task" when the schema has no usable properties', () => {
    expect(pickToolArgumentKey({})).toBe('task')
    expect(pickToolArgumentKey(undefined)).toBe('task')
  })
})

describe('initializeFailureMessage', () => {
  const pointer = 'Bearer resource_metadata="https://handsel-main.vercel.app/.well-known/oauth-protected-resource"'

  it('names an OAuth-protected server as such instead of a bare 401', () => {
    // The exact answer handsel-main gives an unauthenticated initialize. It
    // was read once as "no OAuth discovery at all" — the header IS the discovery.
    const msg = initializeFailureMessage({
      status: 401,
      wwwAuthenticate: pointer,
      raw: '{"error":"invalid_token"}',
      hasAuthHeader: false,
    })
    expect(msg).toContain('OAuth-protected')
    expect(msg).toContain('https://handsel-main.vercel.app/.well-known/oauth-protected-resource')
    expect(msg).toContain('auth_header')
    expect(msg).toContain('/api/oauth/personal-token')
    expect(msg).not.toMatch(/^MCP initialize failed/)
  })

  it('does not advertise the Handsel personal-token route for someone else\'s server', () => {
    const msg = initializeFailureMessage({
      status: 401,
      wwwAuthenticate: 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      raw: '',
      hasAuthHeader: false,
    })
    expect(msg).toContain('auth_header')
    expect(msg).not.toContain('personal-token')
  })

  it('says the supplied token was rejected when one was sent', () => {
    const msg = initializeFailureMessage({ status: 401, wwwAuthenticate: pointer, raw: '', hasAuthHeader: true })
    expect(msg).toContain('rejected')
    expect(msg).not.toContain('Pass auth_header')
  })

  it('handles a 401 with no discovery pointer', () => {
    const msg = initializeFailureMessage({ status: 401, wwwAuthenticate: null, raw: 'nope', hasAuthHeader: false })
    expect(msg).toContain('authentication-protected')
    expect(msg).not.toContain('discovery at')
  })

  it('keeps the raw status + body for every other failure', () => {
    expect(
      initializeFailureMessage({ status: 500, raw: '<html>boom</html>', hasAuthHeader: false }),
    ).toBe('MCP initialize failed (500): <html>boom</html>')
    expect(
      initializeFailureMessage({ status: 200, raw: '', rpcErrorMessage: 'Unsupported protocol', hasAuthHeader: false }),
    ).toBe('MCP initialize failed (200): Unsupported protocol')
  })
})
