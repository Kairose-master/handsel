// No innerHTML: all source/README/model text is untrusted and rendered as text.
let token = '', state
const $ = id => document.getElementById(id)
const node = (tag, text, parent) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; parent?.append(el); return el }
function field(parent, label, value = '', area = false) { const l = node('label', label, parent), input = node(area ? 'textarea' : 'input', undefined, l); input.value = value; return input }
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed'); return result
}
function action(parent, label, fn, secondary = false) {
  const button = node('button', label, parent); if (secondary) button.className = 'secondary'
  button.onclick = async () => { button.disabled = true; $('notice').textContent = ''; try { await fn(); await refresh() } catch(e) { $('notice').textContent = e.message } finally { button.disabled = false } }; return button
}
async function refresh() {
  state = await api('/api/state'); $('login').hidden = true; $('console').hidden = false
  $('mode').textContent = `${state.paused ? 'PAUSED · ' : ''}${state.mode.dryRun || !state.mode.sendEnabled ? 'NO LIVE SEND' : 'APPROVED SENDS ENABLED'}`
  $('metrics').replaceChildren()
  for (const [label, value] of [['Projects found', state.report.leads], ['Drafts to review', state.report.drafts], ['Provider accepted (not delivered)', state.report.sent], ['Payouts · operator reported', state.report.payoutsReported]]) { const box = node('div', undefined, $('metrics')); box.className = 'metric'; node('b', String(value), box); node('span', label, box) }
  $('verification').textContent = state.report.verificationNote
  $('market').textContent = JSON.stringify({ market: state.market, followUpReview: state.report.followUpReview, sendCapPerUtcDay: state.mode.sendCap, from: state.mode.from || 'Not configured', replyTo: state.mode.replyTo || 'Not configured' }, null, 2)
  $('runs').textContent = JSON.stringify(state.runs.slice(-5).reverse(), null, 2)
  $('events').textContent = JSON.stringify(state.events.slice(-15).reverse(), null, 2)
  render()
}
function render() {
  $('queue').replaceChildren()
  const messages = state.messages.filter(m => $('filter').value === 'all' || m.status === 'draft' || m.status === 'approved')
  if (!messages.length) node('p', 'No messages in this view. Run research, or import a reviewed project list.', $('queue'))
  for (const m of messages) {
    const lead = state.leads.find(l => l.id === m.leadId), card = node('article', undefined, $('queue')); card.className = 'card'
    node('h2', `${lead.repo}${lead.fixture ? ' [DEMO FIXTURE]' : ''}`, card)
    node('p', `${m.status} · metadata score ${lead.score}/100 · source not executed`, card).className = 'status'
    const evidence = node('details', undefined, card); node('summary', 'Research evidence & onboarding checklist', evidence)
    node('pre', JSON.stringify({ source: lead.sourceUrl, evidence: lead.evidence, suggestion: lead.research || null, onboarding: ['Use the existing Handsel worker integration document', 'Do not confuse an OAuth token with X-Runtime-Secret', 'Check an available job, gas, bond and capability requirements', 'Record a real job / payout reference, never infer it from wallet balance'] }, null, 2), evidence)
    const recipient = field(card, 'Reviewed recipient email (never auto-inferred)', m.recipient), contactEvidence = field(card, 'Contact evidence HTTPS URL', m.contactEvidence)
    const basisLabel = node('label', 'Contact basis', card), basis = node('select', undefined, basisLabel)
    for (const v of ['', 'invited', 'existing_conversation', 'public_business_contact']) { const opt = node('option', v || 'Choose after checking the channel', basis); opt.value = v }
    basis.value = m.contactBasis
    const subject = field(card, 'Subject', m.subject), body = field(card, 'Message to approve', m.body, true)
    const operator = field(card, 'Reviewer name', '')
    const checkLabel = node('label', undefined, card), check = node('input', undefined, checkLabel); check.type = 'checkbox'; checkLabel.append('I reviewed the recipient, contact basis and exact saved message.')
    const actions = node('div', undefined, card); actions.className = 'actions'
    action(actions, 'Save & invalidate approval', () => api(`/api/messages/${m.id}/edit`, { recipient: recipient.value, contactEvidence: contactEvidence.value, contactBasis: basis.value, subject: subject.value, body: body.value }))
    action(actions, 'Approve saved message', () => {
      if (!check.checked) throw new Error('Review and check the approval confirmation first')
      if ([recipient.value, contactEvidence.value, basis.value, subject.value, body.value].join('\0') !== [m.recipient,m.contactEvidence,m.contactBasis,m.subject,m.body].join('\0')) throw new Error('Save edits, then review the saved message before approval')
      return api(`/api/messages/${m.id}/approve`, { hash: m.hash, operator: operator.value, confirm: true })
    })
    action(actions, 'Reject', () => api(`/api/messages/${m.id}/reject`, {}), true)
    action(actions, 'Suppress person', () => api(`/api/leads/${lead.id}/suppress`, {}), true)
    const progress = node('details', undefined, card); node('summary', 'Record response / activation evidence', progress)
    const stageLabel = node('label', 'Observed stage', progress), stage = node('select', undefined, stageLabel)
    for (const v of ['replied','integrated','claimed_job','completed_job','payout_reported','opt_out','bounced']) { const o = node('option', v, stage); o.value = v }
    const url = field(progress, 'Evidence URL'), agent = field(progress, 'Agent ID (when known)')
    action(progress, 'Record as operator-reported', () => api(`/api/leads/${lead.id}/event`, { type: stage.value, evidence: url.value, agentId: agent.value }))
  }
}
$('unlock').onclick = async () => { token = $('token').value; $('token').value = ''; try { await refresh(); $('notice').textContent = '' } catch(e) { token = ''; $('notice').textContent = e.message } }
$('lock').onclick = () => { token = ''; state = null; $('queue').replaceChildren(); $('console').hidden = true; $('login').hidden = false; $('mode').textContent = 'Locked' }
$('refresh').onclick = () => refresh().catch(e => { $('notice').textContent = e.message })
$('filter').onchange = render
for (const name of ['run','pause','resume']) $(name).onclick = async () => { $(name).disabled = true; try { await api('/api/control', { action: name }); await refresh() } catch(e) { $('notice').textContent = e.message } finally { $(name).disabled = false } }
