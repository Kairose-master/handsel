import { randomUUID } from 'node:crypto'

const relevant = /mcp|langgraph|langchain|openai.?agents|crewai|claude|codex|agent|tool.?use/i
const execution = /agent|tool|mcp|workflow|browser|code|execute|automation/i
const money = /marketplace|bounty|paid|payment|commerce|invoice|earn|monetiz/i

export function scoreLead(repo, now = Date.now()) {
  const text = [repo.description, ...(repo.topics ?? []), repo.name, repo.readme].filter(Boolean).join(' ')
  const updated = Date.parse(repo.pushed_at || repo.updated_at || '')
  const days = Number.isFinite(updated) ? Math.max(0, (now - updated) / 86400000) : 9999
  const activity = days <= 30 ? 25 : days <= 90 ? 17 : days <= 180 ? 8 : 0
  const agent = /agent/i.test(text) ? 18 : 0
  const toolExecution = execution.test(text) ? 15 : 0
  const framework = relevant.test(text) ? 20 : 0
  const contact = repo.email || repo.contact_url ? 10 : 0
  const market = money.test(text) ? 12 : 0
  return { score: activity + agent + toolExecution + framework + contact + market, signals: { activity, agent, toolExecution, framework, contact, market } }
}

export function normalizeLead(repo, { provenance = 'github:search/repositories', now = new Date().toISOString() } = {}) {
  const owner = repo.owner ?? {}
  const identity = repo.html_url || `https://github.com/${owner.login}/${repo.name}`
  const readme = (repo.readme ?? '').slice(0, 12000)
  const normalized = {
    id: randomUUID(), source: 'github', sourceUrl: identity, provenance, discoveredAt: now,
    repo: repo.full_name || `${owner.login}/${repo.name}`, owner: owner.login || repo.owner_login || '',
    description: repo.description || '', topics: repo.topics || [], readme,
    contact: repo.email || repo.contact_url || repo.owner?.html_url || '',
    contactType: repo.email ? 'public_repository_email' : repo.contact_url ? 'public_contact_url' : 'public_profile',
    lastActivityAt: repo.pushed_at || repo.updated_at || null,
    status: 'lead_found', history: [{ stage: 'lead_found', at: now }],
  }
  return { ...normalized, ...scoreLead({ ...repo, readme }) }
}

export function qualify(lead, minimum = 35) {
  return { ...lead, qualified: lead.score >= minimum }
}

export function makeDraft(lead, handselUrl = 'https://handsel.ai') {
  const capabilities = [...new Set([...(lead.topics || []), lead.description || '', lead.readme || ''].join(' ').match(/MCP|LangGraph|LangChain|OpenAI Agents|CrewAI|Claude|Codex|browser|coding|research|automation/gi) || [])]
  const why = capabilities.length
    ? `Your ${lead.repo} project already works with ${capabilities.slice(0, 3).join(', ')}. That makes it a plausible worker for scoped research, coding, or tool-use jobs on Handsel: your existing agent can claim a task, submit its result for independent verification, and earn when it passes.`
    : `Your ${lead.repo} project describes an executable agent/tool workflow. That could fit Handsel's paid jobs: your existing agent can claim a scoped task, submit its result for independent verification, and earn when it passes.`
  return `Hi ${lead.owner || 'there'} — I found ${lead.repo} (${lead.sourceUrl}). ${why}\n\nHandsel's existing worker API and Node SDK are documented here: ${handselUrl}/docs/agent-integration. Would you be open to trying one small task together? I can help adapt your current agent; no rewrite is needed.\n\nIf this is not relevant, tell me and I will not follow up.`
}

export function canApprove(state, leadId, { now = new Date(), dailyCap = 20 } = {}) {
  if (state.settings.approval_required !== true) return { ok: false, reason: 'approval_required must remain true' }
  if (state.suppressions.some(x => x.leadId === leadId)) return { ok: false, reason: 'suppressed' }
  const lead = state.leads.find(x => x.id === leadId)
  if (!lead) return { ok: false, reason: 'lead not found' }
  const day = now.toISOString().slice(0, 10)
  const count = state.leads.filter(x => x.approvedAt?.slice(0, 10) === day).length
  if (count >= dailyCap) return { ok: false, reason: 'daily cap reached' }
  if (lead.status !== 'approval_pending') return { ok: false, reason: 'lead is not awaiting approval' }
  return { ok: true }
}

export function recordStage(lead, stage, at = new Date().toISOString()) {
  const allowed = ['lead_found','qualified','contacted','replied','integrated','claimed_job','completed_job','first_verified_payout','repeat_payout']
  if (!allowed.includes(stage)) throw new Error(`Unknown funnel stage: ${stage}`)
  if (stage === 'contacted' && lead.status !== 'approved_ready') throw new Error('Only approved drafts can be marked contacted')
  return { ...lead, status: stage, history: [...lead.history, { stage, at }] }
}

export function funnelMetrics(leads) {
  const count = stage => leads.reduce((n, l) => n + (l.history.some(h => h.stage === stage) ? 1 : 0), 0)
  return { ...Object.fromEntries(['lead_found','qualified','contacted','replied','integrated','claimed_job','completed_job','first_verified_payout','repeat_payout'].map(s => [s, count(s)])), north_star_external_agents_with_verified_payout: new Set(leads.filter(l => l.history.some(h => h.stage === 'first_verified_payout')).map(l => l.owner || l.id)).size }
}

export function newState() { return { version: 1, settings: { approval_required: true }, leads: [], suppressions: [] } }
