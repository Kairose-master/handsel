#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadLocalEnv } from '../src/config.js'
import { config } from './config.mjs'
import { Store } from './store.mjs'
import { providers } from './providers.mjs'
import { addLead, cycle, scheduler } from './runner.mjs'
import { report, audit } from './policy.mjs'
import { server } from './server.mjs'

process.umask(0o077)
await loadLocalEnv()
const c = config(), store = new Store(c.dbPath), p = providers(c)
const [command = 'help', arg] = process.argv.slice(2)
try {
  if (command === 'serve') {
    const app = server(store, c, p)
    await new Promise((resolve, reject) => { app.once('error', reject); app.listen(c.port, c.host, resolve) })
    const worker = scheduler(store, c, p, () => console.error('Growth cycle failed; inspect the local run log'))
    console.log(`Growth console: http://127.0.0.1:${c.port} · ${c.dryRun || !c.sendEnabled ? 'NO LIVE SEND' : 'approved sends enabled'}`)
    let stopping = false
    const stop = async () => { if (stopping) return; stopping = true; await worker.stop(); await new Promise(resolve => app.close(resolve)); store.close() }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
  } else {
    if (command === 'run') console.log(JSON.stringify(await cycle(store, c, p, { force: true }), null, 2))
    else if (command === 'report') console.log(JSON.stringify(report(store.read()), null, 2))
    else if (command === 'pause' || command === 'resume') store.update(s => { s.paused = command === 'pause'; audit(s, command, { source: 'cli' }) })
    else if (command === 'import') {
      const rows = JSON.parse(await readFile(resolve(arg), 'utf8'))
      if (!Array.isArray(rows) || rows.length > c.maxLeads) throw new Error('Import must be a bounded array of public GitHub repository records; legacy CRM files are not accepted')
      const added = store.update(s => rows.reduce((n, r) => n + Number(Boolean(addLead(s, r, c, `manual_import:${resolve(arg)}`, Date.now()))), 0))
      console.log(JSON.stringify({ added, messagesSent: 0 }))
    } else if (command === 'demo') {
      store.update(s => { s.paused = true; addLead(s, { full_name: 'demo-fixture/research-agent', pushed_at: new Date().toISOString(), description: 'MCP research agent with paid tool execution', topics: ['mcp','agent'], readme: 'DEMO ONLY. A fictional research agent that uses tools; not a real prospect.', fixture: true }, c, 'synthetic_demo_fixture', Date.now()) })
      console.log('Added a clearly labelled, permanently non-sendable demo fixture. Scheduler paused.')
    } else console.log('Node 22.16+: node ops/main.mjs serve | run | report | pause | resume | import <public-repos.json> | demo')
    store.close()
  }
} catch (error) { console.error(error.message); store.close(); process.exitCode = 1 }
