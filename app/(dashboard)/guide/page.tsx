'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  BookOpen,
  Bot,
  KeyRound,
  Link2,
  Play,
  Pickaxe,
  Zap,
  Briefcase,
  Fingerprint,
  CheckCircle2,
  Circle,
  ChevronDown,
  ArrowRight,
  ShieldCheck,
  Copy,
  ExternalLink,
  Sparkles,
} from 'lucide-react'
import { getGuideProgress } from '@/app/actions/guide'
import { useI18n } from '@/lib/i18n'
import { mcpUrl } from '@/lib/origin'

type Progress = Awaited<ReturnType<typeof getGuideProgress>>

/**
 * The guide is a LIVE checklist: every step's done-state is a real query
 * (see getGuideProgress), so it checks itself off as the account actually
 * does things. Text lives in the i18n dictionaries (EN/KO/ZH).
 */
const STEPS: {
  key: string
  icon: typeof Bot
  href: string
  doneWhen: (p: Progress) => boolean
  optional?: boolean
}[] = [
  { key: 's1', icon: Bot, href: '/', doneWhen: (p) => p.hasAgent },
  { key: 's2', icon: KeyRound, href: '/settings', doneWhen: (p) => p.hasApiKey, optional: true },
  { key: 's3', icon: Link2, href: '/profile', doneWhen: (p) => p.hasProvisioned },
  { key: 's4', icon: Play, href: '/profile', doneWhen: (p) => p.hasRunTask },
  { key: 's5', icon: Pickaxe, href: '/mine', doneWhen: (p) => p.hasLocalWorker },
  { key: 's6', icon: Zap, href: '/mine', doneWhen: (p) => p.hasAutoMine },
  { key: 's7', icon: Briefcase, href: '/jobs', doneWhen: (p) => p.hasCompletedJob },
  { key: 's8', icon: Fingerprint, href: '/profile', doneWhen: (p) => p.hasErc8004 },
]

const MCP_URL = mcpUrl()

/**
 * The interactive "connect your assistant" step — the fastest way in (the Hire
 * front door). Inline copy of the MCP URL, one-click opens to each client's
 * connector settings, three concrete sub-steps, and a locally-persisted
 * "connected" toggle so returning users see it checked off.
 */
function ConnectAssistantCard() {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    try {
      setConnected(localStorage.getItem('guide-assistant-connected') === '1')
    } catch {
      /* private mode */
    }
  }, [])

  const copy = async () => {
    await navigator.clipboard.writeText(MCP_URL).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const toggleConnected = () => {
    const next = !connected
    setConnected(next)
    try {
      localStorage.setItem('guide-assistant-connected', next ? '1' : '0')
    } catch {
      /* private mode */
    }
  }

  const openClient = (tag: 'claude' | 'chatgpt') => {
    copy()
    window.open(
      tag === 'claude' ? 'https://claude.ai/settings/connectors' : 'https://chatgpt.com',
      '_blank',
      'noopener,noreferrer',
    )
  }

  return (
    <div
      className={`rounded-xl border p-5 transition-colors ${
        connected ? 'border-success/40 bg-success/5' : 'border-primary/40 bg-primary/5'
      }`}
    >
      <div className="flex items-center gap-2">
        {connected ? (
          <CheckCircle2 className="size-5 text-success" />
        ) : (
          <Sparkles className="size-5 text-primary" />
        )}
        <h3 className="font-bold">{t('guide.connect.title')}</h3>
        <span className="ml-auto rounded-md bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
          {t('guide.connect.badge')}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{t('guide.connect.subtitle')}</p>

      {/* Connector URL + copy */}
      <p className="mt-4 text-xs font-medium text-muted-foreground">{t('guide.connect.urlLabel')}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-secondary/60 px-3 py-2 font-mono text-sm">{MCP_URL}</code>
        <button
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Copy className="size-3.5" /> {copied ? t('guide.connect.copied') : t('guide.connect.copy')}
        </button>
      </div>

      {/* One-click opens */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => openClient('claude')}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-secondary"
        >
          {t('guide.connect.openClaude')} <ExternalLink className="size-3.5" />
        </button>
        <button
          onClick={() => openClient('chatgpt')}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-secondary"
        >
          {t('guide.connect.openChatgpt')} <ExternalLink className="size-3.5" />
        </button>
      </div>

      {/* Sub-steps */}
      <ol className="mt-4 space-y-2 text-sm text-muted-foreground">
        {['step1', 'step2', 'step3'].map((s, i) => (
          <li key={s} className="flex gap-2.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold text-foreground">
              {i + 1}
            </span>
            <span>{t(`guide.connect.${s}`)}</span>
          </li>
        ))}
      </ol>

      <div className="glass-card mt-4 rounded-md border border-border bg-background/60 p-3 text-sm">
        <span className="text-muted-foreground">{t('guide.connect.tryLabel')} </span>
        <span className="font-medium">{t('guide.connect.tryExample')}</span>
      </div>

      <button
        onClick={toggleConnected}
        className={`mt-4 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
          connected
            ? 'bg-success/15 text-success hover:bg-success/25'
            : 'border border-border hover:bg-secondary'
        }`}
      >
        {connected ? <CheckCircle2 className="size-4" /> : <Circle className="size-4" />}
        {connected ? t('guide.connect.doneMsg') : t('guide.connect.mark')}
      </button>
    </div>
  )
}

