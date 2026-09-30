import { createHash, randomUUID } from 'node:crypto'
import { normalizeLead, makeDraft } from '../src/core.js'
import { audit, reserve, suppressed, iso, report } from './policy.mjs'

export function addLead(s, repo, c, query, now) {
  if (!repo || typeof repo.full_name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name) || repo.private || repo.archived || repo.fork) return null
  const [owner, name] = repo.full_name.split('/'), sourceUrl = `https://github.com/${owner}/${name}`
  if (c.excludeOwners.includes(owner.toLowerCase()) || s.leads.some(l => l.repo.toLowerCase() === repo.full_name.toLowerCase()) || s.leads.length >= c.maxLeads) return null
  const normalized = normalizeLead({ ...repo, name, owner: { login: owner, html_url: `https://github.com/${owner}` }, html_url: sourceUrl }, { provenance: query, now: iso(now) })
  if (suppressed(s, normalized)) return null
  // Never promote guessed or scraped contact fields into an actual recipient.
  const lead = { ...normalized, contact: '', contactType: 'needs_human_contact_review', fixture: repo.fixture === true, observations: [] }
  lead.sourceHash = createHash('sha256').update(lead.readme + lead.description).digest('hex')
  lead.evidence = { sourceUrl: `${sourceUrl}#readme`, excerpt: lead.readme.slice(0, 240), fetchedAt: iso(now), executed: false }
  lead.status = lead.score >= c.minScore ? 'qualified' : 'research_only'
  s.leads.push(lead)
  if (lead.status === 'qualified') {
    const id = randomUUID()
    // Referral tag is an attribution hint, never proof of identity or a payout.
    const target = new URL(c.handselUrl); target.searchParams.set('utm_source', 'handsel-growth'); target.searchParams.set('utm_content', id)
    s.messages.push({ id, leadId: lead.id, status: 'draft', recipient: '', subject: `An earning integration for ${name}`.slice(0, 160), body: makeDraft(lead, target.href), createdAt: iso(now), contactEvidence: '', contactBasis: '', from: c.from, replyTo: c.replyTo })
  }
  audit(s, 'lead_found', { leadId: lead.id, query }, now)
  return lead
}
export async function cycle(store, c, p, { force = false, now = () => Date.now() } = {}) {
  const owner = randomUUID(), started = now()
  if (store.read().paused || !store.lease('cycle', owner, started)) return { skipped: true }
  const timer = setInterval(() => store.lease('cycle', owner, now()), 15000)
  timer.unref()
  const run = { id: randomUUID(), startedAt: iso(started), found: 0, incomplete: false, errors: [], modelCalls: 0, sent: 0 }
  const stillOwner = s => {
    if (s.leases.cycle?.owner !== owner || s.leases.cycle.expiresAt <= now()) throw new Error('Lease lost')
  }
  try {
    const before = store.read()
    if (force || before.nextScoutAt <= now()) {
      // Persist the schedule BEFORE I/O: a crash does not create a tight retry loop.
      store.update(s => { stillOwner(s); s.nextScoutAt = now() + c.intervalMs })
      try {
        const market = await p.market()
        store.update(s => { stillOwner(s); s.market = { status: 'ok', ...market } })
      } catch {
        run.errors.push('market_unavailable')
        store.update(s => { stillOwner(s); s.market = { status: 'unavailable', checkedAt: now(), tasks: null } })
      }
      let inspected = 0
      for (const query of c.queries) {
        if (store.read().paused || inspected >= c.maxRepos) break
        let batch
        try { batch = await p.scout(query) } catch { run.errors.push('github_search_failed'); continue }
        run.incomplete ||= batch.incomplete
        for (const repo of batch.repos) {
          if (store.read().paused || inspected >= c.maxRepos) break
          const state = store.read()
          if (!repo.full_name || state.leads.some(l => l.repo.toLowerCase() === repo.full_name.toLowerCase()) || c.excludeOwners.includes(String(repo.full_name).split('/')[0].toLowerCase()) || repo.archived || repo.fork || repo.private) continue
          inspected++
          let readme = ''
          try { readme = await p.readme(repo.full_name) } catch { run.errors.push('readme_unavailable') }
          const lead = store.update(s => { stillOwner(s); if (s.paused) return null; return addLead(s, { ...repo, readme }, c, `github_search:${query}`, now()) })
          if (!lead) continue
          run.found++
          if (c.ollamaUrl && lead.status === 'qualified' && run.modelCalls < c.maxModelCalls) {
            run.modelCalls++
            try {
              const suggestion = await p.research(lead)
              store.update(s => { stillOwner(s); const l = s.leads.find(l => l.id === lead.id); l.research = suggestion })
            } catch { run.errors.push('model_suggestion_rejected_or_unavailable') }
          }
        }
      }
    }
    for (const id of store.read().messages.filter(m => m.status === 'approved').map(m => m.id)) {
      const message = store.update(s => { stillOwner(s); return reserve(s, id, c, now()) })
      if (!message) continue
      // No auto-retry after an attempted send, even after the provider's 24h
      // idempotency window. A timeout/crash means unknown, not unsent.
      try {
        const receipt = await p.send(message)
        store.update(s => {
          const m = s.messages.find(m => m.id === id)
          m.status = 'sent'; m.providerId = receipt.id; m.sentAt = iso(now()); run.sent++
          audit(s, 'provider_accepted', { messageId: id, providerId: receipt.id }, now())
        })
      } catch (error) {
        store.update(s => {
          const m = s.messages.find(m => m.id === id)
          m.status = error.status >= 400 && error.status < 500 && error.status !== 408 ? 'failed' : 'unknown'
          m.error = 'Provider rejected or delivery uncertain; inspect provider logs. No automatic retry.'
          audit(s, 'send_not_confirmed', { messageId: id, status: m.status }, now())
        })
      }
    }
  } catch { run.errors.push('cycle_interrupted_or_lease_lost') }
  finally {
    clearInterval(timer)
    store.update(s => { run.finishedAt = iso(now()); s.runs.push(run); s.runs = s.runs.slice(-100) })
    store.release('cycle', owner)
  }
  return { run, report: report(store.read(), now()) }
}
export function scheduler(store, c, p, onError = () => {}) {
  let busy = null, closing = false
  const tick = () => {
    if (busy || closing) return busy
    busy = cycle(store, c, p).catch(onError).finally(() => { busy = null })
    return busy
  }
  const timer = setInterval(tick, c.tickMs)
  void tick()
  return { tick, async stop() { closing = true; clearInterval(timer); await busy } }
}
