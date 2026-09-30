import { createHash, randomUUID } from 'node:crypto'

export const iso = now => new Date(now).toISOString()
export const norm = value => String(value || '').trim().toLowerCase()
export function audit(s, type, detail, now = Date.now()) {
  s.events.push({ id: randomUUID(), type, at: iso(now), ...detail })
  // Runs/events are bounded; messages/attempts and suppressions are retained.
  s.events = s.events.slice(-3000)
}
export const fingerprint = m => createHash('sha256').update(JSON.stringify([m.leadId, m.recipient, m.subject, m.body, m.contactEvidence, m.contactBasis, m.from, m.replyTo])).digest('hex')
export function suppressed(s, lead, recipient = '') {
  return s.suppressions.some(x => x.leadId === lead.id || (x.owner && norm(x.owner) === norm(lead.owner)) || (x.recipient && norm(x.recipient) === norm(recipient)))
}
export function suppress(s, leadId, reason, now) {
  const lead = s.leads.find(l => l.id === leadId)
  if (!lead) throw new Error('Lead not found')
  const messages = s.messages.filter(m => m.leadId === leadId)
  s.suppressions.push({ leadId, owner: lead.owner, reason, at: iso(now) }, ...messages.filter(m => m.recipient).map(m => ({ recipient: m.recipient, reason, at: iso(now) })))
  for (const m of s.messages) {
    const l = s.leads.find(l => l.id === m.leadId)
    if (suppressed(s, l, m.recipient) && !m.attemptedAt) { m.status = 'suppressed'; delete m.approval }
  }
  audit(s, 'suppressed', { leadId, reason }, now)
}
function checkText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`)
  // Preserve the C0 filter while allowing TAB, LF and CR in multiline text.
  // Inspect before trimming so leading/trailing controls cannot disappear.
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) throw new Error(`Invalid ${label}`)
  }
  return value.trim()
}
export function editMessage(s, id, input, now) {
  const m = s.messages.find(m => m.id === id)
  if (!m) throw new Error('Message not found')
  if (m.attemptedAt || m.status === 'rejected' || m.status === 'suppressed') throw new Error('Attempted/rejected/suppressed message is immutable')
  const recipient = norm(checkText(input.recipient, 'recipient', 254))
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(recipient)) throw new Error('A single reviewed email address is required')
  const subject = checkText(input.subject, 'subject', 160)
  if (/[\r\n]/.test(subject)) throw new Error('Subject cannot contain newlines')
  const body = checkText(input.body, 'body', 6000)
  const evidence = checkText(input.contactEvidence, 'contact evidence URL', 1000), url = new URL(evidence)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Contact evidence must be a HTTPS URL without credentials')
  if (!['invited', 'existing_conversation', 'public_business_contact'].includes(input.contactBasis)) throw new Error('Select a legitimate contact basis')
  Object.assign(m, { recipient, subject, body, contactEvidence: evidence, contactBasis: input.contactBasis, from: String(input.from || ''), replyTo: String(input.replyTo || ''), status: 'draft' })
  delete m.approval
  audit(s, 'draft_edited', { messageId: id }, now)
  return m
}
export function approve(s, id, input, now) {
  const m = s.messages.find(m => m.id === id), lead = s.leads.find(l => l.id === m?.leadId)
  if (!m || !lead || m.status !== 'draft' || m.attemptedAt) throw new Error('Only an unattempted draft can be approved')
  if (input.confirm !== true || input.hash !== fingerprint(m)) throw new Error('Approval must bind the exact reviewed message')
  if (!m.recipient || !m.contactEvidence || !m.contactBasis) throw new Error('Review the recipient and contact basis before approval')
  if (suppressed(s, lead, m.recipient)) throw new Error('Recipient opted out')
  m.approval = { hash: input.hash, operator: checkText(input.operator, 'operator', 100), at: iso(now), expiresAt: now + 86400000 }
  m.status = 'approved'
  audit(s, 'approved', { messageId: id, operator: m.approval.operator, hash: input.hash }, now)
  return m
}
export function reserve(s, id, c, now) {
  const m = s.messages.find(m => m.id === id), lead = s.leads.find(l => l.id === m?.leadId)
  if (!m || !lead || lead.fixture || s.paused || c.dryRun || !c.sendEnabled) return null
  if (m.status !== 'approved' || m.attemptedAt || !m.approval) return null
  if (m.from !== c.from || m.replyTo !== c.replyTo || m.approval.expiresAt <= now || m.approval.hash !== fingerprint(m)) { m.status = 'draft'; delete m.approval; return null }
  if (suppressed(s, lead, m.recipient)) { m.status = 'suppressed'; return null }
  const day = iso(now).slice(0, 10)
  if (s.messages.filter(x => x.attemptedAt?.slice(0, 10) === day).length >= c.sendCap) return null
  // At most one initial contact per known owner OR email; no automatic follow-up sends.
  if (s.messages.some(x => x.attemptedAt && (norm(x.recipient) === norm(m.recipient) || norm(s.leads.find(l => l.id === x.leadId)?.owner) === norm(lead.owner)))) { m.status = 'duplicate_contact'; return null }
  m.status = 'sending'; m.attemptedAt = iso(now)
  m.attemptHash = fingerprint(m)
  audit(s, 'send_reserved', { messageId: id }, now)
  return structuredClone(m)
}
export function recordEvent(s, leadId, input, now) {
  if (!s.leads.some(l => l.id === leadId)) throw new Error('Lead not found')
  if (!['replied', 'integrated', 'claimed_job', 'completed_job', 'payout_reported', 'opt_out', 'bounced'].includes(input.type)) throw new Error('Unsupported event; verified payout cannot be manually asserted')
  const evidence = checkText(input.evidence, 'event evidence URL', 1000)
  const u = new URL(evidence)
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('Evidence must be HTTPS')
  const key = createHash('sha256').update(JSON.stringify([leadId, input.type, evidence])).digest('hex')
  const lead = s.leads.find(l => l.id === leadId)
  lead.observations ??= []
  if (lead.observations.some(e => e.key === key)) return false
  lead.observations.push({ key, type: input.type, evidence, at: iso(now), source: 'operator_reported', agentId: String(input.agentId || '').slice(0, 128) })
  if (['opt_out', 'bounced'].includes(input.type)) suppress(s, leadId, input.type, now)
  audit(s, input.type, { leadId, source: 'operator_reported' }, now)
  return true
}
export function report(s, now = Date.now()) {
  const count = status => s.messages.filter(m => m.status === status).length
  const observed = stage => s.leads.filter(l => l.observations?.some(o => o.type === stage)).length
  const reportedAgents = new Set(s.leads.flatMap(l => (l.observations || []).filter(o => o.type === 'payout_reported' && o.agentId).map(o => o.agentId)))
  return { generatedAt: iso(now), paused: s.paused, leads: s.leads.length,
    drafts: count('draft'), approved: count('approved'), sent: count('sent'), uncertain: count('unknown') + count('sending'), failed: count('failed'),
    repliedReported: observed('replied'), integratedReported: observed('integrated'), payoutsReported: observed('payout_reported'), distinctAgentIdsReportedPaid: reportedAgents.size,
    verifiedExternalPaidAgents: null, verificationNote: 'Not connected to authenticated payout attribution. Reported evidence is not verified adoption.',
    followUpReview: s.messages.filter(m => m.status === 'sent' && now - Date.parse(m.sentAt) >= 7 * 86400000).filter(m => {
      const l = s.leads.find(l => l.id === m.leadId)
      return !suppressed(s, l, m.recipient) && !(l.observations || []).some(o => ['replied', 'opt_out', 'bounced'].includes(o.type))
    }).map(m => m.leadId), market: s.market, lastRun: s.runs.at(-1) || null }
}
