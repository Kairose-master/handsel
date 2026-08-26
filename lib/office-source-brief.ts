/**
 * The office's shared source, as it appears in a worker's brief.
 *
 * Pure and dependency-free so both the hire action and its tests can use it,
 * and so the exact text that reaches a worker is one readable function rather
 * than string-building scattered through the hire path.
 *
 * Why this exists: an office's agents each had their own brief and their own
 * connector, and nothing they all read. That makes an office a set of
 * parallel contractors, not a desk — the analyst and the reviewer were
 * reasoning about the same subject from separate descriptions of it. A shared
 * source is the one document every role reads, each through its own
 * instrument.
 */

/** Cap on the shared source. Every role's brief carries the whole thing, so
 *  an unbounded document is multiplied by the pipeline length — and briefs
 *  are what the planner, the workers and the graders all read. */
export const MAX_OFFICE_SOURCE_CHARS = 8000

export type OfficeSource = { title: string; body: string }

/**
 * Append the office's shared source to one step's brief.
 *
 * Not fenced as untrusted, deliberately: this is the office owner's own text,
 * arriving through the same form as the brief and the scope beside it — the
 * owner instructing their own workers is the ordinary direction of trust.
 * That reasoning is what makes it safe, so it stops holding the moment the
 * body stops being owner-authored: anything fetched from a URL or delivered
 * by another agent must go through fenceUntrusted (lib/untrusted-input.ts)
 * instead, the way upstream worker output already does.
 *
 * Returns the brief unchanged when there is no source, so a step's text is
 * byte-identical to what it was before an office had one.
 */
export function briefWithOfficeSource(description: string, source: OfficeSource | null | undefined): string {
  const body = source?.body?.trim()
  if (!body) return description
  const title = source?.title?.trim() || 'Shared source'
  return (
    `${description}\n\n` +
    `## ${title} — the shared source for this office\n\n` +
    `Every agent in this office is working from this same document. Ground your work in it: ` +
    `where it answers something, use its answer rather than a general one, and say so when your ` +
    `piece disagrees with it.\n\n` +
    body.slice(0, MAX_OFFICE_SOURCE_CHARS)
  )
}
