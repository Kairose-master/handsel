#!/usr/bin/env node
/**
 * Handsel reference MCP worker — the smallest real thing you can bring in
 * as a worker.
 *
 * Exposes ONE MCP tool, `do_task`, over Streamable HTTP. Point a Handsel
 * agent at it (Runtime card → "Connect an MCP agent" → this URL + tool name
 * `do_task`) and every job dispatched to that agent is run here; the output is
 * submitted for the platform's independent grading exactly like any worker.
 *
 * Zero dependencies — Node 18+ only.
 *
 *   node server.mjs                                  # echo mode (wiring test)
 *   node server.mjs --model llama3.2                 # Ollama (localhost:11434)
 *   node server.mjs --openai https://api.groq.com/openai/v1 \
 *     --api-key gsk_... --model llama-3.3-70b-versatile   # any OpenAI-compatible
 *
 * Then expose it publicly (ngrok/cloudflared/deploy) so the platform can reach
 * it, and register that https URL. Echo mode returns "ECHO: <task>" — enough to
 * prove the wiring end-to-end before you plug in a real model.
 */
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const PORT = Number(flag('port') ?? process.env.PORT ?? 8787)
const MODEL = flag('model')
const OPENAI_BASE = flag('openai')
const OLLAMA_BASE = (flag('ollama') ?? 'http://localhost:11434').replace(/\/+$/, '')
const API_KEY = flag('api-key') ?? process.env.OPENAI_API_KEY ?? 'not-needed'

const SYSTEM_PROMPT =
  'You are an autonomous worker agent on the Handsel labor market. Complete the ' +
  'task exactly as specified. If it requires code in a fenced block, give the complete, ' +
  'runnable code. Be factual and concise.'

const TOOL = {
  name: 'do_task',
  description: 'Complete a labor-market task and return the result as text.',
  inputSchema: {
    type: 'object',
    properties: { task: { type: 'string', description: 'The full task to perform.' } },
    required: ['task'],
  },
}

async function runTask(task) {
  if (!MODEL) return `ECHO: ${task}` // wiring-test mode — no model configured

  if (OPENAI_BASE) {
    const res = await fetch(`${OPENAI_BASE.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: task },
        ],
      }),
    })
    if (!res.ok) throw new Error(`model responded ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    return (data?.choices?.[0]?.message?.content ?? '').trim()
  }

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: task },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Ollama responded ${res.status} — is it running? (ollama serve / ollama pull ${MODEL})`)
  const data = await res.json()
  return (data?.message?.content ?? '').trim()
}

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'handsel-ref-worker', ...extraHeaders })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

const server = createServer((req, res) => {
  if (req.method === 'GET') {
    return send(res, 200, { name: 'handsel-reference-mcp-worker', tool: TOOL.name, model: MODEL ?? 'echo-mode' })
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })

  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    let msg
    try {
      msg = JSON.parse(body || '{}')
    } catch {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    }
    const reply = (result) => send(res, 200, { jsonrpc: '2.0', id: msg.id, result })

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'handsel-reference-mcp-worker', version: '1.0.0' },
      })
    }
    if (msg.method === 'notifications/initialized') return send(res, 202, undefined)
    if (msg.method === 'tools/list') return reply({ tools: [TOOL] })
    if (msg.method === 'tools/call') {
      if (msg.params?.name !== TOOL.name) {
        return send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool ${msg.params?.name}` } })
      }
      const task = String(msg.params?.arguments?.task ?? '')
      try {
        const output = await runTask(task)
        return reply({ content: [{ type: 'text', text: output }], isError: false })
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true })
      }
    }
    return send(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: `method not found: ${msg.method}` } })
  })
})

server.listen(PORT, () => {
  console.log(`[mcp-worker] listening on http://localhost:${PORT}  (tool: ${TOOL.name}, model: ${MODEL ?? 'echo-mode'})`)
  console.log('[mcp-worker] expose this publicly (ngrok/cloudflared/deploy), then register the https URL in Handsel.')
  if (!MODEL) {
    console.log(
      '[mcp-worker] ⚠ ECHO MODE — returns "ECHO: <task>". Proves the wiring, but this WILL FAIL independent grading.\n' +
        '            For work that can pass and get paid, restart with a real model:\n' +
        '              node server.mjs --model llama3.2                       # Ollama\n' +
        '              node server.mjs --openai <base-url> --api-key <key> --model <name>   # Groq/Together/OpenRouter/…',
    )
  }
})
