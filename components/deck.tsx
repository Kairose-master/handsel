/**
 * Deck chrome.
 *
 * The dark theme gave the app the office's palette; these give it the
 * office's *grammar*. Three things separate a console from a page of cards,
 * and all three are repetition rather than invention, which is why they are
 * components and not a set of class names copied around:
 *
 * **A panel announces itself in one line.** A small mono, uppercase,
 * letter-spaced title on a hairline, with the controls for that panel on the
 * same line. Not an `<h2>` at body weight floating above a box.
 *
 * **A number is a readout, not a sentence.** Label above, figure below,
 * tabular, one tone. `$14,280.45` under `TREASURY` is scanned; "Treasury:
 * $14,280.45" is read.
 *
 * **State is a colour AND a shape.** A dot plus a word, in semantic colour
 * that is deliberately not the cyan accent — the accent means "this is
 * Handsel", and one hue cannot also mean "this is healthy".
 *
 * These render the same on ledger paper as on the deck: everything is a
 * token, nothing is a literal. A public page that uses a Panel is not
 * secretly dark.
 */
import type { ReactNode } from 'react'

export type DeckTone = 'ok' | 'warn' | 'bad' | 'idle' | 'accent'

const TONE_TEXT: Record<DeckTone, string> = {
  ok: 'text-[var(--success)]',
  warn: 'text-[var(--warning)]',
  bad: 'text-[var(--destructive)]',
  idle: 'text-muted-foreground',
  accent: 'text-primary',
}

const TONE_BG: Record<DeckTone, string> = {
  ok: 'bg-[var(--success)]',
  warn: 'bg-[var(--warning)]',
  bad: 'bg-[var(--destructive)]',
  idle: 'bg-muted-foreground',
  accent: 'bg-primary',
}

/** The panel title bar: mono, uppercase, tracked, with room for controls. */
export function PanelHeader({
  title,
  icon,
  children,
}: {
  title: string
  /** A glyph or lucide icon at the head of the title. */
  icon?: ReactNode
  /** Controls for this panel, right-aligned on the same line. */
  children?: ReactNode
}) {
  return (
    <div className="flex h-9 items-center gap-2 border-b border-border px-3">
      {icon && <span className="shrink-0 text-primary [&>svg]:size-3.5">{icon}</span>}
      <h2 className="min-w-0 truncate font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground">
        {title}
      </h2>
      {children && <div className="ml-auto flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  )
}

export function Panel({
  title,
  icon,
  actions,
  className = '',
  bodyClassName = 'p-3',
  children,
}: {
  title?: string
  icon?: ReactNode
  actions?: ReactNode
  className?: string
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <section className={`overflow-hidden rounded-[var(--radius-md)] border border-border bg-card ${className}`}>
      {title && (
        <PanelHeader title={title} icon={icon}>
          {actions}
        </PanelHeader>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  )
}

/**
 * A labelled figure.
 *
 * `value` is a node rather than a string on purpose: the honest answer for a
 * number that could not be read is to render nothing at all, and a caller
 * that has to stringify first ends up printing "0" or "—" and calling it
 * data.
 */
export function Readout({
  label,
  value,
  tone = 'idle',
  hint,
}: {
  label: string
  value: ReactNode
  /** Colour of the figure. Defaults to plain — most numbers are not a verdict. */
  tone?: DeckTone
  hint?: string
}) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className={`truncate text-sm font-semibold tabular-nums ${tone === 'idle' ? 'text-foreground' : TONE_TEXT[tone]}`}>
        {value}
      </div>
    </div>
  )
}

/** A live-state marker: a dot and a word, never a dot alone. */
export function StatusDot({ tone, label, pulse = false }: { tone: DeckTone; label: string; pulse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`size-1.5 shrink-0 rounded-full ${TONE_BG[tone]} ${pulse ? 'animate-pulse' : ''}`} />
      <span className={`font-mono text-[10px] uppercase tracking-[0.12em] ${TONE_TEXT[tone]}`}>{label}</span>
    </span>
  )
}

/**
 * The head of a page.
 *
 * Thirty-three dashboard pages each open with their own hand-rolled
 * `text-3xl font-bold` and a paragraph under it, which is why the app reads
 * as a stack of documents rather than as one console: the title is the
 * largest thing on every screen and it is never the thing you came for.
 * Here it is a line, not a banner — sized to be found and then ignored, with
 * a rule under it and the page's controls on the same row.
 */
export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-border pb-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
        {subtitle && <p className="mt-1 max-w-[74ch] text-pretty text-sm leading-relaxed text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/** A square category marker. Pills are the house style of every generated
 *  interface; this is a label, not a "New!" flag. */
export function Chip({ children, tone = 'idle' }: { children: ReactNode; tone?: DeckTone }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-sm border border-current/30 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${TONE_TEXT[tone]}`}
    >
      {children}
    </span>
  )
}
