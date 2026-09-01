/**
 * Making a coordination note impossible to merge without reading.
 *
 * `conversation.md` is where agents working this repo at the same time warn
 * each other. On 2026-09-01 it worked and it did not, in the same hour:
 *
 *   08:10  the office-harness session pushes a note — a live round is running,
 *          a local worker is polling, do not rewire that agent
 *   08:34  this session pulls. `conversation.md | 20 ++++++++++++++++++++`
 *          is printed in the merge diffstat, and read, and skipped
 *   08:34  this session pushes and reports done
 *   08:45  the owner says "read conversation.md"
 *   08:52  reading it turns up a real defect in code shipped at 08:27 — the
 *          harness preflight probe was running in the owner's checkout with
 *          the harness's auto-approval flag on
 *
 * The channel was fine. The note was specific, it was correct, and it was
 * about code that had gone in seven minutes earlier. It sat in the working
 * tree for eleven minutes and its own filename appeared on screen.
 *
 * So the lesson is not "write better notes". **A coordination artifact that
 * depends on being voluntarily read is ignored by exactly the agent that most
 * needs it** — an agent mid-task is optimising for its task, and an unfamiliar
 * file in a merge diffstat reads as somebody else's business.
 *
 * The fix is to stop asking. This turns the note into a gate: unacknowledged
 * changes to `conversation.md` fail `npm run gates`, which every commit runs,
 * and the failure prints the note. Nothing has to be remembered and nothing
 * relies on an instruction being followed.
 *
 * Pure here; the file and git plumbing live in scripts/conversation-check.mjs.
 */

export const ACK_BASENAME = 'handsel-conversation-ack'

/**
 * Two notes are the same note when their meaningful text is the same.
 *
 * Trailing whitespace and a missing final newline are not a new warning, and
 * treating them as one trains everybody to acknowledge without reading —
 * which is the exact behaviour this file exists to prevent.
 */
export function normalizeNote(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '\n')
    .trimStart()
}

export type NoteStatus =
  /** Nothing acknowledged yet — a fresh clone, which is a fresh agent. */
  | { state: 'unread'; added: string[] }
  /** Acknowledged text exists and the note has grown or changed. */
  | { state: 'changed'; added: string[] }
  | { state: 'current' }

/**
 * What this working copy has not seen.
 *
 * `added` is the lines that are in the note and were not in what was
 * acknowledged — the new warning, not the whole file. A note accumulates for
 * the life of the repo, and reprinting all of it every time is how a gate
 * becomes wallpaper.
 *
 * Line-set rather than a diff on purpose: a note is append-mostly, the order
 * of untouched sections is not information, and a real diff would report a
 * moved paragraph as new text.
 */
export function noteStatus(note: string, acked: string | null): NoteStatus {
  const now = normalizeNote(note)
  if (acked === null) return { state: 'unread', added: meaningfulLines(now) }
  const before = normalizeNote(acked)
  if (before === now) return { state: 'current' }
  const seen = new Set(meaningfulLines(before))
  const added = meaningfulLines(now).filter((l) => !seen.has(l))
  // Changed but with nothing added means text was REMOVED or reordered. Still
  // a change worth surfacing, and with no new lines to show, so the caller
  // gets an honest empty list rather than a silent pass.
  return { state: 'changed', added }
}

function meaningfulLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim())
}

/** Only a blank note is nothing to read. A note that exists always has to be
 *  acknowledged once per working copy, including on a fresh clone. */
export function needsAcknowledgement(status: NoteStatus): boolean {
  return status.state !== 'current'
}

export function renderNotice(status: NoteStatus, ackCommand: string): string {
  if (status.state === 'current') return ''
  const head =
    status.state === 'unread'
      ? 'conversation.md has not been read in this working copy.'
      : 'conversation.md changed since it was last read here.'
  const body = status.added.length
    ? ['', ...status.added.map((l) => `  │ ${l}`), ''].join('\n')
    : '\n  │ (lines were removed or reordered — read the file)\n'
  return [
    '',
    `✖ ${head}`,
    '',
    'Another agent is working this repo and left a note. It is not optional',
    'reading: the last time it was skipped, it was describing a live round',
    'and a defect in code shipped seven minutes earlier.',
    body,
    `Read conversation.md, then: ${ackCommand}`,
    '',
  ].join('\n')
}
