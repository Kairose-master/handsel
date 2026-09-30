import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLocalEnv, growthConfig } from '../src/config.js'

test('.env supports quoted hashes and preserves explicit environment values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, '.env')
  await writeFile(path, '# comment\nGITHUB_TOKEN="example#value"\nGROWTH_DATA_DIR="data with spaces"\nGROWTH_DAILY_CAP=2 # limit\n')
  const env = { GITHUB_TOKEN: 'operator-value' }
  await loadLocalEnv(path, env)
  assert.equal(env.GITHUB_TOKEN, 'operator-value')
  assert.equal(env.GROWTH_DATA_DIR, 'data with spaces')
  assert.equal(growthConfig(env).dailyCap, 2)
  const fresh = {}
  await loadLocalEnv(path, fresh)
  assert.equal(fresh.GITHUB_TOKEN, 'example#value')
})

test('malformed .env fails with a line number, not the value', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'growth-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, '.env')
  await writeFile(path, 'GITHUB_TOKEN="example-secret\n')
  await assert.rejects(loadLocalEnv(path, {}), error => {
    assert.match(error.message, /line 1/)
    assert.doesNotMatch(error.message, /example-secret/)
    return true
  })
})

test('config rejects invalid caps and approval bypass while allowing defaults', () => {
  assert.equal(growthConfig({}).dailyCap, 20)
  assert.equal(growthConfig({}).handselUrl, 'https://handsel-main.vercel.app')
  for (const value of ['NaN', 'Infinity', '0', '-1', '1.5', '']) {
    assert.throws(() => growthConfig({ GROWTH_DAILY_CAP: value }), /positive safe integer/)
  }
  assert.throws(() => growthConfig({ GROWTH_APPROVAL_REQUIRED: 'false' }), /must remain true/)
})