export default function GuidePage() {
  const { t } = useI18n()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => getGuideProgress().then((p) => !cancelled && setProgress(p)).catch(() => {})
    load()
    const timer = setInterval(load, 8000) // steps check themselves off live
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const doneCount = progress ? STEPS.filter((s) => s.doneWhen(progress)).length : 0
  const firstOpen = progress ? STEPS.find((s) => !s.doneWhen(progress))?.key ?? null : null
  const expanded = open ?? firstOpen

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <BookOpen className="size-7" /> {t('guide.title')}
        </h1>
        <p className="text-muted-foreground mt-1">{t('guide.subtitle')}</p>
      </div>

      {/* Progress bar — fills as the account really progresses */}
      <div className="glass-card rounded-lg border border-border p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold">
            {doneCount}/{STEPS.length} {t('guide.progress')}
          </span>
          <span className="font-mono text-muted-foreground">{Math.round((doneCount / STEPS.length) * 100)}%</span>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-success transition-all duration-700"
            style={{ width: `${(doneCount / STEPS.length) * 100}%` }}
          />
        </div>
      </div>

      <ConnectAssistantCard />

      <div className="space-y-2">
        {STEPS.map((step, i) => {
          const done = progress ? step.doneWhen(progress) : false
          const isOpen = expanded === step.key
          const Icon = step.icon
          return (
            <div
              key={step.key}
              className={`rounded-lg border transition-colors ${
                done ? 'border-success/30 bg-success/5' : 'border-border'
              }`}
            >
              <button
                onClick={() => setOpen(isOpen ? '' : step.key)}
                className="flex w-full items-center gap-3 p-4 text-left"
              >
                {done ? (
                  <CheckCircle2 className="size-5 shrink-0 text-success" />
                ) : (
                  <Circle className="size-5 shrink-0 text-muted-foreground" />
                )}
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className={`flex-1 font-medium ${done ? 'text-muted-foreground line-through decoration-success/40' : ''}`}>
                  {i + 1}. {t(`guide.${step.key}.title`)}
                </span>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                    done ? 'bg-success/15 text-success' : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  {done ? t('guide.done') : t('guide.todo')}
                </span>
                <ChevronDown
                  className={`size-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {isOpen && (
                <div className="border-t border-border/60 px-4 pb-4 pt-3 pl-12">
                  <p className="text-sm text-muted-foreground">{t(`guide.${step.key}.desc`)}</p>
                  {!done && (
                    <Link
                      href={step.href}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
                    >
                      {t(`guide.${step.key}.cta`)} <ArrowRight className="size-3.5" />
                    </Link>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="rounded-lg border border-primary/30 bg-primary/5 p-5">
        <p className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-4 text-primary" /> {t('guide.trust.title')}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{t('guide.trust.body')}</p>
      </div>
    </div>
  )
}
