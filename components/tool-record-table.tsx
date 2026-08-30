import { describeRecord, formatSeconds, MIN_RATED_JOBS, MIN_SOURCES, type ToolRecord } from '@/lib/tool-record'

/**
 * The receipts.
 *
 * This is rung 1 of docs/positioning.md's ladder — the single thing a stranger
 * with no account gets value from, and the only column no other MCP registry
 * can print. It shipped as a `<ul>` of sentences, which is under-built for the
 * one surface the product's whole entry strategy rests on.
 *
 * Two things it does that a list of sentences cannot:
 *
 * **The rate has a shape, not only a number.** A pass rate is the value people
 * scan for, and a bar is read before a digit is. Semantic colour only — good /
 * middling / poor — kept away from the brand accent, so "this tool does well"
 * and "this is Handsel" never say the same thing in the same colour.
 *
 * **An absent rate is a STATE, not a blank.** Below the sample floor there is
 * no rate, and rendering that as an empty cell reads as a bug. It is rendered
 * as a labelled hold with the reason attached, which is also the honest thing:
 * the reason a number is missing is information.
 */

function rateTone(rate: number): { bar: string; text: string } {
  // Deliberately not the brand accent. Semantic colour answers "is this good",
  // the accent answers "is this Handsel", and one hue cannot mean both.
  if (rate >= 0.8) return { bar: 'bg-[var(--success)]', text: 'text-[var(--success)]' }
  if (rate >= 0.5) return { bar: 'bg-[var(--warning)]', text: 'text-[var(--warning)]' }
  return { bar: 'bg-[var(--destructive)]', text: 'text-[var(--destructive)]' }
}

function KindBadge({ kind }: { kind: string }) {
  // A square label, not a pill: pill badges are the house style of every
  // generated interface, and this one is a category marker rather than a
  // "New!" flag.
  return (
    <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
      {kind}
    </span>
  )
}

function Row({ record }: { record: ToolRecord }) {
  const tone = record.passRate === null ? null : rateTone(record.passRate)
  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-2 py-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-center">
      <div className="flex min-w-0 items-center gap-2">
        <KindBadge kind={record.kind} />
        <span className="truncate font-medium">{record.label}</span>
      </div>

      {record.passRate === null || tone === null ? (
        <div className="text-sm text-muted-foreground">
          <span className="font-medium">Not rated</span>
        </div>
      ) : (
        <div className="flex items-center gap-2.5">
          {/* aria-hidden: the number beside it already says this, and a
              screen reader reading a decorative bar twice is noise. */}
          <span aria-hidden className="h-1.5 w-full max-w-24 overflow-hidden rounded-full bg-secondary">
            <span className={`block h-full ${tone.bar}`} style={{ width: `${Math.round(record.passRate * 100)}%` }} />
          </span>
          <span className={`shrink-0 text-sm font-semibold tabular-nums ${tone.text}`}>
            {Math.round(record.passRate * 100)}%
          </span>
        </div>
      )}

      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted-foreground sm:justify-end">
        <div className="flex items-baseline gap-1.5">
          <dt className="sr-only">Graded jobs</dt>
          <dd className="tabular-nums">{record.jobs}</dd>
          <span aria-hidden className="text-xs">
            graded
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="sr-only">Distinct hiring accounts</dt>
          <dd className="tabular-nums">{record.accounts}</dd>
          <span aria-hidden className="text-xs">
            {record.accounts === 1 ? 'account' : 'accounts'}
          </span>
        </div>
        {record.medianBountyUsd !== null && (
          <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">Median bounty</dt>
            <dd className="tabular-nums">${record.medianBountyUsd.toFixed(2)}</dd>
          </div>
        )}
        {record.medianSeconds !== null && (
          <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">Median turnaround</dt>
            <dd className="tabular-nums">{formatSeconds(record.medianSeconds)}</dd>
          </div>
        )}
      </dl>

      {record.caveat && (
        <p className="text-xs text-muted-foreground sm:col-span-3 sm:-mt-1">{record.caveat}</p>
      )}
    </li>
  )
}

/**
 * What the section says when nothing has been graded yet.
 *
 * Not an omission: the first version rendered nothing at all when the record
 * was empty, so a first-time visitor saw only the mirrored third-party list
 * and the page's entire reason to exist was invisible until data happened to
 * exist. An empty state that says what will appear here, and how to be in it,
 * is the rung-2 invitation.
 */
function Empty() {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-border px-6 py-8">
      <p className="font-medium">No tool has graded work here yet</p>
      <p className="mt-2 max-w-[52ch] text-pretty text-sm leading-relaxed text-muted-foreground">
        This is where each attached tool&rsquo;s pass rate appears, once it has been through jobs graded by someone
        other than itself. Attaching an MCP server takes a few minutes and the record it builds is yours to cite.
      </p>
    </div>
  )
}

export function ToolRecordTable({ records }: { records: ToolRecord[] }) {
  return (
    <section aria-labelledby="graded-heading" className="rounded-[var(--radius-xl)] border border-border bg-card p-6 md:p-8">
      <h1 id="graded-heading" className="text-2xl font-semibold tracking-tight text-balance md:text-3xl">
        Graded on Handsel
      </h1>
      <p className="mt-2 max-w-[62ch] text-pretty text-sm leading-relaxed text-muted-foreground">
        How each attached tool actually did on real paid jobs — graded by someone other than the worker, with the
        worker&rsquo;s own bond at risk. Sample size sits next to every rate because a rate without one is a
        decoration; below {MIN_RATED_JOBS} graded jobs no rate is shown at all, and a tool hired by fewer than{' '}
        {MIN_SOURCES} accounts is listed but never ranked.
      </p>

      {records.length === 0 ? (
        <div className="mt-6">
          <Empty />
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-border border-t border-border">
          {records.map((r) => (
            <Row key={r.toolId} record={r} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** The same record as one line, for surfaces with no room for a table. */
export { describeRecord }
