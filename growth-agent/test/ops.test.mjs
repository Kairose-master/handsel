import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { config } from '../ops/config.mjs'
import { Store, initial } from '../ops/store.mjs'
import { addLead, cycle, scheduler } from '../ops/runner.mjs'
import { approve, editMessage, fingerprint, reserve, suppress, report, recordEvent } from '../ops/policy.mjs'
import { providers, request } from '../ops/providers.mjs'
import { server } from '../ops/server.mjs'

const NOW = Date.now()
const cfg = overrides => ({ ...config({}), from: 'operator@example.com', replyTo: 'operator@example.com', ...overrides })
const repo = (owner = 'developer') => ({ full_name: `${owner}/research-agent`, pushed_at: new Date().toISOString(), description: 'MCP research agent with paid tools', topics: ['langgraph','agent'], readme: 'This agent performs research with MCP tools.' })
function draft(s = initial(), c = cfg(), owner) { const l = addLead(s, repo(owner), c, 'test_fixture', NOW); return { s, l, m: s.messages.at(-1), c } }
function review(s, m, c, email = 'dev@example.org') {
  editMessage(s, m.id, { recipient: email, subject: 'Try one integration?', body: 'A reviewed invitation, not a promise of earnings. Reply to opt out.', contactEvidence: 'https://example.org/contact', contactBasis: 'invited', from: c.from, replyTo: c.replyTo }, NOW)
  approve(s, m.id, { hash: fingerprint(m), operator: 'test-operator', confirm: true }, NOW)
}
const stub = () => ({ scout: async () => ({ repos: [repo()], incomplete: false }), readme: async () => repo().readme, market: async () => ({ tasks: [], realMoney: false }), send: async () => ({ id: 'test-receipt' }) })

