'use client'

/**
 * One way of drawing a harness run, used everywhere a run is drawn.
 *
 * The office and the harness console were two views of the same moment on
 * two pages that did not know about each other. The derivation half of that
 * is fixed in `lib/office-functional-departments.ts` — a live run now places
 * the agent and writes its status line. This is the other half: the pieces
 * that draw a run live here rather than inside one page, so selecting a desk
 * in the diorama shows the same phase rail and the same log the console
 * shows, and neither can drift into having its own idea of what `test` looks
 * like.
 */

import { RUN_PHASES, type RunEvent, type RunPhase, type RunStatus } from '@/lib/harness-run'
import type { DeckTone } from '@/components/deck'

export const RUN_TONE: Record<RunStatus, DeckTone> = {
  running: 'accent',
  stalled: 'warn',
  passed: 'ok',
  failed: 'bad',
}

export const RUN_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  // Not "Running" and not "Failed": the worker stopped talking, which is a
  // third thing and the one a person needs to act on.
  stalled: 'No signal',
  passed: 'Passed',
  failed: 'Failed',
}

/** Plan → Code → Test → Review → Deploy, with the reached steps filled. */
export function PhaseRail({ at, compact = false }: { at: number; compact?: boolean }) {
  return (
    <ol className="flex items-center gap-1.5">
      {RUN_PHASES.map((phase, i) => {
        const done = i < at
        const here = i === at
        return (
          <li key={phase} className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                here ? 'bg-primary' : done ? 'bg-[var(--success)]' : 'bg-border'
              }`}
            />
            {!compact && (
              <span
                className={`truncate font-mono text-[10px] uppercase tracking-[0.12em] ${
                  here ? 'text-primary' : done ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                {phase}
              </span>
            )}
            {i < RUN_PHASES.length - 1 && (
              <span className={`h-px min-w-2 flex-1 ${done ? 'bg-[var(--success)]' : 'bg-border'}`} />
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** The tail of a run's log, newest last, as a terminal reads. */
export function RunLines({ events, limit = 6 }: { events: readonly RunEvent[]; limit?: number }) {
  const tail = events.slice(-limit)
  if (tail.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No output reported for this run.</p>
  }
  return (
    <ol className="space-y-0.5 font-mono text-[11px] leading-relaxed">
      {tail.map((e, i) => (
        <li key={i} className="flex gap-2">
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
          </span>
          <span
            className={`min-w-0 break-words ${
              e.level === 'good' ? 'text-[var(--success)]' : e.level === 'bad' ? 'text-[var(--destructive)]' : ''
            }`}
          >
            {e.text}
          </span>
        </li>
      ))}
    </ol>
  )
}

export function phaseLabel(phase: RunPhase): string {
  return phase
}
