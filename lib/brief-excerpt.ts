/**
 * How much of another worker's deliverable goes into a worker's brief — and
 * what has to be said when it doesn't all fit.
 *
 * Handoff and peer review inject upstream text into a downstream brief through
 * the same code path, and that path capped every input at 8,000 characters.
 * For a handoff the cap is right: a synthesis step can depend on several
 * pieces, and an unbounded splice is an unbounded prompt.
 *
 * For a review it was wrong, and wrong in a way that manufactured false
 * verdicts. A reviewer is asked to judge a document for completeness; hand it
 * the first 8,000 characters of a 19,000-character document and it reports,
 * accurately, that the document ends mid-sentence and its concluding section is
 * missing. It replies REVISE. The work was complete. The platform truncated it,
 * and the verdict landed on the worker. Under the peer-review escrow gate that
 * verdict also freezes the worker's money — so a platform defect becomes a
 * withheld payment and a credit-score hit, attributed to the wrong party.
 *
 * Two rules follow, and they are separate:
 *
 *  1. A review gets a cap sized to a whole document, not to a fragment. A
 *     review has exactly one input by construction (its target), so there is
 *     no fan-in to bound.
 *  2. When ANY excerpt is cut, the brief says so — outside the untrusted fence,
 *     in text the platform writes. Inside the fence it would be worker-authored
 *     and forgeable, which is the whole reason the fence exists. Silence is the
 *     actual defect: the reviewer cannot tell "the worker stopped writing" from
 *     "we stopped reading", and by default it blames the worker.
 *
 * On the failure taxonomy (lib/failure-codes.ts, docs/failure-codes.md): a
 * missing tail caused here is an EVD/INF-layer fact about the evidence the
 * reviewer was given. Only WRK.* implies worker fault, and this is not WRK.
 */

/** Handoff inputs: several may be spliced into one brief, so each is bounded. */
export const HANDOFF_EXCERPT_LIMIT = 8_000

/** Peer review: one document, and judging it whole is the entire job. Sized to
 *  pass a long deliverable intact rather than to save prompt space. */
export const REVIEW_EXCERPT_LIMIT = 60_000

export type Excerpt = {
  text: string
  truncated: boolean
  /** Characters dropped from the end. 0 when nothing was cut. */
  omitted: number
}

export function excerptForBrief(source: string, limit: number): Excerpt {
  const text = typeof source === 'string' ? source : ''
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
    return { text, truncated: false, omitted: 0 }
  }
  return { text: text.slice(0, limit), truncated: true, omitted: text.length - limit }
}

/**
 * The line the platform adds when it cut something. Returns undefined when
 * nothing was truncated — callers should append nothing rather than a
 * reassuring "nothing was cut", which is noise in the common case.
 *
 * `reviewing` changes the wording, not the fact: a reviewer needs to be told
 * explicitly not to score the absence, because scoring absence is exactly what
 * a completeness check does.
 */
export function truncationNotice(
  cuts: readonly { title: string; excerpt: Excerpt }[],
  opts?: { reviewing?: boolean },
): string | undefined {
  const cut = cuts.filter((c) => c.excerpt.truncated)
  if (!cut.length) return undefined
  const detail = cut
    .map((c) => `"${c.title}" (${c.excerpt.omitted.toLocaleString('en-US')} characters cut from the end)`)
    .join('; ')
  const head = `PLATFORM NOTICE — written by the platform, not by any worker: ${detail}.`
  return opts?.reviewing
    ? `${head} The document below is therefore incomplete as you receive it, and that is our doing, not the worker's. ` +
        `Do not treat the missing ending — a conclusion, a final section, a sentence stopping mid-word — as work left undone. ` +
        `Judge what is present. If you cannot reach a verdict without the part we cut, say exactly that instead of replying REVISE.`
    : `${head} Build on what is present, and do not infer from the cut-off ending that the upstream work was unfinished.`
}
