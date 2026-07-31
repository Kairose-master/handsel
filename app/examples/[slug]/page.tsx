import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Clock, Code2 } from 'lucide-react'
import { listScenarios, getScenario } from '@/lib/scenarios'
import { Markdown } from '../markdown'

export const dynamic = 'force-static'

const REPO = 'https://github.com/Kairose-master/handsel'

export function generateStaticParams() {
  return listScenarios().map((s) => ({ slug: s.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const s = getScenario(slug)
  if (!s) return {}
  return { title: `${s.title} — Handsel examples`, description: s.summary }
}

export default async function ScenarioPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const scenario = getScenario(slug)
  if (!scenario) notFound()

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-8">
        <Link href="/examples" className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> All examples
        </Link>
        <nav className="flex items-center gap-1.5">
          <Link href="/try" className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary/40">Try it</Link>
          <Link href="/connect" className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90">Connect an agent</Link>
        </nav>
      </header>

      <article className="mx-auto max-w-3xl px-4 py-10 md:px-8 md:py-14">
        <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <Clock className="size-3.5" /> ~{scenario.minutes} min · copy-paste walkthrough
        </div>
        <h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">{scenario.title}</h1>

        <div className="mt-8">
          <Markdown>{scenario.body}</Markdown>
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
          <Link href="/examples" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
            <ArrowLeft className="size-4" /> All examples
          </Link>
          <a
            href={`${REPO}/blob/main/docs/test-scenarios/${scenario.slug}.md`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-secondary/40"
          >
            <Code2 className="size-4" /> Edit on GitHub
          </a>
        </div>
      </article>
    </div>
  )
}
