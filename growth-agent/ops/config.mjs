import { resolve } from 'node:path'
import { growthConfig } from '../src/config.js'

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return value
}
function flag(env, name, fallback) {
  const value = env[name] ?? String(fallback)
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`)
  return value === 'true'
}
export function safeOrigin(value) {
  const u = new URL(value)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(local && u.protocol === 'http:'))) throw new Error('Use HTTPS, or HTTP on loopback, without credentials/query/fragment')
  return u.href.replace(/\/$/, '')
}
export function config(env = process.env) {
  const legacy = growthConfig(env)
  const queries = JSON.parse(env.GROWTH_QUERIES || '["MCP agent language:TypeScript archived:false fork:false","LangGraph agent language:Python archived:false fork:false"]')
  if (!Array.isArray(queries) || !queries.length || queries.length > 5 || queries.some(q => typeof q !== 'string' || q.length > 300)) throw new Error('GROWTH_QUERIES must contain 1-5 query strings')
  const c = {
    dbPath: resolve(legacy.dataDir, 'ops.sqlite'), handselUrl: safeOrigin(legacy.handselUrl),
    token: env.GROWTH_ADMIN_TOKEN || '', host: env.GROWTH_HOST || '127.0.0.1',
    port: integer(env, 'GROWTH_PORT', 4318, 1, 65535),
    intervalMs: integer(env, 'GROWTH_SCOUT_INTERVAL_SECONDS', 21600, 60, 604800) * 1000,
    tickMs: integer(env, 'GROWTH_TICK_SECONDS', 60, 1, 3600) * 1000,
    maxRepos: integer(env, 'GROWTH_MAX_REPOS_PER_CYCLE', 10, 1, 30),
    maxLeads: integer(env, 'GROWTH_MAX_LEADS', 1000, 1, 5000),
    minScore: integer(env, 'GROWTH_MIN_SCORE', 60, 1, 100),
    sendCap: integer(env, 'GROWTH_SEND_DAILY_CAP', 5, 1, 20),
    dryRun: flag(env, 'GROWTH_DRY_RUN', true), sendEnabled: flag(env, 'GROWTH_SEND_ENABLED', false),
    githubToken: env.GITHUB_TOKEN || '', queries,
    excludeOwners: (env.GROWTH_EXCLUDE_OWNERS || 'Kairose-master').toLowerCase().split(',').map(x => x.trim()),
    resendKey: env.RESEND_API_KEY || '', from: env.GROWTH_FROM || '', replyTo: env.GROWTH_REPLY_TO || '',
    ollamaUrl: env.GROWTH_OLLAMA_URL ? safeOrigin(env.GROWTH_OLLAMA_URL) : null,
    ollamaModel: env.GROWTH_OLLAMA_MODEL || '',
    maxModelCalls: integer(env, 'GROWTH_MAX_MODEL_CALLS_PER_CYCLE', 3, 0, 10),
  }
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(c.host)) throw new Error('Unsupported GROWTH_HOST')
  if (c.ollamaUrl && !c.ollamaModel) throw new Error('GROWTH_OLLAMA_MODEL is required with GROWTH_OLLAMA_URL')
  if (c.sendEnabled && !c.dryRun && (!c.resendKey || !c.from || !c.replyTo)) throw new Error('Live sending requires RESEND_API_KEY, GROWTH_FROM and GROWTH_REPLY_TO')
  if ([c.from, c.replyTo].some(v => /[\r\n]/.test(v))) throw new Error('Mail configuration cannot contain newlines')
  return c
}
