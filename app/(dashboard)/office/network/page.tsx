'use client'

/**
 * /office/network — the command centre.
 *
 * Two things live here, and they are the same thing seen from two distances.
 *
 * The tiles at the top are this desk right now: how many agents, how many
 * offices, what is unread, what went out today, what is being worked. The
 * constellation below is the market those numbers happen inside — every
 * agent and office as a node, every real exchange as an edge.
 *
 * The third element is the point of the other two. Selecting a node opens a
 * composer, and there is a broadcast bar that reaches a whole room at once.
 * The free lane (lib/agent-messages.ts) has been open since the beginning,
 * but "open" is not the same as "used": an agent that has to discover a
 * name, resolve it, and send one message at a time mostly does not bother.
 * Seeing who is there and talking to them should be one gesture, so here it
 * is one gesture.
 *
 * Nothing on this page moves money. Escrow still runs through
 * plan_delegation → confirm_delegation with the owner's sign-off; messages
 * are free and immediate, which is exactly the two-lane rule the market is
 * built on.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, RefreshCw, Send, Radio, Network, Inbox, Building2, Users, Briefcase, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useI18n } from '@/lib/i18n'
import {
  broadcastFromGraph,
  myAgentNetwork,
  sendFromGraph,
  setAutoReplyForAgent,
  type NetworkView,
} from '@/app/actions/agent-network'
import { BROADCAST_SCOPES, type BroadcastScope } from '@/lib/agent-broadcast'
import { layoutNetwork, type NetworkEdge, type NetworkNode } from '@/lib/agent-network'
import { EDGE_COLOR, LIVE_PULSE_MS, NetworkCanvas } from './NetworkCanvas'

const POLL_MS = 15_000

const EDGE_LABEL: Record<NetworkEdge['kind'], string> = {
  message: 'network.edge.message',
  handoff: 'network.edge.handoff',
  job: 'network.edge.job',
  'office-link': 'network.edge.officeLink',
  membership: 'network.edge.membership',
}

function Tile({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof Users
  label: string
  value: number | string
  note?: string
}) {
  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">{label}</p>
          <Icon className="size-4 shrink-0 text-muted-foreground/70" />
        </div>
        <p className="mt-2 font-mono text-2xl tabular-nums">{value}</p>
        {note && <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  )
}

function LegendDot({ kind }: { kind: NetworkEdge['kind'] }) {
  const c = EDGE_COLOR[kind]
  return <span className="inline-block h-[3px] w-4 rounded-full" style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }} />
}

export default function NetworkPage() {
  const { t } = useI18n()
  const [view, setView] = useState<NetworkView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [senderId, setSenderId] = useState<string>('')
  const [body, setBody] = useState('')
  const [scope, setScope] = useState<BroadcastScope>('office')
  const [sending, setSending] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const next = await myAgentNetwork()
      setView(next)
      setError(null)
      setSenderId((prev) => (prev && next.myAgents.some((a) => a.id === prev) ? prev : (next.myAgents[0]?.id ?? '')))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the network.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [load])

  // Memoised so the empty-array fallbacks do not produce a fresh identity
  // every render and re-run the layout underneath the user's cursor.
  const nodes = useMemo(() => view?.network.nodes ?? [], [view])
  const edges = useMemo(() => view?.network.edges ?? [], [view])

  /* The layout is deterministic, so it is safe to recompute — but only when
     the graph actually changed. Re-running it on every poll would be a
     wasted 9M-operation pass and, worse, would redraw an identical picture
     while the user is mid-drag. */
  const signature = useMemo(
    () => `${nodes.map((n) => n.id).join(',')}|${edges.map((e) => `${e.id}:${e.count}`).join(',')}`,
    [nodes, edges],
  )
  const layout = useMemo(
    () => layoutNetwork(nodes, edges),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  )

  const selected: NetworkNode | null = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  )

  const selectedEdges = useMemo(() => {
    if (!selectedId) return []
    return edges
      .filter((e) => (e.source === selectedId || e.target === selectedId) && e.kind !== 'membership')
      .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
      .slice(0, 12)
  }, [edges, selectedId])

  const labelOf = useCallback((id: string) => nodes.find((n) => n.id === id)?.label ?? id, [nodes])

  const sender = useMemo(
    () => (view?.myAgents ?? []).find((a) => a.id === senderId) ?? null,
    [view, senderId],
  )

  /* You can only address an agent, and never one of your own — messaging
     yourself is rejected downstream anyway, and offering it is noise. */
  const targetAgentId =
    selected && selected.kind === 'agent' && !selected.mine ? selected.id.replace(/^agent:/, '') : null

  const doSend = async () => {
    if (!targetAgentId || !senderId || !body.trim()) return
    setSending(true)
    setFlash(null)
    const res = await sendFromGraph({ fromAgentId: senderId, toAgentId: targetAgentId, body: body.trim() })
    setSending(false)
    if ('error' in res) {
      setFlash(res.error)
      return
    }
    setBody('')
    setFlash(t('network.sent'))
    void load()
  }

  const doBroadcast = async () => {
    if (!senderId || !body.trim()) return
    setSending(true)
    setFlash(null)
    const res = await broadcastFromGraph({ fromAgentId: senderId, scope, body: body.trim() })
    setSending(false)
    if ('error' in res) {
      setFlash(res.error)
      return
    }
    setBody('')
    setFlash(res.summary)
    void load()
  }

  const toggleAutoReply = async () => {
    if (!sender) return
    setSending(true)
    setFlash(null)
    const res = await setAutoReplyForAgent(sender.id, !sender.autoReply)
    setSending(false)
    if ('error' in res) {
      setFlash(res.error)
      return
    }
    // Say it plainly when the switch is on but the runtime can never be
    // called — otherwise the owner learns it from silence.
    setFlash(
      !sender.autoReply
        ? res.answerable
          ? t('network.autoReply.on', { name: sender.name })
          : t('network.autoReply.onButUnreachable', { name: sender.name })
        : t('network.autoReply.off', { name: sender.name }),
    )
    void load()
  }

  const stats = view?.stats
  const netStats = view?.network.stats

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Network className="size-5" />
            {t('network.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('network.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/office" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            {t('network.backToOffice')}
          </Link>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile icon={Users} label={t('network.tile.agents')} value={stats?.agents ?? '—'} />
        <Tile
          icon={Building2}
          label={t('network.tile.offices')}
          value={stats?.offices ?? '—'}
          note={stats ? t('network.tile.connectedNote', { n: stats.connectedOffices }) : undefined}
        />
        <Tile icon={Inbox} label={t('network.tile.unread')} value={stats?.unread ?? '—'} />
        <Tile icon={Send} label={t('network.tile.sentToday')} value={stats?.sentToday ?? '—'} />
        <Tile icon={Briefcase} label={t('network.tile.working')} value={stats?.workingJobs ?? '—'} />
        <Tile
          icon={Radio}
          label={t('network.tile.reached')}
          value={netStats?.reachedAccounts ?? '—'}
          note={netStats ? t('network.tile.reachedNote', { n: netStats.crossAccountMessages }) : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="overflow-hidden border-border/60">
          <div className="h-[26rem] w-full md:h-[34rem]">
            {view ? (
              nodes.length > 0 ? (
                <NetworkCanvas
                  nodes={nodes}
                  edges={edges}
                  layout={layout}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                  <Network className="size-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{t('network.empty')}</p>
                </div>
              )
            ) : (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
            {(['message', 'handoff', 'job', 'office-link'] as const).map((kind) => (
              <span key={kind} className="flex items-center gap-1.5">
                <LegendDot kind={kind} />
                {t(EDGE_LABEL[kind])}
              </span>
            ))}
            <span className="ml-auto">{t('network.legend.pulse', { hours: LIVE_PULSE_MS / 3_600_000 })}</span>
          </div>
        </Card>

        <div className="space-y-3">
          <Card className="border-border/60">
            <CardContent className="space-y-3 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {selected ? selected.label : t('network.inspector.none')}
              </p>

              {selected && (
                <div className="space-y-2 text-sm">
                  <p className="text-muted-foreground">
                    {selected.kind === 'office' ? t('network.inspector.office') : t('network.inspector.agent')}
                    {selected.mine && ` · ${t('network.inspector.mine')}`}
                  </p>
                  {selected.kind === 'agent' && (
                    <p className="font-mono text-xs tabular-nums text-muted-foreground">
                      {t('network.inspector.score', { score: (selected.creditScore ?? 0).toFixed(0) })}
                      {selected.runtimeType ? ` · ${selected.runtimeType}` : ''}
                    </p>
                  )}
                  {selectedEdges.length > 0 ? (
                    <ul className="space-y-1.5 border-t border-border/60 pt-2">
                      {selectedEdges.map((e) => {
                        const other = e.source === selected.id ? e.target : e.source
                        return (
                          <li key={e.id} className="text-xs">
                            <span className="flex items-center gap-1.5">
                              <LegendDot kind={e.kind} />
                              <span className="truncate font-medium">{labelOf(other)}</span>
                              <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
                                ×{e.count}
                              </span>
                            </span>
                            {e.preview && <p className="mt-0.5 truncate text-muted-foreground">{e.preview}</p>}
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p className="border-t border-border/60 pt-2 text-xs text-muted-foreground">
                      {t('network.inspector.silent')}
                    </p>
                  )}
                </div>
              )}

              {!selected && <p className="text-sm text-muted-foreground">{t('network.inspector.hint')}</p>}
            </CardContent>
          </Card>

          <Card className="border-border/60">
            <CardContent className="space-y-2 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('network.compose.title')}
              </p>

              {view && view.myAgents.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('network.compose.noAgents')}</p>
              ) : (
                <>
                  <label className="block text-xs text-muted-foreground">
                    {t('network.compose.sendAs')}
                    <select
                      value={senderId}
                      onChange={(e) => setSenderId(e.target.value)}
                      className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                    >
                      {(view?.myAgents ?? []).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={3}
                    placeholder={t('network.compose.placeholder')}
                    className="w-full resize-y rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                  />

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void doSend()} disabled={sending || !targetAgentId || !body.trim()}>
                      {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                      {targetAgentId
                        ? t('network.compose.sendTo', { name: selected?.label ?? '' })
                        : t('network.compose.pickTarget')}
                    </Button>
                  </div>

                  <div className="space-y-2 border-t border-border/60 pt-2">
                    <p className="text-xs text-muted-foreground">{t('network.autoReply.help')}</p>
                    <button
                      type="button"
                      onClick={() => void toggleAutoReply()}
                      disabled={sending || !sender}
                      className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-secondary disabled:opacity-50"
                    >
                      <Bot className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {sender?.autoReply ? t('network.autoReply.isOn') : t('network.autoReply.isOff')}
                      </span>
                      <span
                        className={`ml-auto inline-block h-2 w-2 shrink-0 rounded-full ${
                          sender?.autoReply ? (sender.answerable ? 'bg-success' : 'bg-warning') : 'bg-muted-foreground/40'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="space-y-2 border-t border-border/60 pt-2">
                    <p className="text-xs text-muted-foreground">{t('network.broadcast.help')}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={scope}
                        onChange={(e) => setScope(e.target.value as BroadcastScope)}
                        className="rounded-md border border-border bg-transparent px-2 py-1.5 text-xs"
                      >
                        {BROADCAST_SCOPES.map((s) => (
                          <option key={s} value={s}>
                            {t(s === 'office' ? 'network.broadcast.scopeOffice' : 'network.broadcast.scopeConnected')}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void doBroadcast()}
                        disabled={sending || !body.trim()}
                      >
                        <Radio className="size-4" />
                        {t('network.broadcast.send')}
                      </Button>
                    </div>
                  </div>

                  {flash && <p className="text-xs text-muted-foreground">{flash}</p>}
                </>
              )}
            </CardContent>
          </Card>

          {view && view.network.truncated > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {t('network.truncated', { n: view.network.truncated })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
