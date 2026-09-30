#!/usr/bin/env node
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { resolve } from 'node:path'
import { normalizeLead, qualify, makeDraft, canApprove, recordStage, funnelMetrics, isSuppressed, approvedDrafts } from './core.js'
import { load, save } from './store.js'
import { searchRepos, fetchReadme } from './github.js'
import { loadLocalEnv, growthConfig } from './config.js'

async function main() {
  await loadLocalEnv()
  const config = growthConfig()
  const args = process.argv.slice(2), command = args.shift()
  const dataPath = resolve(config.dataDir, 'growth.json')
  const state = await load(dataPath)
  const persist = () => save(dataPath, state)
  const print = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  const selectedLead = () => {
    const lead = state.leads.find(item => item.id === args[0])
    if (!lead) throw new Error('lead not found')
    return lead
  }

  if (command === 'scout') {
    const query = args.join(' ') || 'agent MCP language:TypeScript'
    let added = 0
    for (const repo of await searchRepos(query)) {
      if (state.leads.some(lead => lead.sourceUrl === repo.html_url)) continue
      let readme = ''
      try { readme = await fetchReadme(repo.full_name) } catch { /* qualification remains metadata-only */ }
      const lead = normalizeLead({ ...repo, readme }, { provenance: `github:search/repositories?q=${encodeURIComponent(query)}` })
      if (isSuppressed(state, lead)) continue
      state.leads.push(lead); added += 1
    }
    await persist(); print({ added, total: state.leads.length, query })
  } else if (command === 'import') {
    if (!args[0]) throw new Error('Usage: import <json-file>')
    const rows = JSON.parse(await readFile(resolve(args[0]), 'utf8'))
    if (!Array.isArray(rows)) throw new Error('Import must be a JSON array of repository records')
    let added = 0
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.html_url !== 'string' || !row.html_url.startsWith('https://github.com/')) {
        throw new Error('Each imported record must have a GitHub html_url; HN/Reddit records must link to a repository')
      }
      if (state.leads.some(lead => lead.sourceUrl === row.html_url)) continue
      const lead = normalizeLead(row, { provenance: `manual-import:${args[0]}` })
      if (isSuppressed(state, lead)) continue
      state.leads.push(lead); added += 1
    }
    await persist(); print({ imported: added, total: state.leads.length })
  } else if (command === 'leads' || command === 'queue') {
    const list = state.leads.filter(lead => command === 'queue' ? lead.status === 'approval_pending' && !isSuppressed(state, lead) : true)
    print(list.map(({ id, repo, owner, score, status, sourceUrl, contact, draft }) => ({ id, repo, owner, score, status, sourceUrl, contact, draft })))
  } else if (command === 'qualify') {
    const minimum = Number(args[0] ?? 35)
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) throw new Error('Minimum score must be between 0 and 100')
    for (const lead of state.leads) if (lead.status === 'lead_found' && !isSuppressed(state, lead)) {
      const result = qualify(lead, minimum)
      Object.assign(lead, result)
      if (result.qualified) {
        lead.draft = makeDraft(lead, config.handselUrl)
        lead.status = 'approval_pending'
        lead.history.push({ stage: 'qualified', at: new Date().toISOString() })
      }
    }
    await persist(); print({ pending: state.leads.filter(lead => lead.status === 'approval_pending' && !isSuppressed(state, lead)).length })
  } else if (command === 'approve') {
    const gate = canApprove(state, args[0], { dailyCap: config.dailyCap })
    if (!gate.ok) throw new Error(`Cannot approve: ${gate.reason}`)
    const lead = selectedLead()
    lead.status = 'approved_ready'; lead.approvedAt = new Date().toISOString()
    lead.history.push({ stage: 'approved_ready', at: lead.approvedAt })
    await persist(); print({ status: lead.status, draft: lead.draft, note: 'No message was sent. Export this approved draft for a human-operated channel.' })
  } else if (command === 'export') {
    const out = resolve(args[0] || './send-ready.json')
    if ([dataPath, resolve('.env')].includes(out)) throw new Error('Export must not overwrite the lead store or .env')
    const leads = approvedDrafts(state)
    await writeFile(out, JSON.stringify(leads.map(lead => ({ id: lead.id, channel: lead.contactType, recipient: lead.contact, provenance: lead.provenance, draft: lead.draft })), null, 2), { flag: 'w', mode: 0o600 })
    await chmod(out, 0o600)
    print({ exported: out, count: leads.length, sent: false })
  } else if (command === 'stage') {
    const lead = selectedLead()
    if (args[1] === 'contacted' && isSuppressed(state, lead)) throw new Error('Cannot mark a suppressed lead contacted')
    Object.assign(lead, recordStage(lead, args[1])); await persist(); print(lead)
  } else if (command === 'suppress') {
    const lead = selectedLead(), at = new Date().toISOString()
    state.suppressions.push({ leadId: lead.id, sourceUrl: lead.sourceUrl, owner: lead.owner, contact: lead.contact, at, reason: args.slice(1).join(' ') || 'manual' })
    lead.status = 'suppressed'; lead.history.push({ stage: 'suppressed', at })
    await persist(); print({ suppressed: lead.id })
  } else if (command === 'metrics') print(funnelMetrics(state.leads))
  else print('Commands: scout <GitHub query> | import <json-file> | leads | qualify [min-score] | queue | approve <lead-id> | export [file] | stage <lead-id> <stage> | suppress <lead-id> [reason] | metrics')
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
