/**
 * Dogfood demand: turn the platform's own real i18n backlog (untranslated UI
 * strings in lib/i18n-dict.ts) into Labor Market jobs, and apply passing
 * results back into the runtime i18n overrides table so the work genuinely
 * ships. This is the anti-fake-data way to keep the board alive: the demand is
 * real because the repo actually needs these translations.
 *
 * Pure helpers only — the server action (app/actions/i18n-jobs.ts) does the
 * DB/chain work. Everything here is unit-tested.
 */
import { DICTIONARIES, LOCALES, type Locale } from '@/lib/i18n-dict'

/** Locales we solicit translations for, most-impactful first. en is the
 *  source of truth; ko/zh ship nearly complete so their gaps come first. */
export const I18N_JOB_LOCALES: Locale[] = ['zh', 'ko', 'ja', 'es', 'fr', 'de', 'pt', 'ru', 'hi', 'ar', 'id', 'vi']

export const I18N_JOB_TITLE_PREFIX = 'i18n → '
/** Keys per job — keeps the brief readable and the grading prompt bounded. */
export const I18N_JOB_CHUNK_SIZE = 12
export const I18N_JOB_BOUNTY_USD = 5
/** Score gate 0: translation jobs are deliberately open to brand-new workers. */
export const I18N_JOB_MIN_SCORE = 0

export function localeLabel(locale: Locale): string {
  return LOCALES.find((l) => l.value === locale)?.label ?? locale
}

/** Keys present in en but absent from the locale — the real backlog. */
export function missingKeysFor(locale: Locale): string[] {
  const en = DICTIONARIES.en
  const target = DICTIONARIES[locale] ?? {}
  return Object.keys(en)
    .filter((k) => !(k in target))
    .sort()
}

export function chunkKeys(keys: string[], size = I18N_JOB_CHUNK_SIZE): string[][] {
  const out: string[][] = []
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size))
  return out
}

export function i18nJobTitle(locale: Locale, keys: string[]): string {
  return `${I18N_JOB_TITLE_PREFIX}${locale}: translate ${keys.length} UI strings [${keys[0]}…]`
}

/** The locale a house job title targets, or null if it isn't an i18n job. */
export function localeOfI18nJobTitle(title: string): Locale | null {
  if (!title.startsWith(I18N_JOB_TITLE_PREFIX)) return null
  const rest = title.slice(I18N_JOB_TITLE_PREFIX.length)
  const code = rest.split(':')[0]?.trim()
  return I18N_JOB_LOCALES.includes(code as Locale) ? (code as Locale) : null
}

export function i18nJobDescription(locale: Locale, keys: string[]): string {
  const pairs: Record<string, string> = {}
  for (const k of keys) pairs[k] = DICTIONARIES.en[k] ?? ''
  return [
    `Translate the following ${keys.length} UI strings of this platform from English to ${localeLabel(locale)} (${locale}).`,
    '',
    'Source strings (key → English):',
    '```json',
    JSON.stringify(pairs, null, 2),
    '```',
    '',
    'Reply with ONLY a JSON object (optionally in a ```json fence) mapping every key above to its translation.',
    'Rules: preserve placeholders in braces like {n} or {amount} verbatim; keep product/technical names',
    '(Handsel, MCP, USDC, Claude, ChatGPT, GitHub) untranslated; match the tone of a product UI (concise, natural).',
  ].join('\n')
}

export function i18nJobAcceptanceCriteria(locale: Locale, keys: string[]): string {
  return [
    `- The submission is a single JSON object whose keys are EXACTLY these ${keys.length}: ${keys.join(', ')}`,
    `- Every value is a natural ${localeLabel(locale)} translation of the given English source — not English, not another language, not left empty`,
    '- Brace placeholders like {n} or {amount} appear verbatim in the translation wherever the source has them',
    '- Product names (Handsel, MCP, USDC, Claude, ChatGPT, GitHub) are not translated',
  ].join('\n')
}

/**
 * Parse a worker's submission into key→translation, defensively:
 * accepts a bare JSON object or one inside a ```/```json fence, ignores
 * surrounding prose, and returns only string values for the requested keys.
 * Returns null when nothing parseable is found — the caller treats that as
 * "nothing to apply", never a crash.
 */
export function parseTranslationSubmission(output: string, requestedKeys: string[]): Record<string, string> | null {
  const candidates: string[] = []
  const fence = /```(?:json)?\s*([\s\S]*?)```/g
  for (let m = fence.exec(output); m; m = fence.exec(output)) candidates.push(m[1]!)
  // Fall back to the widest {...} span in the raw text.
  const first = output.indexOf('{')
  const last = output.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(output.slice(first, last + 1))

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const out: Record<string, string> = {}
      for (const k of requestedKeys) {
        const v = (parsed as Record<string, unknown>)[k]
        if (typeof v === 'string' && v.trim()) out[k] = v.trim()
      }
      if (Object.keys(out).length > 0) return out
    } catch {
      /* try the next candidate */
    }
  }
  return null
}
