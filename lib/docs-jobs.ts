/**
 * Dogfood demand, source #2: the repo's real DOCUMENTATION backlog as Labor
 * Market jobs. The honest gap today: the most user-facing docs have no Korean
 * version, for the builder's own community. Unlike the i18n UI jobs, applying
 * results is a reviewed commit by the operator — the briefs say so.
 *
 * A source must be a file THIS repo can read at post time. minecraft/README.md
 * used to be listed here and was removed when the plugin moved to
 * Kairose-master/handsel-minecraft: the job would have been posted, escrowed,
 * and then failed on a file that is not here. It is still a real translation
 * job — it just belongs to the repo that now holds the file, which is also the
 * repo that now takes bounties.
 *
 * Pure helpers (splitting, briefs, title round-trip) — unit-tested; the
 * server action (app/actions/dogfood-jobs.ts) does the fs/DB/chain work.
 */
import { I18N_JOB_TITLE_PREFIX } from '@/lib/i18n-jobs'
import { TESTS_JOB_TITLE_PREFIX } from '@/lib/test-suite-jobs'

export const DOCS_JOB_TITLE_PREFIX = 'docs → '
export const DOCS_JOB_BOUNTY_USD = 6
export const DOCS_JOB_MIN_SCORE = 0
/** Section-group size — keeps a brief readable and the grading prompt bounded. */
export const DOCS_JOB_CHUNK_CHARS = 6000

/** A dogfood job (any source) — used to tell real work from practice clutter. */
export function isDogfoodJobTitle(title: string): boolean {
  return (
    title.startsWith(I18N_JOB_TITLE_PREFIX) ||
    title.startsWith(DOCS_JOB_TITLE_PREFIX) ||
    title.startsWith(TESTS_JOB_TITLE_PREFIX)
  )
}

export interface DocsJobSource {
  /** Repo-relative path, read at post time. */
  path: string
  from: string
  to: string
  /** Why this translation genuinely matters — shown in the brief. */
  reason: string
}

export const DOCS_JOB_SOURCES: DocsJobSource[] = [
  {
    path: 'docs/mcp-connector.md',
    from: 'English',
    to: 'Korean',
    reason: 'The connector guide is the most-visited doc and has no Korean version for the Korean builder community.',
  },
  {
    path: 'docs/external-agents.md',
    from: 'English',
    to: 'Korean',
    reason: 'The bring-any-agent guide has no Korean version.',
  },
]

/**
 * Split a markdown document into chunks of consecutive `## ` sections, each at
 * most ~maxChars (a single oversized section still becomes its own chunk —
 * never split mid-section, so translators always see whole sections). The
 * preamble (before the first `## `) rides with the first chunk.
 */
export function splitMarkdownSections(md: string, maxChars = DOCS_JOB_CHUNK_CHARS): string[] {
  const lines = md.split('\n')
  const sections: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.startsWith('## ') && current.length > 0) {
      sections.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current.join('\n'))

  const chunks: string[] = []
  let buf = ''
  for (const s of sections) {
    if (buf && buf.length + s.length + 1 > maxChars) {
      chunks.push(buf)
      buf = s
    } else {
      buf = buf ? `${buf}\n${s}` : s
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}

export function docsJobTitle(source: DocsJobSource, part: number, totalParts: number): string {
  const partLabel = totalParts > 1 ? ` (part ${part}/${totalParts})` : ''
  return `${DOCS_JOB_TITLE_PREFIX}${source.to}: translate ${source.path}${partLabel}`
}

export function docsJobDescription(source: DocsJobSource, chunk: string, part: number, totalParts: number): string {
  return [
    `Translate the following section${totalParts > 1 ? `s (part ${part} of ${totalParts})` : ''} of \`${source.path}\` from ${source.from} to ${source.to}.`,
    '',
    `Why this matters: ${source.reason}`,
    '',
    'Source markdown:',
    '~~~markdown',
    chunk,
    '~~~',
    '',
    `Reply with ONLY the translated markdown — same structure, same headings hierarchy, nothing added or dropped.`,
    'Rules: keep code blocks, commands, file paths, URLs and product names (Handsel, MCP, USDC, Claude, ChatGPT, Paper, Tauri) EXACTLY as they are;',
    'translate prose, headings and comments meant for humans; match the tone of developer documentation.',
    'Note: a maintainer reviews and commits accepted translations to the repository — write for that bar.',
  ].join('\n')
}

export function docsJobAcceptanceCriteria(source: DocsJobSource): string {
  return [
    `- The submission is the complete ${source.to} translation of the given markdown — every section translated, none skipped or summarized`,
    '- Markdown structure is preserved: same headings hierarchy, lists, tables and links',
    '- Code blocks, shell commands, file paths, URLs and product names are unchanged',
    `- The prose reads as natural ${source.to} developer documentation — not machine-literal, no untranslated leftover sentences`,
  ].join('\n')
}
