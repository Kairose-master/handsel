import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { newState } from './core.js'

export async function load(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return newState(); throw e }
}
export async function save(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}
