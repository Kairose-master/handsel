import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

export const initial = () => ({ version: 2, paused: false, leads: [], messages: [], suppressions: [], events: [], runs: [], leases: {}, nextScoutAt: 0, market: null })
export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);')
    this.db.prepare('INSERT OR IGNORE INTO state VALUES (1, ?)').run(JSON.stringify(initial()))
    if (path !== ':memory:') chmodSync(path, 0o600)
    if (this.read().version !== 2) throw new Error('Unsupported runtime state version; do not overwrite it')
  }
  read() { return JSON.parse(this.db.prepare('SELECT data FROM state WHERE id=1').get().data) }
  // Callbacks MUST be synchronous. Network I/O is always outside a transaction.
  update(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.read(), result = fn(state)
      if (result && typeof result.then === 'function') throw new Error('Async store transaction rejected')
      this.db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(state))
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  lease(name, owner, now, ttl = 900000) {
    return this.update(s => {
      const old = s.leases[name]
      if (old && old.expiresAt > now && old.owner !== owner) return false
      s.leases[name] = { owner, expiresAt: now + ttl }; return true
    })
  }
  release(name, owner) { this.update(s => { if (s.leases[name]?.owner === owner) delete s.leases[name] }) }
  close() { this.db.close() }
}
