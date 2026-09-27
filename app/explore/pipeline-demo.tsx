'use client'

/**
 * One-click pipeline demo — the no-login "aha" for a first-time visitor.
 * A single button runs a real task through the real engine (generate →
 * independent grade → signed proof) and lights up each stage as it goes, so a
 * non-technical person SEES what the product does in ~20 seconds without
 * signing up, reading jargon, or connecting anything.
 *
 * Honesty: the output, the grader's verdict, and the proof are all real
 * (POST /api/demo/run → lib/demo-run). Only wallets/escrow are stripped out —
 * same engine as the live market. The stage pacing is a UI affordance around a
 * real single-shot call; every stage maps to a real backend step.
 */
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { FileText, Bot, Send, ShieldCheck, BadgeCheck, Play, Loader2, ArrowRight } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

const EXAMPLE_KEYS = ['guest.demo.prompt1', 'guest.demo.prompt2', 'guest.demo.prompt3'] as const

type Stage = 'idle' | 'posted' | 'working' | 'submitted' | 'grading' | 'done'

const STEPS: { key: Exclude<Stage, 'idle' | 'done'>; icon: typeof FileText; labelKey: string; subKey: string }[] = [
  { key: 'posted', icon: FileText, labelKey: 'guest.demo.stepPosted', subKey: 'guest.demo.stepPostedSub' },
  { key: 'working', icon: Bot, labelKey: 'guest.demo.stepWorking', subKey: 'guest.demo.stepWorkingSub' },
  { key: 'submitted', icon: Send, labelKey: 'guest.demo.stepSubmitted', subKey: 'guest.demo.stepSubmittedSub' },
  { key: 'grading', icon: ShieldCheck, labelKey: 'guest.demo.stepGrading', subKey: 'guest.demo.stepGradingSub' },
]

const ORDER: Stage[] = ['posted', 'working', 'submitted', 'grading', 'done']

interface DemoResult {
  textOutput?: string
  verdict: { passed: boolean | null; reason: string }
  proof?: { id: string }
}

export function PipelineDemo() {
  const { t } = useI18n()
  // Track WHICH example is picked, not its text, so the task (and the result
  // the agent produces) follows the visitor's language when they switch it.
  const [exampleIdx, setExampleIdx] = useState(0)
  const [stage, setStage] = useState<Stage>('idle')
  const [result, setResult] = useState<DemoResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  // Drop pending stage timers if this unmounts mid-run.
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const prompt = t(EXAMPLE_KEYS[exampleIdx])
  const running = stage !== 'idle' && stage !== 'done'

  const run = async () => {
    if (running) return
    timers.current.forEach(clearTimeout)
    timers.current = []
    setResult(null)
    setError(null)
    setStage('posted')

    // Pace the visible stages so the pipeline reads as a pipeline (min ~1.1s
    // each). The real call runs in parallel; we hold at "grading" until it
    // resolves, then reveal the real result.
    timers.current.push(setTimeout(() => setStage((s) => (s === 'posted' ? 'working' : s)), 1100))
    timers.current.push(setTimeout(() => setStage((s) => (s === 'working' ? 'submitted' : s)), 2400))
    timers.current.push(setTimeout(() => setStage((s) => (s === 'submitted' ? 'grading' : s)), 3600))

    const started = Date.now()
    try {
      const res = await fetch('/api/demo/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'text', prompt: prompt.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'failed')
      // Ensure the pipeline animation has had a beat before we jump to done.
      const elapsed = Date.now() - started
      const wait = Math.max(0, 3800 - elapsed)
      timers.current.push(
        setTimeout(() => {
          setResult(data)
          setStage('done')
        }, wait),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage('idle')
    }
  }

  const passed = result?.verdict.passed
  const idx = ORDER.indexOf(stage)

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="border-b border-border bg-secondary/30 px-5 py-4 md:px-7">
        <h2 className="text-lg font-bold tracking-tight md:text-xl">
          {t('guest.demo.title')} <span className="text-muted-foreground">{t('guest.demo.titleAside')}</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('guest.demo.subtitle')}</p>
      </div>

      <div className="space-y-5 p-5 md:p-7">
        {/* the task + run button */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <div className="flex-1 rounded-xl border border-border bg-background/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('guest.demo.theTask')}</p>
            <p className="mt-1 text-sm font-medium">{prompt}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLE_KEYS.map((_, i) => (
                <button
                  key={i}
                  disabled={running}
                  onClick={() => setExampleIdx(i)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition disabled:opacity-40 ${
                    exampleIdx === i ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-secondary/50'
                  }`}
                >
                  {t('guest.demo.example', { n: i + 1 })}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={run}
            disabled={running}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:opacity-60 sm:w-44"
          >
            {running ? (
              <><Loader2 className="size-4 animate-spin" /> {t('guest.demo.running')}</>
            ) : (
              <><Play className="size-4" /> {t('guest.demo.run')}</>
            )}
          </button>
        </div>

        {/* the pipeline */}
        {stage !== 'idle' && (
          <div className="grid gap-2 sm:grid-cols-4">
            {STEPS.map((step) => {
              const stepIdx = ORDER.indexOf(step.key)
              const done = idx > stepIdx || stage === 'done'
              const active = stage === step.key
              const Icon = step.icon
              return (
                <div
                  key={step.key}
                  className={`rounded-xl border p-3 transition ${
                    done
                      ? 'border-success/40 bg-success/[0.07]'
                      : active
                        ? 'border-primary/50 bg-primary/[0.07]'
                        : 'border-border bg-background/40 opacity-60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {active ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                    ) : done ? (
                      <BadgeCheck className="size-4 shrink-0 text-success" />
                    ) : (
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="text-xs font-semibold">{t(step.labelKey)}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{t(step.subKey)}</p>
                </div>
              )
            })}
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}

        {/* the real result */}
        {stage === 'done' && result && (
          <div className="rounded-xl border border-border bg-background/60 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">{t('guest.demo.result')}</span>
              <span
                className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                  passed === true
                    ? 'border-success/40 bg-success/10 text-success'
                    : passed === false
                      ? 'border-destructive/40 bg-destructive/10 text-destructive'
                      : 'border-warning/40 bg-warning/10 text-warning'
                }`}
              >
                {passed === true
                  ? t('guest.demo.passed')
                  : passed === false
                    ? t('guest.demo.failed')
                    : t('guest.demo.needsReview')}
              </span>
            </div>
            {result.textOutput && (
              <p className="whitespace-pre-wrap rounded-lg border border-border bg-secondary/30 p-3 text-sm">{result.textOutput}</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              🧑‍⚖️ {t('guest.demo.verdict')} <span className="italic">“{result.verdict.reason}”</span>
            </p>
            {result.proof && (
              <Link
                href={`/proof/${result.proof.id}`}
                target="_blank"
                className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2.5 text-xs font-semibold text-success hover:bg-success/15"
              >
                <span>{t('guest.demo.proof')}</span>
                <span className="opacity-70">{t('guest.demo.view')}</span>
              </Link>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
              <span className="text-sm text-muted-foreground">{t('guest.demo.ctaLead')}</span>
              <Link href="/connect" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
                {t('guest.demo.ctaConnect')} <ArrowRight className="size-4" />
              </Link>
              <Link href="/try" className="text-sm font-medium text-primary hover:underline">{t('guest.demo.ctaOwnTask')}</Link>
            </div>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">{t('guest.demo.footnote')}</p>
      </div>
    </section>
  )
}
