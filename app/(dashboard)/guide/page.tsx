'use client'

import { useCallback, useEffect, useState } from 'react'
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
  Loader2,
} from 'lucide-react'
import {
  getGuideProgress,
  guideCreateAgent,
  guideProvision,
  guideRunTask,
  guideSetAutoMine,
  guideTaskState,
  type GuideAgent,
} from '@/app/actions/guide'
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

/* ── Doing the step, here ────────────────────────────────────────────────
 *
 * Every step used to end in a link that took you somewhere else. A guide you
 * have to leave in order to follow is a table of contents, so the steps that
 * are a server call away now happen in the card.
 *
 * Nothing below marks itself done. The checklist's done-state stays what it
 * always was — a real query, re-read a beat after the action — so a button
 * that appears to work but did not is caught by the same mechanism that
 * catches everything else, instead of by a local flag saying it went fine.
 */

const ACT_BTN =
  'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50'
const ACT_INPUT = 'h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm'

/** Which agent an inline control acts on. Hidden when there is only one —
 *  a select with a single option is a decision nobody has to make. */
function AgentPicker({
  agents,
  value,
  onChange,
  label,
}: {
  agents: GuideAgent[]
  value: string
  onChange: (id: string) => void
  label: string
}) {
  if (agents.length <= 1) return null
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-md border border-border bg-background px-2 text-xs"
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  )
}

function StepAction({
  stepKey,
  done,
  progress,
  onChanged,
}: {
  stepKey: string
  /** The live checklist's verdict. Passed in rather than hiding this
   *  component at the call site, because a step can flip to done WHILE its
   *  own panel is showing something — see the guard below. */
  done: boolean
  progress: Progress
  onChanged: () => void
}) {
  const { t } = useI18n()
  const agents = progress.agents
  const [target, setTarget] = useState<string>('')
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskState, setTaskState] = useState<Awaited<ReturnType<typeof guideTaskState>>>(null)

  const agentId = target || agents[0]?.id || ''

  // The started task, followed to its end. This is the only step whose
  // result is worth watching rather than just triggering: it is the one that
  // shows the account something it has never seen it do.
  useEffect(() => {
    if (!taskId) return
    let dead = false
    const tick = async () => {
      try {
        const st = await guideTaskState(taskId)
        if (dead) return
        setTaskState(st)
        if (st && (st.status === 'completed' || st.status === 'failed')) {
          clearInterval(timer)
          onChanged()
        }
      } catch {
        /* transient — the next tick tries again */
      }
    }
    const timer = setInterval(tick, 2000)
    tick()
    return () => {
      dead = true
      clearInterval(timer)
    }
  }, [taskId, onChanged])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const spinner = busy ? <Loader2 className="size-3.5 animate-spin" /> : null
  const needAgent = agents.length === 0

  const body = (() => {
    switch (stepKey) {
      case 's1':
        return (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={ACT_INPUT}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('guide.act.namePh')}
            />
            <button
              className={ACT_BTN}
              disabled={busy || !name.trim()}
              onClick={() => act(() => guideCreateAgent(name.trim()))}
            >
              {spinner} {t('guide.act.create')}
            </button>
          </div>
        )

      case 's3':
        if (needAgent) return <p className="text-xs text-muted-foreground">{t('guide.act.needAgent')}</p>
        return (
          <div className="flex flex-wrap items-center gap-2">
            <AgentPicker agents={agents} value={agentId} onChange={setTarget} label={t('guide.act.agent')} />
            <button className={ACT_BTN} disabled={busy} onClick={() => act(() => guideProvision(agentId))}>
              {spinner} {t('guide.act.provision')}
            </button>
          </div>
        )

      case 's4':
        if (needAgent) return <p className="text-xs text-muted-foreground">{t('guide.act.needAgent')}</p>
        return (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <AgentPicker agents={agents} value={agentId} onChange={setTarget} label={t('guide.act.agent')} />
              <input
                className={ACT_INPUT}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder={t('guide.act.taskPh')}
              />
              <button
                className={ACT_BTN}
                disabled={busy || !task.trim()}
                onClick={() =>
                  act(async () => {
                    const { taskId: id } = await guideRunTask(agentId, task)
                    setTaskId(id)
                  })
                }
              >
                {spinner} {t('guide.act.run')}
              </button>
            </div>
            {taskState && (
              <div className="rounded-md border border-border bg-secondary/40 p-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t('guide.act.result')} · {taskState.status}
                </p>
                {taskState.error ? (
                  <p className="mt-1 text-xs text-destructive">{taskState.error}</p>
                ) : taskState.output ? (
                  <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs">{taskState.output}</pre>
                ) : (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> {t('guide.act.working')}
                  </p>
                )}
              </div>
            )}
          </div>
        )

      case 's5': {
        // Nothing to press: this step happens on the owner's own machine.
        // What the guide can do is notice the moment it works, which is
        // exactly the feedback a terminal command gives you nowhere else.
        const polled = agents.some((a) => a.runtimeType === 'local' && a.lastPollAt !== null)
        return (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {polled ? (
              <>
                <CheckCircle2 className="size-3.5 text-success" /> {t('guide.act.workerSeen')}
              </>
            ) : (
              <>
                <Loader2 className="size-3.5 animate-spin" /> {t('guide.act.waiting')}
              </>
            )}
          </p>
        )
      }

      case 's6': {
        if (needAgent) return <p className="text-xs text-muted-foreground">{t('guide.act.needAgent')}</p>
        const current = agents.find((a) => a.id === agentId)
        const on = Boolean(current?.autoMine)
        return (
          <div className="flex flex-wrap items-center gap-2">
            <AgentPicker agents={agents} value={agentId} onChange={setTarget} label={t('guide.act.agent')} />
            <button className={ACT_BTN} disabled={busy} onClick={() => act(() => guideSetAutoMine(agentId, !on))}>
              {spinner} {on ? t('guide.act.autoMineOff') : t('guide.act.autoMineOn')}
            </button>
          </div>
        )
      }

      // s2 enters a secret and s7 depends on the market having work in it;
      // neither is a button, so those steps keep their link and nothing is
      // invented to fill the space.
      default:
        return null
    }
  })()

  if (!body) return null
  // A step that has just completed keeps its panel if the panel is showing
  // something the person started. Hiding it the instant the checklist ticked
  // over was the first version, and it meant pressing Run made the task, the
  // spinner and the result all disappear at once — the one moment the guide
  // exists to show.
  if (done && !taskId) return null
  return (
    <div className="mt-3 rounded-md border border-primary/25 bg-primary/5 p-3">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-primary">{t('guide.act.hint')}</p>
      {body}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}

export default function GuidePage() {
  const { t } = useI18n()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  // Re-read after an inline action as well as on the timer. Nothing marks
  // itself done locally: the button acts, and the same query that has always
  // decided the checklist decides again a beat later. A button that appeared
  // to work but did not is then caught by the mechanism that catches
  // everything else.
  const load = useCallback(() => {
    getGuideProgress()
      .then(setProgress)
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 8000) // steps check themselves off live
    return () => clearInterval(timer)
  }, [load])

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
                  {progress && <StepAction stepKey={step.key} done={done} progress={progress} onChanged={load} />}
                  {!done && (
                    <Link
                      href={step.href}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-secondary"
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
