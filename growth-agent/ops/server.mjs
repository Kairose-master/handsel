import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { approve, editMessage, fingerprint, recordEvent, report, suppress, audit } from './policy.mjs'
import { cycle } from './runner.mjs'

export function server(store, c, p) {
  if (typeof c.token !== 'string' || c.token.length < 32) throw new Error('GROWTH_ADMIN_TOKEN must contain at least 32 characters')
  const files = { '/': ['dashboard.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }
  return createServer(async (req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'")
    try {
      const host = req.headers.host || ''
      const local = new URL(`http://${host}`)
      if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) return json(403, { error: 'Access over a loopback URL or SSH tunnel' })
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(403, { error: 'Cross-origin requests rejected' })
      const path = new URL(req.url, `http://${host}`).pathname
      if (req.method === 'GET' && files[path]) {
        const [name, mime] = files[path]
        res.setHeader('content-type', `${mime}; charset=utf-8`)
        return res.end(await readFile(new URL(name, import.meta.url)))
      }
      if (req.method === 'GET' && path === '/healthz') return json(200, { status: 'ok' })
      const incoming = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${c.token}`)
      if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) return json(401, { error: 'Authentication required' })
      if (req.method === 'GET' && path === '/api/state') {
        const state = store.read()
        return json(200, { ...state, leases: undefined, messages: state.messages.map(m => ({ ...m, hash: fingerprint(m) })), report: report(state), mode: { dryRun: c.dryRun, sendEnabled: c.sendEnabled, sendCap: c.sendCap, from: c.from, replyTo: c.replyTo, ollama: Boolean(c.ollamaUrl) } })
      }
      if (req.method !== 'POST' || String(req.headers['content-type']).split(';')[0].trim() !== 'application/json') return json(405, { error: 'Use POST application/json' })
      const chunks = []; let bytes = 0
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) return json(413, { error: 'Request too large' }); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), now = Date.now()
      const match = /^\/api\/(messages|leads)\/([\w-]+)\/(edit|approve|reject|event|suppress)$/.exec(path)
      if (match) {
        const [, group, id, action] = match
        const result = store.update(s => {
          if (group === 'messages' && action === 'edit') return editMessage(s, id, { ...body, from: c.from, replyTo: c.replyTo }, now)
          if (group === 'messages' && action === 'approve') return approve(s, id, body, now)
          if (group === 'messages' && action === 'reject') {
            const m = s.messages.find(m => m.id === id)
            if (!m || m.attemptedAt) throw new Error('Message cannot be rejected')
            m.status = 'rejected'; delete m.approval; audit(s, 'rejected', { messageId: id }, now); return true
          }
          if (group === 'leads' && action === 'event') return recordEvent(s, id, body, now)
          if (group === 'leads' && action === 'suppress') { suppress(s, id, 'operator_opt_out', now); return true }
          throw new Error('Unknown action')
        })
        return json(200, { ok: true, result })
      }
      if (path === '/api/control') {
        if (body.action === 'run') return json(200, await cycle(store, c, p, { force: true }))
        if (!['pause', 'resume'].includes(body.action)) return json(400, { error: 'Unknown control action' })
        store.update(s => { s.paused = body.action === 'pause'; audit(s, body.action, { source: 'admin' }, now) })
        return json(200, { ok: true })
      }
      return json(404, { error: 'Not found' })
    } catch (error) {
      // Error messages originate in our validators, never from upstream mail bodies.
      return json(400, { error: error instanceof SyntaxError ? 'Invalid JSON/URL' : String(error.message).slice(0, 200) })
    }
  })
}
