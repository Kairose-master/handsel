#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { normalizeLead, qualify, makeDraft, canApprove, recordStage, funnelMetrics } from './core.js'
import { load, save } from './store.js'
import { searchRepos, fetchReadme } from './github.js'

const args = process.argv.slice(2), command = args.shift(), dataPath = resolve(process.env.GROWTH_DATA_DIR || './data', 'growth.json')
const state = await load(dataPath)
const persist = () => save(dataPath, state)
const print = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))

try {
  if (command === 'scout') {
    const query = args.join(' ') || 'agent MCP language:TypeScript'
    for (const repo of await searchRepos(query)) {
      if (state.leads.some(l => l.sourceUrl === repo.html_url)) continue
      let readme = ''
      try { readme = await fetchReadme(repo.full_name) } catch {}
      const lead = normalizeLead({ ...repo, readme }, { provenance: `github:search/repositories?q=${encodeURIComponent(query)}` })
      state.leads.push(lead)
    }
    await persist(); print({ scanned: state.leads.length, query })
  } else if (command === 'import') {
    const rows = JSON.parse(await readFile(resolve(args[0]), 'utf8'))
    for (const row of rows) if (!state.leads.some(l => l.sourceUrl === row.html_url || l.sourceUrl === row.sourceUrl)) state.leads.push(normalizeLead(row, { provenance: `manual-import:${args[0]}` }))
    await persist(); print({ imported: state.leads.length })
  } else if (command === 'leads' || command === 'queue') {
    const list = state.leads.filter(l => command === 'queue' ? l.status === 'approval_pending' : true)
    print(list.map(({ id, repo, owner, score, status, sourceUrl, contact, draft }) => ({ id, repo, owner, score, status, sourceUrl, contact, draft })))
  } else if (command === 'qualify') {
    const min = Number(args[0] || 35)
    for (const lead of state.leads) if (lead.status === 'lead_found') {
      const q = qualify(lead, min); Object.assign(lead, q)
      if (q.qualified) { lead.draft = makeDraft(lead, process.env.HANDSEL_BASE_URL); lead.status = 'approval_pending'; lead.history.push({ stage: 'qualified', at: new Date().toISOString() }) }
    }
    await persist(); print({ pending: state.leads.filter(l => l.status === 'approval_pending').length })
  } else if (command === 'approve') {
    const id = args[0], gate = canApprove(state, id, { dailyCap: Number(process.env.GROWTH_DAILY_CAP || 20) })
    if (!gate.ok) throw new Error(`Cannot approve: ${gate.reason}`)
    const lead = state.leads.find(x => x.id === id)
    lead.status = 'approved_ready'; lead.approvedAt = new Date().toISOString(); lead.history.push({ stage: 'approved_ready', at: lead.approvedAt })
    await persist(); print({ status: lead.status, draft: lead.draft, note: 'No message was sent. Export this approved draft for a human-operated channel.' })
  } else if (command === 'export') {
    const out = resolve(args[0] || './send-ready.json')
    await writeFile(out, JSON.stringify(state.leads.filter(l => l.status === 'approved_ready').map(l => ({ id: l.id, channel: l.contactType, recipient: l.contact, provenance: l.provenance, draft: l.draft })), null, 2), { flag: 'w', mode: 0o600 })
    print({ exported: out, count: state.leads.filter(l => l.status === 'approved_ready').length, sent: false })
  } else if (command === 'stage') {
    const lead = state.leads.find(l => l.id === args[0]); if (!lead) throw new Error('lead not found')
    Object.assign(lead, recordStage(lead, args[1])); await persist(); print(lead)
  } else if (command === 'suppress') {
    const lead = state.leads.find(l => l.id === args[0]); if (!lead) throw new Error('lead not found')
    state.suppressions.push({ leadId: lead.id, sourceUrl: lead.sourceUrl, at: new Date().toISOString(), reason: args.slice(1).join(' ') || 'manual' }); await persist(); print({ suppressed: lead.id })
  } else if (command === 'metrics') print(funnelMetrics(state.leads))
  else print('Commands: scout <GitHub query> | import <json-file> | leads | qualify [min-score] | queue | approve <lead-id> | export [file] | stage <lead-id> <stage> | suppress <lead-id> [reason] | metrics')
} catch (error) { console.error(error.message); process.exitCode = 1 }
