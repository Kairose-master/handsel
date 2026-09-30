import test from 'node:test'
import assert from 'node:assert/strict'
import { newState, normalizeLead, qualify, makeDraft, canApprove, recordStage, funnelMetrics } from '../src/core.js'

const sample = () => normalizeLead({ full_name: 'maker/research-agent', html_url: 'https://github.com/maker/research-agent', owner: { login: 'maker', html_url: 'https://github.com/maker' }, description: 'LangGraph research agent with MCP tools and paid marketplace integrations', topics: ['langgraph','mcp'], pushed_at: new Date().toISOString(), readme: 'Executes browser research and submits reports' })

test('scores active agents and writes a repo-specific earning rationale', () => {
  const lead = sample()
  assert.ok(lead.score >= 70)
  const result = qualify(lead)
  assert.equal(result.qualified, true)
  const draft = makeDraft(lead)
  assert.match(draft, /research-agent/)
  assert.match(draft, /LangGraph/)
  assert.match(draft, /independent verification/)
})

test('dedupe key and provenance are retained for audit', () => {
  const lead = sample()
  assert.equal(lead.sourceUrl, 'https://github.com/maker/research-agent')
  assert.match(lead.provenance, /^github:/)
  assert.equal(lead.contactType, 'public_profile')
})

test('approval requires human gate, enforces suppression and daily cap', () => {
  const state = newState(), lead = sample()
  lead.status = 'approval_pending'; state.leads.push(lead)
  assert.equal(canApprove(state, lead.id).ok, true)
  lead.approvedAt = new Date().toISOString()
  assert.equal(canApprove(state, lead.id, { dailyCap: 1 }).reason, 'daily cap reached')
  lead.approvedAt = undefined
  state.suppressions.push({ leadId: lead.id })
  assert.equal(canApprove(state, lead.id).reason, 'suppressed')
  state.settings.approval_required = false
  assert.equal(canApprove(state, lead.id).ok, false)
})

test('funnel tracks verified payout north star and repeat payout', () => {
  let lead = sample()
  lead = recordStage(lead, 'qualified')
  lead = recordStage(lead, 'first_verified_payout')
  lead = recordStage(lead, 'repeat_payout')
  const metrics = funnelMetrics([lead])
  assert.equal(metrics.first_verified_payout, 1)
  assert.equal(metrics.repeat_payout, 1)
  assert.equal(metrics.north_star_external_agents_with_verified_payout, 1)
})
