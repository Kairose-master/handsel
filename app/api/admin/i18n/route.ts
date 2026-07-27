import { getSession } from '@/lib/get-session'
import { isSuperAdminEmail } from '@/lib/admin'
import { db } from '@/lib/db'
import { i18nLocale, i18nString } from '@/lib/db/schema'
import { DICTIONARIES, LOCALES, type Locale } from '@/lib/i18n-dict'
import { resolveUserAnthropicKey } from '@/lib/user-keys'
import { translateStrings } from '@/lib/i18n-llm'
import { eq, sql } from 'drizzle-orm'

/**
 * Runtime i18n admin — the "registered API key" path of the translation
 * pipeline (build-time twin: scripts/translate-dict.mjs).
 *
 *   GET  → per-locale coverage status + whether a usable API key exists
 *   POST {action:'translate', locale} → translate ONE BATCH of missing keys
 *          with the admin's BYOK key (platform ANTHROPIC_API_KEY fallback),
 *          upsert into i18nString, report how many remain. The client loops
 *          until remaining hits 0 — keeps every invocation well inside the
 *          serverless time limit no matter how big the dictionary grows.
 *   POST {action:'addLocale', code, label} → register a new locale row;
 *          the client then drives the same translate loop for it.
 *
 * Superadmin-only: these strings render for every visitor.
 */
export const maxDuration = 60

const BATCH_SIZE = 20

async function requireSuperAdmin() {
  const session = await getSession()
  if (!isSuperAdminEmail(session?.user?.email)) return null
  return session!.user
}

/** All locales the platform knows: shipped ones + runtime-added rows. */
async function allLocales() {
  const dbRows = await db.select().from(i18nLocale)
  const merged = [...LOCALES.map((l) => ({ value: l.value as string, label: l.label, runtime: false }))]
  for (const row of dbRows) {
    if (!merged.some((l) => l.value === row.code)) merged.push({ value: row.code, label: row.label, runtime: true })
  }
  return merged
}

/** Keys of `locale` still untranslated: en-keys minus static dict minus DB rows. */
async function missingKeys(locale: string): Promise<string[]> {
  const enKeys = Object.keys(DICTIONARIES.en)
  const staticDict: Record<string, string> = DICTIONARIES[locale as Locale] ?? {}
  const dbRows = await db
    .select({ key: i18nString.key })
    .from(i18nString)
    .where(eq(i18nString.locale, locale))
  const covered = new Set([...Object.keys(staticDict), ...dbRows.map((r) => r.key)])
  return enKeys.filter((k) => !covered.has(k))
}

export async function GET() {
  const user = await requireSuperAdmin()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const locales = await allLocales()
  const status = await Promise.all(
    locales
      .filter((l) => l.value !== 'en')
      .map(async (l) => ({ ...l, missing: (await missingKeys(l.value)).length })),
  )
  const byok = Boolean(await resolveUserAnthropicKey(user.id).catch(() => null))
  return Response.json({
    totalKeys: Object.keys(DICTIONARIES.en).length,
    locales: status,
    keySource: byok ? 'byok' : process.env.ANTHROPIC_API_KEY ? 'platform' : null,
  })
}

export async function POST(req: Request) {
  const user = await requireSuperAdmin()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))

  if (body.action === 'addLocale') {
    const code = String(body.code ?? '').toLowerCase().trim()
    const label = String(body.label ?? '').trim()
    if (!/^[a-z]{2,3}(-[a-z0-9]+)?$/.test(code)) {
      return Response.json({ error: 'Locale code must look like "ja" or "pt-br"' }, { status: 400 })
    }
    if (!label) return Response.json({ error: 'A native-name label is required (e.g. 日本語)' }, { status: 400 })
    if ((await allLocales()).some((l) => l.value === code)) {
      return Response.json({ error: `Locale "${code}" already exists` }, { status: 400 })
    }
    await db.insert(i18nLocale).values({ code, label })
    return Response.json({ ok: true, code })
  }

  if (body.action === 'translate') {
    const locale = String(body.locale ?? '')
    if (!(await allLocales()).some((l) => l.value === locale) || locale === 'en') {
      return Response.json({ error: `Unknown locale "${locale}"` }, { status: 400 })
    }

    const apiKey = (await resolveUserAnthropicKey(user.id).catch(() => null)) ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return Response.json(
        { error: 'No API key available — register yours in Settings (BYOK) or set ANTHROPIC_API_KEY' },
        { status: 400 },
      )
    }

    const missing = await missingKeys(locale)
    if (missing.length === 0) return Response.json({ translated: 0, remaining: 0 })

    const batch = missing.slice(0, BATCH_SIZE)
    const entries = Object.fromEntries(batch.map((k) => [k, DICTIONARIES.en[k]]))
    // Voice reference: static dict first (human-reviewed), else earlier DB rows.
    const staticRef: Record<string, string> = DICTIONARIES[locale as Locale] ?? {}
    const reference = Object.keys(staticRef).length
      ? staticRef
      : Object.fromEntries(
          (
            await db.select().from(i18nString).where(eq(i18nString.locale, locale)).limit(6)
          ).map((r) => [r.key, r.value]),
        )

    const translated = await translateStrings(apiKey, locale, entries, reference)

    // Deterministic gate before anything reaches a visitor.
    //
    // lib/i18n-safety.ts was written for the worker-submitted translation
    // path — "a stranger earned $5, and now the platform says this". That path
    // is gone; translation is no longer bought. But whatever writes here still
    // becomes the product's own UI copy in that locale, and the model is not
    // the only thing that can be wrong: a truncated response, a refusal that
    // came back as prose, a value that swallowed its placeholders. The check
    // is cheap and it was already written, so the route that survived gets it
    // rather than the module getting deleted.
    const { validateTranslationValue } = await import('@/lib/i18n-safety')
    const safe: Array<{ locale: string; key: string; value: string }> = []
    const rejected: Array<{ key: string; reason: string }> = []
    for (const key of batch) {
      const value = translated[key]
      const check = validateTranslationValue(DICTIONARIES.en[key] ?? '', value ?? '')
      if (check.ok) safe.push({ locale, key, value: value!.trim() })
      else rejected.push({ key, reason: check.reason })
    }

    if (safe.length > 0) {
      await db
        .insert(i18nString)
        .values(safe)
        .onConflictDoUpdate({
          target: [i18nString.locale, i18nString.key],
          set: { value: sql`excluded.value`, updatedAt: new Date() },
        })
    }
    // A rejected key stays missing, so the next pass retries it rather than
    // leaving a gap nobody is told about.
    if (rejected.length > 0) console.warn('[admin/i18n] rejected translations:', rejected)

    return Response.json({
      translated: safe.length,
      rejected: rejected.length,
      remaining: missing.length - safe.length,
    })
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 })
}
