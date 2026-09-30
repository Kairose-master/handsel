import { readFile } from 'node:fs/promises'

// Node 18-compatible, single-line .env reader. Never evaluates shell code,
// expands variables, or overwrites variables already set by the operator.
export async function loadLocalEnv(path = '.env', env = process.env) {
  let text
  try { text = await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) throw new Error(`Invalid .env assignment at line ${index + 1}`)
    const [, key, raw] = match
    let value
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0], end = raw.indexOf(quote, 1)
      if (end === -1 || (raw.slice(end + 1).trim() && !raw.slice(end + 1).trim().startsWith('#'))) {
        throw new Error(`Invalid .env quoted value at line ${index + 1}`)
      }
      value = raw.slice(1, end)
    } else value = raw.replace(/\s+#.*$/, '').trim()
    if (env[key] === undefined) env[key] = value
  }
}

export function growthConfig(env = process.env) {
  if ((env.GROWTH_APPROVAL_REQUIRED ?? 'true').trim().toLowerCase() !== 'true') {
    throw new Error('GROWTH_APPROVAL_REQUIRED must remain true; automatic outreach is not supported')
  }
  const dailyCap = Number(env.GROWTH_DAILY_CAP ?? 20)
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 1) {
    throw new Error('GROWTH_DAILY_CAP must be a positive safe integer')
  }
  const handselUrl = new URL(env.HANDSEL_BASE_URL || 'https://handsel-main.vercel.app')
  if (!['http:', 'https:'].includes(handselUrl.protocol) || handselUrl.username || handselUrl.password) {
    throw new Error('HANDSEL_BASE_URL must be an HTTP(S) URL without credentials')
  }
  return { dailyCap, dataDir: env.GROWTH_DATA_DIR || './data', handselUrl: handselUrl.href.replace(/\/$/, '') }
}