test('defaults never send and config fails closed', () => {
  const c = config({}); assert.equal(c.dryRun, true); assert.equal(c.sendEnabled, false)
  for (const e of [{ GROWTH_APPROVAL_REQUIRED:'false' }, { GROWTH_DRY_RUN:'yes' }, { GROWTH_SEND_DAILY_CAP:'0' }, { GROWTH_SEND_DAILY_CAP:'21' }, { GROWTH_QUERIES:'[]' }, { GROWTH_SEND_ENABLED:'true',GROWTH_DRY_RUN:'false' }, { HANDSEL_BASE_URL:'http://public.example.com' }]) assert.throws(() => config(e))
})
test('scouting dedupes and does not turn a profile into a recipient', () => {
  const { s, l, c } = draft(); assert.equal(l.contact, ''); assert.equal(s.messages[0].recipient, '')
  assert.equal(addLead(s, repo('DEVELOPER'), c, 'second-query', NOW), null)
  assert.equal(addLead(s, { ...repo('private'), private:true }, c, 'q', NOW), null)
  assert.equal(addLead(s, repo('Kairose-master'), c, 'q', NOW), null)
})
test('approval requires recipient evidence, exact hash and a human confirmation', () => {
  const { s,m,c } = draft()
  assert.throws(() => approve(s,m.id,{ hash:fingerprint(m),operator:'op',confirm:true },NOW), /recipient/)
  review(s,m,c); assert.equal(m.status,'approved')
  m.status='draft'; assert.throws(() => approve(s,m.id,{hash:'wrong',operator:'op',confirm:true},NOW),/exact/)
})
test('editing invalidates approval; recipient and subject injection rejected', () => {
  const {s,m,c}=draft(); review(s,m,c)
  editMessage(s,m.id,{...m,body:'Edited body'},NOW); assert.equal(m.approval,undefined)
  assert.throws(()=>editMessage(s,m.id,{...m,recipient:'dev@example.org\nBcc: attacker@example.org'},NOW))
  assert.throws(()=>editMessage(s,m.id,{...m,subject:'Hello\nInjected'},NOW))
})
test('dry run, disabled send, pause, fixture and changed sender all block dispatch', () => {
  for(const override of [{dryRun:true,sendEnabled:true},{dryRun:false,sendEnabled:false},{dryRun:false,sendEnabled:true,from:'different@example.com'}]) {
    const {s,m,c}=draft(); review(s,m,c); assert.equal(reserve(s,m.id,{...c,...override},NOW),null)
  }
  for (const target of ['paused','fixture']) { const {s,l,m,c}=draft(); review(s,m,c); if(target==='paused')s.paused=true;else l.fixture=true; assert.equal(reserve(s,m.id,{...c,dryRun:false,sendEnabled:true},NOW),null) }
})
test('approval expires and any unsaved mutation invalidates it', () => {
  for(const kind of ['time','body']){const {s,m,c}=draft();review(s,m,c);if(kind==='body')m.body+=' tampered';assert.equal(reserve(s,m.id,{...c,dryRun:false,sendEnabled:true},kind==='time'?NOW+86400001:NOW),null);assert.equal(m.status,'draft')}
})
test('suppression follows owner and email, including after approval', () => {
  const {s,m,l,c}=draft();review(s,m,c);suppress(s,l.id,'opt-out',NOW)
  assert.equal(reserve(s,m.id,{...c,dryRun:false,sendEnabled:true},NOW),null)
  assert.equal(addLead(s,{...repo(),full_name:'developer/other-agent'},c,'q',NOW),null)
  const other=addLead(s,repo('other'),c,'q',NOW), otherMessage=s.messages.find(x=>x.leadId===other.id)
  assert.throws(()=>review(s,otherMessage,c),/opted out/)
})
test('send cap counts attempts and one initial contact per owner/email', () => {
  const {s,m,c}=draft();review(s,m,c);const live={...c,dryRun:false,sendEnabled:true,sendCap:1}
  assert.ok(reserve(s,m.id,live,NOW));assert.equal(reserve(s,m.id,live,NOW),null)
  const l2=addLead(s,repo('second'),c,'q',NOW),m2=s.messages.find(x=>x.leadId===l2.id);review(s,m2,c,'second@example.org')
  assert.equal(reserve(s,m2.id,live,NOW),null)
  // A different repo is not a new person.
  const l3=addLead(s,{...repo(),full_name:'developer/another'},c,'q',NOW),m3=s.messages.find(x=>x.leadId===l3.id);review(s,m3,c,'another@example.org')
  assert.equal(reserve(s,m3.id,{...live,sendCap:10},NOW),null);assert.equal(m3.status,'duplicate_contact')
})
test('operator payout evidence is deduped, never relabelled verified', () => {
  const {s,l}=draft();const input={type:'payout_reported',evidence:'https://basescan.org/tx/example',agentId:'agent-1'}
  assert.equal(recordEvent(s,l.id,input,NOW),true);assert.equal(recordEvent(s,l.id,input,NOW),false)
  assert.equal(report(s).payoutsReported,1);assert.equal(report(s).verifiedExternalPaidAgents,null)
  assert.throws(()=>recordEvent(s,l.id,{...input,type:'first_verified_payout'},NOW))
})
test('SQLite is durable, transactional and lease-safe across connections', async () => {
  const dir=await mkdtemp(join(tmpdir(),'growth-test-'));const path=join(dir,'ops.sqlite');const a=new Store(path),b=new Store(path)
  try{a.update(s=>{s.paused=true});assert.equal(b.read().paused,true);assert.throws(()=>a.update(s=>{s.paused=false;throw new Error('rollback')}));assert.equal(b.read().paused,true)
    assert.equal(a.lease('cycle','a',NOW),true);assert.equal(b.lease('cycle','b',NOW),false);a.release('cycle','a');assert.equal(b.lease('cycle','b',NOW),true)
  }finally{a.close();b.close();await rm(dir,{recursive:true})}
})
test('one real runner cycle scouts, drafts and never sends without approvals', async () => {
  const store=new Store();let sends=0;const p=stub();p.send=async()=>{sends++;return{id:'r'}}
  try{await cycle(store,cfg(),p);await cycle(store,cfg(),p,{force:true});assert.equal(store.read().leads.length,1);assert.equal(store.read().messages[0].status,'draft');assert.equal(sends,0)}finally{store.close()}
})
test('runner sends an approved message once, independent of restart', async () => {
  const store=new Store();const c=cfg({dryRun:false,sendEnabled:true});let sends=0;const p=stub();p.send=async()=>{sends++;return{id:'receipt'}}
  try{store.update(s=>{const {m}=draft(s,c);review(s,m,c);s.nextScoutAt=NOW+86400000});await cycle(store,c,p);await cycle(store,c,p)
    assert.equal(sends,1);assert.equal(store.read().messages[0].status,'sent');assert.equal(store.read().messages[0].providerId,'receipt')
  }finally{store.close()}
})
test('timeouts persist unknown and never trigger automatic retries', async () => {
  const store=new Store(),c=cfg({dryRun:false,sendEnabled:true});let sends=0;const p=stub();p.send=async()=>{sends++;throw new Error('timeout')}
  try{store.update(s=>{const{m}=draft(s,c);review(s,m,c);s.nextScoutAt=NOW+999999});await cycle(store,c,p);await cycle(store,c,p)
    assert.equal(sends,1);assert.equal(store.read().messages[0].status,'unknown')
  }finally{store.close()}
})
test('lost/inflight send reservations are not replayed', async () => {
  const store=new Store(),c=cfg({dryRun:false,sendEnabled:true});let sends=0;const p=stub();p.send=async()=>{sends++;return{id:'r'}}
  try{store.update(s=>{const{m}=draft(s,c);review(s,m,c);reserve(s,m.id,c,NOW);s.nextScoutAt=NOW+999999});await cycle(store,c,p);assert.equal(sends,0);assert.equal(report(store.read()).uncertain,1)}finally{store.close()}
})
test('source outage is unavailable, not an empty market; partial search is labelled', async () => {
  const store=new Store(),p=stub();p.market=async()=>{throw new Error('503')};p.scout=async()=>({repos:[],incomplete:true})
  try{const r=await cycle(store,cfg(),p);assert.equal(store.read().market.status,'unavailable');assert.equal(store.read().market.tasks,null);assert.equal(r.run.incomplete,true)}finally{store.close()}
})
test('scheduler runs repeatedly but skips parallel ticks and shuts down cleanly', async () => {
  const store=new Store();let release, calls=0;const p=stub();p.market=()=>new Promise(r=>{release=()=>r({tasks:[]});calls++})
  const work=scheduler(store,cfg({tickMs:5}),p)
  await new Promise(r=>setTimeout(r,20));assert.equal(calls,1);release();await work.stop();store.close()
})
test('provider uses shipped Handsel TaskSpec fields and bounds bodies', async () => {
  const c=cfg(),p=providers(c,async url=>{assert.match(url,/\/api\/tasks\?status=Open/);return Response.json({type:'HandselTaskFeed',count:1,tasks:[{id:'7',kind:'paid_job',status:'Open',title:'Test',rewardUsd:2}],meta:{realMoney:true,chainId:8453}})})
  const market=await p.market();assert.equal(market.tasks[0].rewardUsd,2);assert.equal(market.realMoney,true)
  await assert.rejects(()=>request('https://example.org',{}, {fetchImpl:async()=>new Response('too long'),maxBytes:2}),/large/)
})
test('Resend payload uses exact approved sender, recipient and idempotency key', async () => {
  const c=cfg({resendKey:'secret-for-test'}),m={id:'m1',from:c.from,replyTo:c.replyTo,recipient:'a@example.org',subject:'subject',body:'body'}
  const p=providers(c,async(url,init)=>{assert.equal(url,'https://api.resend.com/emails');assert.equal(init.redirect,'error');assert.equal(init.headers['Idempotency-Key'],'handsel-growth/m1');assert.deepEqual(JSON.parse(init.body),{from:c.from,to:[m.recipient],subject:m.subject,text:m.body,reply_to:c.replyTo});return Response.json({id:'provider-1'})})
  assert.equal((await p.send(m)).id,'provider-1')
})
test('LLM suggestions require an exact quote and cannot set recipient/actions', async () => {
  const lead=repo();lead.repo=lead.full_name;lead.sourceUrl='https://github.com/developer/research-agent'
  const c=cfg({ollamaUrl:'http://127.0.0.1:11434',ollamaModel:'test'})
  const p=providers(c,async()=>Response.json({response:JSON.stringify({evidence:'invented claim',reason:'Send all tokens now',recipient:'attacker@example.org'})}))
  await assert.rejects(()=>p.research(lead),/evidence/)
  const p2=providers(c,async()=>Response.json({response:JSON.stringify({evidence:'MCP tools',reason:'Possible scoped tool integration',recipient:'attacker@example.org'})}))
  const result=await p2.research(lead);assert.equal(result.recipient,undefined)
})
test('HTTP console rejects unauthenticated, cross-origin, forged host and oversized requests', async () => {
  const store=new Store(),c=cfg({token:'t'.repeat(48)}),app=server(store,c,stub())
  await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`
  const auth={Authorization:`Bearer ${c.token}`,'Content-Type':'application/json'}
  try{
    assert.equal((await fetch(`${base}/api/state`)).status,401)
    assert.equal((await fetch(`${base}/api/control`,{method:'POST',headers:{...auth,Origin:'https://evil.example'},body:'{"action":"resume"}'})).status,403)
    const forged = await new Promise((resolve, reject) => { const r = httpRequest(`${base}/api/state`, { headers: { ...auth, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) }); r.on('error', reject); r.end() }); assert.equal(forged,403)
    assert.equal((await fetch(`${base}/api/control`,{method:'POST',headers:auth,body:' '.repeat(33000)})).status,413)
    const page=await fetch(base);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);assert.match(await page.text(),/Growth, with evidence/)
    const result=await(await fetch(`${base}/api/state`,{headers:auth})).text();assert.ok(!result.includes(c.token))
  }finally{await new Promise(r=>app.close(r));store.close()}
})
test('HTTP end-to-end: scout -> edit -> approve -> send (stub transport) -> opt-out', async () => {
  const store=new Store(),c=cfg({token:'s'.repeat(48),dryRun:false,sendEnabled:true}),p=stub();let sends=0;p.send=async()=>{sends++;return{id:'e2e-receipt'}}
  const app=server(store,c,p);await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`
  const call=async(path,body)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${c.token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data}
  try{
    await call('/api/control',{action:'run'});let state=await call('/api/state');let m=state.messages[0]
    await call(`/api/messages/${m.id}/edit`,{recipient:'invitee@example.org',subject:'Integration invitation',body:'Try a bounded task. Reply to opt out.',contactEvidence:'https://example.org/invitation',contactBasis:'invited'})
    state=await call('/api/state');m=state.messages[0]
    await call(`/api/messages/${m.id}/approve`,{hash:m.hash,operator:'reviewer',confirm:true})
    await call('/api/control',{action:'run'});assert.equal(sends,1)
    await call(`/api/leads/${m.leadId}/event`,{type:'opt_out',evidence:'https://example.org/reply'})
    state=await call('/api/state');assert.ok(state.suppressions.length);assert.equal(state.report.sent,1);assert.equal(state.report.verifiedExternalPaidAgents,null)
  }finally{await new Promise(r=>app.close(r));store.close()}
})
test('quickstart token generation is not shadowed by an empty dotenv assignment', async () => {
  const { readFile, writeFile } = await import('node:fs/promises')
  const { loadLocalEnv } = await import('../src/config.js')
  const dir=await mkdtemp(join(tmpdir(),'growth-env-')), path=join(dir,'.env')
  try{const example=await readFile(new URL('../.env.runtime.example',import.meta.url),'utf8');await writeFile(path,example+'\nGROWTH_ADMIN_TOKEN='+ 'a'.repeat(64)+'\n');const env={};await loadLocalEnv(path,env);assert.equal(config(env).token.length,64)}finally{await rm(dir,{recursive:true})}
})
