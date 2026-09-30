import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { newState, normalizeLead, canApprove, makeDraft } from '../src/core.js'

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
const repo = (name = 'research-agent', owner = 'maker') => ({ full_name: `${owner}/${name}`, html_url: `https://github.com/${owner}/${name}`, owner: { login: owner, html_url: `https://github.com/${owner}` }, description: 'LangGraph agent with MCP tools', topics: ['langgraph'], pushed_at: new Date().toISOString() })
const pending = (name, owner) => ({ ...normalizeLead(repo(name, owner)), status: 'approval_pending', draft: 'Reviewed outreach draft' })
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'handsel-growth-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(GROWTH_|HANDSEL_|GITHUB_)/.test(key)) delete env[key]
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000 })
  const store = state => { mkdirSync(join(dir, 'data'), { recursive: true }); writeFileSync(join(dir, 'data/growth.json'), JSON.stringify(state)) }
  return { dir, run, store }
}
function ok(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout) }

test('CLI loads .env before using data directory and daily approval cap', t => {
  const { dir, run } = fixture(t)
  writeFileSync(join(dir, '.env'), 'GROWTH_DATA_DIR=private-data\nGROWTH_DAILY_CAP=1\nGROWTH_APPROVAL_REQUIRED=true\n')
  writeFileSync(join(dir, 'leads.json'), JSON.stringify([repo(), repo('coding-agent', 'other')]))
  ok(run(['import', 'leads.json']))
  assert.ok(existsSync(join(dir, 'private-data/growth.json')), '.env data directory must be used')
  ok(run(['qualify']))
  const queue = ok(run(['queue']))
  assert.equal(queue.length, 2)
  ok(run(['approve', queue[0].id]))
  const blocked = run(['approve', queue[1].id])
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /daily cap reached/)
})

test('export rechecks suppression after approval', t => {
  const { dir, run, store } = fixture(t)
  const state = newState(), lead = pending()
  lead.status = 'approved_ready'; lead.approvedAt = new Date().toISOString()
  state.leads.push(lead); store(state)
  ok(run(['suppress', lead.id, 'opt-out']))
  const result = ok(run(['export']))
  assert.equal(result.count, 0)
  assert.equal(result.sent, false)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'send-ready.json'), 'utf8')), [])
  assert.notEqual(run(['stage', lead.id, 'contacted']).status, 0)
})

test('suppression applies to another repo by the same owner', () => {
  const state = newState(), first = pending('a'), second = pending('b')
  state.leads.push(first, second)
  state.suppressions.push({ leadId: first.id, sourceUrl: first.sourceUrl })
  assert.equal(canApprove(state, second.id).reason, 'suppressed')
})

test('non-finite, negative and fractional caps fail closed', () => {
  const state = newState(), lead = pending()
  state.leads.push(lead)
  for (const dailyCap of [NaN, Infinity, -1, 0, 1.5]) assert.equal(canApprove(state, lead.id, { dailyCap }).ok, false, String(dailyCap))
})

test('GROWTH_APPROVAL_REQUIRED=false never bypasses approval or export', t => {
  const { run, store } = fixture(t)
  const state = newState(), lead = pending()
  state.leads.push(lead); store(state)
  const result = run(['approve', lead.id], { GROWTH_APPROVAL_REQUIRED: 'false' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /approval.*true/i)
})

test('drafts link to the real protocol document and do not assert tested capabilities', () => {
  const draft = makeDraft(pending())
  assert.match(draft, /github\.com\/Kairose-master\/handsel\/blob\/main\/docs\/agent-integration\.md/)
  assert.doesNotMatch(draft, /project already works with/)
})
