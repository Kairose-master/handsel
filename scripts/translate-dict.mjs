#!/usr/bin/env node
/**
 * LLM-powered i18n dictionary maintenance for lib/i18n-dict.ts.
 *
 * English is the source of truth. This script diffs every other locale
 * against `en`, asks Claude to translate ONLY the missing keys (existing
 * human-reviewed strings are never overwritten), and writes the merged
 * dictionaries back in the file's own style. Adding a whole language is
 * one command — the Locale type, LOCALES entry, dictionary block, and
 * DICTIONARIES export are all updated.
 *
 *   node scripts/translate-dict.mjs                  # fill gaps in all locales
 *   node scripts/translate-dict.mjs --check          # report gaps, change nothing (no API key needed)
 *   node scripts/translate-dict.mjs --add ja --label 日本語   # add a new locale
 *
 * Requires ANTHROPIC_API_KEY (except --check).
 *
 * Runtime twin: lib/i18n-llm.ts + /api/admin/i18n do the same job from the
 * admin UI with a registered (BYOK) key, writing to the i18nString table
 * instead of this file. Keep the prompt rules in sync between the two.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DICT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'i18n-dict.ts')
const MODEL = 'claude-opus-4-8'

// ---------- CLI ----------
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const CHECK_ONLY = argv.includes('--check')
const ADD_LOCALE = flag('add')?.toLowerCase()
const ADD_LABEL = flag('label')
if (ADD_LOCALE && !/^[a-z]{2,3}(-[a-z0-9]+)?$/.test(ADD_LOCALE)) {
  console.error(`--add expects a BCP-47-ish code like "ja" or "pt-br", got "${ADD_LOCALE}"`)
  process.exit(1)
}
if (ADD_LOCALE && !ADD_LABEL) {
  console.error('--add requires --label with the language\'s native name (shown in the switcher), e.g. --label 日本語')
  process.exit(1)
}

// ---------- parse the dictionary file ----------
const source = readFileSync(DICT_PATH, 'utf8')

function extractDictBlock(src, name) {
  const start = src.indexOf(`const ${name}: Dict = {`)
  if (start === -1) return null
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return { start, end: i + 1, body: src.slice(open, i + 1) }
    }
  }
  throw new Error(`Unbalanced braces in dictionary "${name}"`)
}

function evalDict(body) {
  // Dictionary blocks are plain string-literal object bodies — safe to evaluate locally.
  return new Function(`return ${body}`)()
}

const localeCodes = [...source.matchAll(/\{ value: '([a-z-]+)', label: /g)].map((m) => m[1])
const dicts = {}
for (const code of localeCodes) {
  const block = extractDictBlock(source, code)
  if (!block) throw new Error(`LOCALES lists "${code}" but no "const ${code}: Dict" block exists`)
  dicts[code] = evalDict(block.body)
}
const en = dicts.en
if (!en) throw new Error('No `en` dictionary found — en is the source of truth and must exist')
const enKeys = Object.keys(en)

// ---------- work out what's missing ----------
const targets = localeCodes.filter((c) => c !== 'en')
if (ADD_LOCALE) {
  if (dicts[ADD_LOCALE]) {
    console.error(`Locale "${ADD_LOCALE}" already exists — run without --add to fill its gaps`)
    process.exit(1)
  }
  dicts[ADD_LOCALE] = {}
  targets.push(ADD_LOCALE)
}

const work = targets
  .map((code) => ({ code, missing: enKeys.filter((k) => !(k in dicts[code])) }))
  .filter((w) => w.missing.length > 0)

const stale = targets.flatMap((code) =>
  Object.keys(dicts[code]).filter((k) => !(k in en)).map((k) => `${code}:${k}`),
)
if (stale.length) console.warn(`⚠ keys not in en (left untouched, consider deleting): ${stale.join(', ')}`)

if (work.length === 0) {
  console.log('✓ every locale already covers all English keys — nothing to translate')
  process.exit(0)
}
for (const w of work) console.log(`${w.code}: ${w.missing.length} missing key(s)`)
if (CHECK_ONLY) process.exit(1)

// ---------- translate with Claude ----------
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — export it, then re-run (or use --check to just see gaps)')
  process.exit(1)
}
const { default: Anthropic } = await import('@anthropic-ai/sdk')
const client = new Anthropic()

const languageName = (code) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

const SYSTEM = `You are the product-copy translator for Handsel, a credit-infrastructure dashboard for AI agents (credit scores, escrowed jobs, on-chain wallets, a "mining"-themed worker console). Translate UI strings so they read like a serious financial product written by a native speaker — confident, plain, never machine-translation stilted.

Hard rules:
- Keep in English: names of concrete UI controls the user must find on screen (e.g. "Provision", "Start mining", "Register in ERC-8004", "Your Agents", "On-Chain"), and proper nouns/standards (ERC-8004, Auto-mine, BYOK, USDC, Ollama, LM Studio, Claude, Anthropic, RTX 3060, GPU).
- Preserve punctuation intent (em-dashes, arrows like "→") and any placeholder tokens verbatim.
- Match the register of the reference translations when provided.
- Output ONLY a JSON object mapping each input key to its translation. No commentary, no code fences.`

async function translate(code, missingKeys, existing) {
  const referencePairs = Object.entries(existing).slice(0, 6)
  const prompt = [
    `Target language: ${languageName(code)} (${code}).`,
    referencePairs.length
      ? `Reference — existing ${code} translations whose voice you must match:\n${JSON.stringify(Object.fromEntries(referencePairs), null, 2)}`
      : null,
    `Translate these English UI strings:\n${JSON.stringify(
      Object.fromEntries(missingKeys.map((k) => [k, en[k]])),
      null,
      2,
    )}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  })
  const message = await stream.finalMessage()
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/^```(?:json)?\s*|\s*```$/g, '')
  const parsed = JSON.parse(text)
  for (const k of missingKeys) {
    if (typeof parsed[k] !== 'string' || !parsed[k].trim()) throw new Error(`model omitted key "${k}" for ${code}`)
  }
  return parsed
}

for (const w of work) {
  process.stdout.write(`translating ${w.code} (${w.missing.length} keys)… `)
  const translated = await translate(w.code, w.missing, dicts[w.code])
  for (const k of w.missing) dicts[w.code][k] = translated[k]
  console.log('done')
}

// ---------- write the file back in its own style ----------
const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
// Blank-line grouping mirrors en: first two dotted segments for 3+-part keys, else the first.
const groupOf = (k) => {
  const parts = k.split('.')
  return parts.length >= 3 ? parts.slice(0, 2).join('.') : parts[0]
}

function renderDict(name, dict) {
  const lines = [`const ${name}: Dict = {`]
  let prevGroup = null
  for (const key of enKeys) {
    if (!(key in dict)) continue
    const g = groupOf(key)
    if (prevGroup !== null && g !== prevGroup) lines.push('')
    prevGroup = g
    const oneLine = `  ${quote(key)}: ${quote(dict[key])},`
    // Visual width, not code units — CJK glyphs count double, like Prettier sees them.
    const width = [...oneLine].reduce((w, ch) => w + (/[ᄀ-ￜ\u{20000}-\u{2FFFD}]/u.test(ch) ? 2 : 1), 0)
    if (width <= 100) lines.push(oneLine)
    else lines.push(`  ${quote(key)}:`, `    ${quote(dict[key])},`)
  }
  // Keys that exist in the locale but not in en survive at the bottom, untouched in value.
  for (const key of Object.keys(dict)) {
    if (enKeys.includes(key)) continue
    lines.push(`  ${quote(key)}: ${quote(dict[key])},`)
  }
  lines.push('}')
  return lines.join('\n')
}

let out = source
for (const code of targets) {
  if (code === ADD_LOCALE) continue
  // Re-extract from `out` each time: offsets shift after every replacement.
  const block = extractDictBlock(out, code)
  out = out.slice(0, block.start) + renderDict(code, dicts[code]) + out.slice(block.end)
}

if (ADD_LOCALE) {
  const rendered = renderDict(ADD_LOCALE, dicts[ADD_LOCALE])
  out = out
    .replace(/export type Locale = ([^\n]+)/, (m, union) => `export type Locale = ${union.trimEnd()} | '${ADD_LOCALE}'`)
    .replace(/\n\]\n/, `\n  { value: '${ADD_LOCALE}', label: '${ADD_LABEL}' },\n]\n`)
    .replace('export const DICTIONARIES', `${rendered}\n\nexport const DICTIONARIES`)
    .replace(/DICTIONARIES: Record<Locale, Dict> = \{ ([^}]+) \}/, (m, list) => `DICTIONARIES: Record<Locale, Dict> = { ${list}, ${ADD_LOCALE} }`)
}

writeFileSync(DICT_PATH, out)
console.log(`✓ wrote ${path.relative(process.cwd(), DICT_PATH)}`)
console.log('  review the diff, then commit — the model translates, you approve.')
