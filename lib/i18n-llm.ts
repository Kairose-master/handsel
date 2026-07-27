/**
 * Server-side LLM translation core for runtime i18n. Same prompt contract
 * as scripts/translate-dict.mjs (the build-time twin) — if you change the
 * rules here, mirror them there.
 *
 * The API key is resolved at call time, BYOK-first: the calling admin's
 * registered Anthropic key (Settings → API key) wins, then the platform's
 * ANTHROPIC_API_KEY. Translations land in the i18nString table, never in
 * source files — static dictionaries always take precedence over them.
 */
import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-opus-4-8'

const SYSTEM = `You are the product-copy translator for Handsel, a credit-infrastructure dashboard for AI agents (credit scores, escrowed jobs, on-chain wallets, a "mining"-themed worker console). Translate UI strings so they read like a serious financial product written by a native speaker — confident, plain, never machine-translation stilted.

Hard rules:
- Keep in English: names of concrete UI controls the user must find on screen (e.g. "Provision", "Start mining", "Register in ERC-8004", "Your Agents", "On-Chain"), and proper nouns/standards (ERC-8004, Auto-mine, BYOK, USDC, Ollama, LM Studio, Claude, Anthropic, RTX 3060, GPU).
- Preserve punctuation intent (em-dashes, arrows like "→") and any placeholder tokens verbatim.
- Match the register of the reference translations when provided.
- Output ONLY a JSON object mapping each input key to its translation. No commentary, no code fences.`

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * Translate `entries` (key → English source) into `localeCode`.
 * `reference` is a small sample of existing translations whose voice the
 * model must match. Throws if the model omits any requested key.
 */
export async function translateStrings(
  apiKey: string,
  localeCode: string,
  entries: Record<string, string>,
  reference: Record<string, string>,
): Promise<Record<string, string>> {
  const client = new Anthropic({ apiKey })
  const referencePairs = Object.entries(reference).slice(0, 6)
  const prompt = [
    `Target language: ${languageName(localeCode)} (${localeCode}).`,
    referencePairs.length
      ? `Reference — existing ${localeCode} translations whose voice you must match:\n${JSON.stringify(Object.fromEntries(referencePairs), null, 2)}`
      : null,
    `Translate these English UI strings:\n${JSON.stringify(entries, null, 2)}`,
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
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/^```(?:json)?\s*|\s*```$/g, '')
  const parsed = JSON.parse(text) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const k of Object.keys(entries)) {
    const v = parsed[k]
    if (typeof v !== 'string' || !v.trim()) throw new Error(`model omitted key "${k}"`)
    out[k] = v
  }
  return out
}
