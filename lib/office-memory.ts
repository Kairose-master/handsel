/**
 * Office memory — the desk's shared context, grown from verified work.
 *
 * The office already has one document every role reads (`office_source`,
 * lib/office.ts), but it only knows what the OWNER pasted. What it never
 * knew was what the desk itself had already produced: round two of a
 * pipeline re-derived everything round one had settled, because nothing
 * carried verified results forward. This module is that carry: every PAID,
 * office-scoped deliverable folds a bounded digest into the office's
 * memory, and the next hire's briefs open with it.
 *
 * Two rules make it Handsel-shaped rather than a scrapbook:
 *
 *  1. **Only settled work enters.** An entry exists because independent
 *     grading passed and the escrow moved — the memory can cite `#job` and
 *     the payout for every line. Notes, drafts, and failed attempts never
 *     appear, so a role reading it inherits verified context, not vibes.
 *  2. **Bounded, oldest-out.** The memory is a working context, not an
 *     archive — the proof store and the deliverables themselves remain the
 *     archive. Caps keep it small enough to sit in every brief.
 *
 * Same hire-time semantics as the source: memory reaches briefs when an
 * office is HIRED, never retroactively — a posted job's brief is a contract
 * and must not change under the worker being graded against it.
 *
 * Pure half. Storage and the settle hook live in office-memory-server.ts.
 */

export const OFFICE_MEMORY = {
  MAX_ENTRIES: 12,
  MAX_DIGEST_CHARS: 700,
} as const

export type OfficeMemoryEntry = {
  /** ISO timestamp of settlement. */
  at: string
  /** `#<onchainJobId>` — the citable job this entry was paid on. */
  jobRef: string
  title: string
  paidUsd: number
  digest: string
}

/** Collapse a deliverable into its bounded digest: whitespace folded, head
 *  of the text, a cut marker when it was cut. */
export function digestDeliverable(text: string): string {
  const folded = text.replace(/\s+/g, ' ').trim()
  if (folded.length <= OFFICE_MEMORY.MAX_DIGEST_CHARS) return folded
  return `${folded.slice(0, OFFICE_MEMORY.MAX_DIGEST_CHARS)} … [cut — the full deliverable is on the job record]`
}

/** Fold one settled deliverable in: replace any prior entry for the same
 *  job (a resubmission settles once, but belt and braces), append, and drop
 *  the oldest past the cap. */
export function foldMemory(entries: OfficeMemoryEntry[], entry: OfficeMemoryEntry): OfficeMemoryEntry[] {
  const kept = entries.filter((e) => e.jobRef !== entry.jobRef)
  kept.push(entry)
  return kept.slice(-OFFICE_MEMORY.MAX_ENTRIES)
}

/** The ledger as brief text. Empty entries render to '' so callers can
 *  append unconditionally. */
export function renderOfficeMemory(entries: OfficeMemoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries
    .map((e) => `- ${e.jobRef} · "${e.title}" · paid $${e.paidUsd.toFixed(2)} · ${e.at.slice(0, 10)}\n  ${e.digest}`)
    .join('\n')
  return (
    `## What this office has already delivered (verified)\n\n` +
    `Every entry below passed independent grading and was PAID — it is settled work this desk produced, ` +
    `not notes. Build on it instead of re-deriving it; cite the job number when you rely on one.\n\n` +
    lines
  )
}
