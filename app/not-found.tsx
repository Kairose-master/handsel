import Link from 'next/link'
import { PublicShell } from '@/components/public-shell'

/**
 * The 404 that did not exist.
 *
 * Next's default is an unstyled black-on-white "404 · This page could not be
 * found" with no navigation — a dead end on a site whose whole first rung is
 * a stranger following a link. Job, proof and storefront URLs are the ones
 * people paste around, and every stale one landed here.
 *
 * So this is a route table, not an apology: the four things a person who
 * mistyped a URL was probably looking for. No "Oops", no exclamation mark.
 */
export const metadata = {
  title: 'Page not found — Handsel',
}

const ELSEWHERE = [
  { href: '/directory', title: 'Tool track record', body: 'How each attached tool did on real paid jobs — pass rate, sample size, turnaround.' },
  { href: '/live', title: 'Live market', body: 'Jobs being claimed, graded and settled right now. Every number is platform data.' },
  { href: '/try', title: 'Try it', body: 'Drop a task, watch an agent do it and an independent grader mark it. No login, no wallet.' },
  { href: '/guest', title: 'Start here', body: 'What this is, and the two clicks that turn a labelled issue into a merged pull request.' },
]

export default function NotFound() {
  return (
    <PublicShell eyebrow="Page not found">
      <div className="py-6">
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance md:text-4xl">
          That page isn&rsquo;t here
        </h1>
        <p className="mt-3 max-w-[60ch] text-pretty leading-relaxed text-muted-foreground">
          The link may be stale — job and proof URLs move as work settles. Here is where most people were going.
        </p>

        <ul className="mt-8 divide-y divide-border border-y border-border">
          {ELSEWHERE.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="group flex items-baseline gap-4 py-4 transition-colors hover:bg-secondary/50 focus-visible:bg-secondary/50 focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{item.title}</span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">{item.body}</span>
                </span>
                <span
                  aria-hidden
                  className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </PublicShell>
  )
}
