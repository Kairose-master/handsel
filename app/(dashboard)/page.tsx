'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Plus, Loader2, Radio, Briefcase, Store, ShoppingCart, CheckCircle2 } from 'lucide-react'
import { getAgents, bootstrapFirstAgent, createAgent } from '@/app/actions/agents'
import { getPlatformFeed } from '@/app/actions/feed'
import { useI18n } from '@/lib/i18n'
import { Chip, PageHead, Panel, StatusDot } from '@/components/deck'

type FeedEvent = { id: string; kind: string; summary: string; createdAt: string | Date }

const FEED_ICON: Record<string, typeof Briefcase> = {
  JOB_POSTED: Briefcase,
  JOB_COMPLETED: CheckCircle2,
  TEMPLATE_PUBLISHED: Store,
  TEMPLATE_PURCHASED: ShoppingCart,
}

function LiveActivityFeed() {
  const { t } = useI18n()
  const [events, setEvents] = useState<FeedEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      getPlatformFeed(15)
        .then((rows) => {
          if (!cancelled) setEvents(rows as FeedEvent[])
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    load()
    const interval = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return (
    <Panel
      title={t('dash.feed.title')}
      icon={<Radio />}
      actions={<StatusDot tone={loading ? 'idle' : 'ok'} label={loading ? '···' : 'LIVE'} pulse={!loading} />}
      bodyClassName="p-0"
    >
      {loading ? (
        <p className="p-3 text-sm text-muted-foreground">{t('dash.feed.loading')}</p>
      ) : events.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">{t('dash.feed.empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {events.map((e) => {
            const Icon = FEED_ICON[e.kind] ?? Radio
            return (
              <li key={e.id} className="feed-enter flex items-start gap-3 px-3 py-2 text-sm">
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 truncate">{e.summary}</p>
                <time className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {new Date(e.createdAt).toLocaleTimeString()}
                </time>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

export default function DashboardPage() {
  const { t } = useI18n()
  const [agents, setAgents] = useState<any[]>([])
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const load = async () => {
    const data = await getAgents()
    setAgents(data)
  }

  useEffect(() => {
    const init = async () => {
      try {
        const me = await fetch('/api/me')
        if (me.ok) setUser((await me.json()).user)

        // Give first-time users a single cold-start agent (score 0, unrated)
        await bootstrapFirstAgent().catch(() => {})

        await load()
      } catch (error) {
        console.error('[v0] Error:', error)
      } finally {
        setLoading(false)
      }
    }

    init()
  }, [])

  const handleCreate = async () => {
    setCreateBusy(true)
    setCreateError(null)
    try {
      const { id } = await createAgent({ name: newName, description: newDescription })
      setNewName('')
      setNewDescription('')
      setCreating(false)
      await load()
      window.location.href = `/profile?agent=${id}`
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreateBusy(false)
    }
  }

  if (loading) {
    return <div className="p-8 text-center">{t('dash.loading')}</div>
  }

  return (
    <div className="space-y-5">
      <PageHead title={t('dash.welcome', { name: user?.name || t('dash.defaultUserName') })} subtitle={t('dash.subtitle')} />

      <Panel
        title={t('dash.yourAgents', { count: agents.length })}
        actions={
          <button
            onClick={() => setCreating((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-secondary"
          >
            <Plus className="size-3" /> {t('dash.newAgent')}
          </button>
        }
        bodyClassName="p-0"
      >
        {creating && (
          <div className="space-y-3 border-b border-border bg-secondary/30 p-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('dash.create.namePlaceholder')}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border bg-background px-3 text-sm"
            />
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder={t('dash.create.descriptionPlaceholder')}
              rows={2}
              className="w-full rounded-[var(--radius-sm)] border border-border bg-background p-3 text-sm"
            />
            {createError && <p className="text-sm text-destructive">{createError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleCreate}
                disabled={createBusy || !newName.trim()}
                className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {createBusy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {t('dash.create.submit')}
              </button>
              <button
                onClick={() => setCreating(false)}
                className="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-sm hover:bg-secondary"
              >
                {t('dash.create.cancel')}
              </button>
              <p className="basis-full text-xs text-muted-foreground">{t('dash.create.helper')}</p>
            </div>
          </div>
        )}

        {agents.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{t('dash.agents.empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {agents.map((agent) => {
              const unrated = agent.creditRating === 'unrated'
              return (
                <li key={agent.id}>
                  <Link
                    href={`/profile?agent=${agent.id}`}
                    className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-secondary/50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{agent.name}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {agent.walletAddress?.substring(0, 12)}…
                      </span>
                    </span>
                    {/* An unrated agent is a STATE, not a blank score: a cold
                        start is the honest reading of "no graded work yet",
                        and printing 0 there would be a claim. */}
                    {unrated ? (
                      <Chip>{t('dash.noHistoryYet')}</Chip>
                    ) : (
                      <span className="text-right">
                        <span className="block font-mono text-sm font-semibold tabular-nums">
                          {Math.round(parseFloat(agent.creditScore))}
                        </span>
                        <span className="block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {agent.riskRating}
                        </span>
                      </span>
                    )}
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { href: '/profile', label: t('dash.links.profile') },
          { href: '/jobs', label: t('dash.links.jobs') },
          { href: '/credit-scores', label: t('dash.links.creditScores') },
          { href: '/guide', label: t('dash.links.guide') },
        ].map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border bg-card px-3 py-2.5 text-sm transition-colors hover:border-primary/50 hover:bg-secondary/50"
          >
            <span className="min-w-0 truncate">{link.label}</span>
            <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>

      <LiveActivityFeed />
    </div>
  )
}
