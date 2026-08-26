import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reads the copy-paste walkthroughs in docs/test-scenarios/*.md so the public
 * /examples pages can render the SAME source the repo ships — no second copy
 * to drift. Runs at build time (the /examples routes are force-static), so the
 * markdown is baked into the prerendered HTML; process.cwd() is the repo root
 * on the build machine, where docs/ always exists.
 */

const DIR = join(process.cwd(), 'docs', 'test-scenarios')

export interface Scenario {
  slug: string
  title: string
  summary: string
  body: string
  minutes: number
}

// Curated order (front-door friendliest first) + a rough "time to run".
// A file not listed here still shows, appended, so adding a scenario .md is
// enough — this list only tunes ordering.
const ORDER: { slug: string; minutes: number }[] = [
  { slug: 'delegation', minutes: 5 },
  { slug: 'hire-an-office', minutes: 8 },
  { slug: 'bring-any-mcp-agent', minutes: 10 },
  { slug: 'local-worker', minutes: 10 },
  { slug: 'auto-graded-code-job', minutes: 8 },
  { slug: 'byo-webhook-agent', minutes: 12 },
  { slug: 'labor-market-dispute', minutes: 8 },
]

function parse(slug: string, raw: string): Omit<Scenario, 'minutes'> {
  const lines = raw.split('\n')
  const h1 = lines.findIndex((l) => l.startsWith('# '))
  const title = h1 >= 0 ? lines[h1].replace(/^#\s+/, '').trim() : slug
  // First non-empty, non-heading paragraph after the H1 is the summary.
  const summaryLines: string[] = []
  for (let i = h1 + 1; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) {
      if (summaryLines.length) break
      continue
    }
    if (l.startsWith('#')) break
    summaryLines.push(l)
  }
  // Strip inline markdown so the card summary reads as plain prose.
  const summary = summaryLines
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → text
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
  return { slug, title, summary, body: raw }
}

export function listScenarios(): Scenario[] {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.md'))
  const bySlug = new Map<string, Scenario>()
  for (const f of files) {
    const slug = f.replace(/\.md$/, '')
    const parsed = parse(slug, readFileSync(join(DIR, f), 'utf8'))
    const minutes = ORDER.find((o) => o.slug === slug)?.minutes ?? 8
    bySlug.set(slug, { ...parsed, minutes })
  }
  const ordered: Scenario[] = []
  for (const { slug } of ORDER) {
    const s = bySlug.get(slug)
    if (s) {
      ordered.push(s)
      bySlug.delete(slug)
    }
  }
  return [...ordered, ...bySlug.values()]
}

export function getScenario(slug: string): Scenario | null {
  return listScenarios().find((s) => s.slug === slug) ?? null
}
