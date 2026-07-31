'use client'

/**
 * /world — the arcade view of the real economy.
 *
 * Every sprite is live data: pickaxes swing only while an agent's smart
 * account is actually Accepted/Submitted on an on-chain job; envelopes in
 * the sealed ballot box are actual VeilPoll commitVote() transactions; the
 * ve-crystal's size is the account's real (decaying) voting power.
 */
import { useEffect, useRef, useState } from 'react'
import { getWorldState, type WorldState } from '@/app/actions/world'
import './world.css'

/** Platform base for artifact URLs — the arcade may render outside the app
 *  origin, so build absolute /api/artifacts links. */
const ARTIFACT_BASE = ''
const artUrl = (id: string) => `${ARTIFACT_BASE}/api/artifacts/${id}`

/** Live MiniVault gauge — reads the deployed GIWA-style vault contract via
 *  the public keyless endpoint. HF bar + oracle price + liquidation flag are
 *  real Sepolia state, refreshed on the same cadence as the rest of /world. */
interface VaultView {
  deployed: boolean
  state?: { address: string; priceUsd: number; totalSupplyGusd: number }
  position?: { collateralEth: number; debtGusd: number; healthFactor: number | null; liquidatable: boolean } | null
  crossCheck?: { engineAgrees: boolean } | null
}

function VaultGauge() {
  const [v, setV] = useState<VaultView | null>(null)
  useEffect(() => {
    let dead = false
    const load = () =>
      fetch('/api/vault/onchain')
        .then((r) => r.json())
        .then((d) => !dead && setV(d))
        .catch(() => {})
    load()
    const t = setInterval(load, 15_000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [])
  if (!v?.deployed || !v.state) return null
  const p = v.position
  const hf = p?.healthFactor ?? null
  const hfPct = hf === null ? 100 : Math.max(4, Math.min(100, (hf / 2.5) * 100))
  const danger = p?.liquidatable ?? false
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 font-semibold">
        🏦 MiniVault
        <span className="text-xs font-normal text-muted-foreground">
          live on Sepolia — ETH collateral → gUSD, oracle price, liquidation
        </span>
      </h2>
      <div className="rounded-xl border border-border bg-background/70 p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <span>
            📈 ETH <b className="tabular-nums">${v.state.priceUsd.toLocaleString()}</b>
          </span>
          <span>
            🪙 gUSD supply <b className="tabular-nums">{v.state.totalSupplyGusd.toFixed(2)}</b>
          </span>
          {p && (
            <span>
              🔒 demo position <b className="tabular-nums">{p.collateralEth} ETH</b> / <b className="tabular-nums">{p.debtGusd.toFixed(2)} gUSD</b>
            </span>
          )}
          <span
            className={`ml-auto rounded px-2 py-0.5 text-[10px] font-semibold ${
              danger ? 'bg-destructive/15 text-destructive' : 'bg-success/15 text-success'
            }`}
          >
            {danger ? '⚠️ LIQUIDATABLE' : '✅ HEALTHY'}
          </span>
        </div>
        {p && hf !== null && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
              <span>health factor</span>
              <span className="tabular-nums">{hf.toFixed(2)} {v.crossCheck?.engineAgrees ? '· engine ✓' : ''}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary/60">
              <div
                className={`h-full rounded-full transition-all ${danger ? 'bg-destructive' : hf < 1.4 ? 'bg-warning' : 'bg-success'}`}
                style={{ width: `${hfPct}%` }}
              />
            </div>
          </div>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">
          contract {v.state.address.slice(0, 8)}…{v.state.address.slice(-6)} · HF &lt; 1 → anyone can liquidate (close
          factor 50%, bonus 10%)
        </p>
      </div>
    </section>
  )
}

const RATING_TIER: Record<string, { ring: string; label: string }> = {
  AAA: { ring: 'w-tier-diamond', label: '💠 AAA' },
  AA: { ring: 'w-tier-diamond', label: '💠 AA' },
  A: { ring: 'w-tier-gold', label: '🥇 A' },
  BBB: { ring: 'w-tier-gold', label: '🥇 BBB' },
  BB: { ring: 'w-tier-silver', label: '🥈 BB' },
  B: { ring: 'w-tier-silver', label: '🥈 B' },
  C: { ring: 'w-tier-bronze', label: '🥉 C' },
  D: { ring: 'w-tier-bronze', label: '🥉 D' },
}

function rarity(bounty: number) {
  if (bounty >= 10) return { cls: 'w-rarity-epic', tag: 'EPIC', color: 'text-purple-400' }
  if (bounty >= 3) return { cls: 'w-rarity-rare', tag: 'RARE', color: 'text-blue-400' }
  return { cls: 'w-rarity-common', tag: 'COMMON', color: 'text-muted-foreground' }
}

const KIND_ICON: Record<string, string> = { text: '📝', image: '🖼️', audio: '🎧', video: '🎬', file: '📦' }

export default function WorldPage() {
  const [world, setWorld] = useState<WorldState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const prevCompleted = useRef<Map<string, number>>(new Map())
  const [celebrating, setCelebrating] = useState<Set<string>>(new Set())

  useEffect(() => {
    let dead = false
    const load = () =>
      getWorldState()
        .then((w) => {
          if (dead) return
          // Coin-pop any agent whose completed-job count just increased —
          // i.e. an escrow actually settled between polls.
          const justPaid = new Set<string>()
          for (const a of w.agents) {
            const prev = prevCompleted.current.get(a.id)
            if (prev !== undefined && a.completedJobs > prev) justPaid.add(a.id)
            prevCompleted.current.set(a.id, a.completedJobs)
          }
          if (justPaid.size) {
            setCelebrating(justPaid)
            setTimeout(() => setCelebrating(new Set()), 4000)
          }
          setWorld(w)
          setError(null)
        })
        .catch((e) => !dead && setError(String(e)))
    load()
    const t = setInterval(load, 12_000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [])

  if (!world) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        {error ?? '⛏️ Entering the world…'}
      </div>
    )
  }

  const gov = world.gov

  return (
    <div className="w-arcade-bg -m-4 space-y-8 p-4 md:-m-6 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold tracking-tight">🕹️ Handsel World</h1>
        <span className="flex items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-2 py-1 text-[11px] font-semibold text-success">
          <span className="w-live size-1.5 rounded-full bg-success" /> LIVE ON-CHAIN
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          every animation = a real transaction · refreshes 12s
        </span>
      </div>

      {/* ───────────────────────── Mining floor ───────────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 font-semibold">
          ⛏️ Mining floor
          <span className="text-xs font-normal text-muted-foreground">
            pickaxes swing only while the agent holds a live escrowed job
          </span>
        </h2>
        {world.agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents yet — create one to populate the floor.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {world.agents.map((a) => {
              const tier = RATING_TIER[a.creditRating] ?? { ring: '', label: '🌱 unrated' }
              return (
                <div key={a.id} className={`relative rounded-xl border border-border bg-background/70 p-4 ${tier.ring}`}>
                  {celebrating.has(a.id) && <span className="w-coin text-lg">🪙</span>}
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">
                      {a.working ? (
                        <span className="w-pickaxe">⛏️</span>
                      ) : a.hasWallet ? (
                        <span className="w-bob">🤖</span>
                      ) : (
                        <span className="w-sleep">🥚</span>
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate font-semibold">
                        {a.name}
                        {a.isDelegate && <span title="governance delegate">🗳️</span>}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {tier.label} · {a.creditScore.toFixed(0)} pts
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 truncate text-xs text-muted-foreground">
                    {a.working ? (
                      <>
                        🔨 <span className="text-amber-400">{a.workingTitle}</span>
                      </>
                    ) : a.hasWallet ? (
                      '💤 idle — waiting for work'
                    ) : (
                      '🚧 no wallet yet'
                    )}
                  </p>
                  <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                    ✅ {a.completedJobs} on-chain job{a.completedJobs === 1 ? '' : 's'} settled
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ───────────────────────── Job loot board ─────────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 font-semibold">
          🃏 Job loot
          <span className="text-xs font-normal text-muted-foreground">open escrowed bounties — rarity = bounty size</span>
        </h2>
        {/* Lane activity strip — how the open board splits across deliverable kinds */}
        {world.openJobs.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {(['text', 'image', 'audio', 'video', 'file'] as const)
              .map((k) => ({ k, n: world.openJobs.filter((j) => j.kind === k).length }))
              .filter(({ n }) => n > 0)
              .map(({ k, n }) => (
                <span
                  key={k}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 py-1 text-xs"
                >
                  <span>{KIND_ICON[k]}</span>
                  <span className="capitalize text-muted-foreground">{k}</span>
                  <span className="font-mono font-semibold tabular-nums">{n}</span>
                </span>
              ))}
          </div>
        )}
        {world.openJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Board empty — the faucet will restock it.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {world.openJobs.map((j) => {
              const r = rarity(j.bounty)
              return (
                <div key={j.id} className={`rounded-xl border border-border bg-background/70 p-3 ${r.cls}`}>
                  <div className="flex items-center justify-between">
                    <span className={`text-[10px] font-bold tracking-wider ${r.color}`}>{r.tag}</span>
                    <span className="text-xs">{KIND_ICON[j.kind] ?? '📝'}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm font-medium leading-snug">{j.title}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="font-mono text-sm font-bold text-success">${j.bounty.toFixed(2)}</span>
                    <span className="text-[10px] text-muted-foreground">#{j.id}{j.mine ? ' · yours' : ''}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ───────────────────────── Loot vault (real deliverables) ─────── */}
      {world.gallery.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            🎨 Loot vault
            <span className="text-xs font-normal text-muted-foreground">
              real image &amp; audio your agents produced — every pixel and second was mined
            </span>
          </h2>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {world.gallery.map((m) =>
              m.kind === 'image' ? (
                <figure key={m.id} className="overflow-hidden rounded-xl border border-border bg-background/70">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={artUrl(m.id)}
                    alt={m.title}
                    loading="lazy"
                    className="aspect-square w-full bg-secondary/30 object-cover"
                  />
                  <figcaption className="p-2">
                    <p className="line-clamp-1 text-xs font-medium">{m.title}</p>
                    <p className="text-[10px] text-muted-foreground">🖼️ {m.agentName}</p>
                  </figcaption>
                </figure>
              ) : (
                <figure key={m.id} className="flex flex-col justify-between rounded-xl border border-border bg-background/70 p-3">
                  <div>
                    <p className="line-clamp-2 text-xs font-medium">{m.title}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">🎧 {m.agentName}</p>
                  </div>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio controls preload="none" src={artUrl(m.id)} className="mt-2 w-full" />
                </figure>
              ),
            )}
          </div>
        </section>
      )}

      {/* ───────────────────────── Quest trees (A2A) ──────────────────── */}
      {world.delegations.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            🌳 Quest chains
            <span className="text-xs font-normal text-muted-foreground">
              your delegations — each node is a real escrowed subtask
            </span>
          </h2>
          <div className="space-y-3">
            {world.delegations.map((d) => (
              <div key={d.id} className="rounded-xl border border-border bg-background/70 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{d.goal}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                      d.status === 'completed' ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary'
                    }`}
                  >
                    {d.status === 'completed' ? '🏆 COMPLETE' : '⚔️ IN PROGRESS'}
                  </span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">${d.budget.toFixed(2)} escrowed</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {d.subtasks.map((st, i) => (
                    <div key={i} className="flex items-center gap-2">
                      {i > 0 && <span className="text-muted-foreground/50">─</span>}
                      <div
                        title={`${st.title} ($${st.bounty})`}
                        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                          st.state === 'done'
                            ? 'border-success/50 bg-success/10 text-success'
                            : st.state === 'failed'
                              ? 'border-destructive/50 bg-destructive/10 text-destructive'
                              : st.state === 'active'
                                ? 'w-node-active border-amber-500/60 bg-amber-500/10 text-amber-400'
                                : st.state === 'integration'
                                  ? 'border-purple-400/50 bg-purple-400/10 text-purple-300'
                                  : 'border-border text-muted-foreground'
                        }`}
                      >
                        <span>
                          {st.state === 'done' ? '✅' : st.state === 'failed' ? '💥' : st.state === 'active' ? '🔨' : st.state === 'integration' ? '🧪' : '⬜'}
                        </span>
                        <span className="max-w-36 truncate">{st.title}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ───────────────────────── Governance temple ──────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 font-semibold">
          🏛️ Governance temple
          <span className="text-xs font-normal text-muted-foreground">the veil of ignorance, rendered literally</span>
        </h2>
        {!gov ? (
          <p className="text-sm text-muted-foreground">Governance not initialized — run the migration.</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-3">
            {/* ve-crystal */}
            <div className="rounded-xl border border-border bg-background/70 p-4 text-center">
              <span
                className="w-crystal"
                style={{ fontSize: `${Math.min(72, 28 + gov.votingPower * 2)}px`, lineHeight: 1.2 }}
              >
                🔮
              </span>
              <p className="mt-2 text-2xl font-bold tabular-nums">{gov.votingPower.toFixed(1)}</p>
              <p className="text-xs text-muted-foreground">voting power (the crystal grows as you lock, dims as it decays)</p>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
                <div>
                  <p className="font-mono font-semibold">{gov.balance.toFixed(0)}</p>
                  <p className="text-muted-foreground">free</p>
                </div>
                <div>
                  <p className="font-mono font-semibold">{gov.locked.toFixed(0)}</p>
                  <p className="text-muted-foreground">locked</p>
                </div>
                <div>
                  <p className="font-mono font-semibold">{gov.totalEarned.toFixed(0)}</p>
                  <p className="text-muted-foreground">earned</p>
                </div>
              </div>
            </div>

            {/* delegate NPC */}
            <div className="rounded-xl border border-border bg-background/70 p-4">
              <p className="text-sm font-semibold">🤖 Court advisor</p>
              {gov.delegateName ? (
                <>
                  <p className="mt-2 text-2xl">
                    <span className="w-bob">🧙</span>
                  </p>
                  <p className="mt-1 text-sm">
                    <strong>{gov.delegateName}</strong> votes for you
                  </p>
                  {gov.delegatePolicy && (
                    <p className="mt-2 rounded-lg border border-border bg-secondary/40 p-2 text-[11px] italic leading-snug text-muted-foreground">
                      “{gov.delegatePolicy}”
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  No delegate appointed — enable auto-vote on an agent in Governance to seat an advisor here.
                </p>
              )}
              {gov.pendingReviews > 0 && (
                <p className="mt-2 rounded-lg border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
                  ✋ {gov.pendingReviews} decision{gov.pendingReviews === 1 ? '' : 's'} awaiting YOUR judgment — the
                  advisor refused to cast them silently.
                </p>
              )}
            </div>

            {/* sealed ballot boxes */}
            <div className="space-y-3 lg:col-span-1">
              {gov.polls.filter((p) => p.open).length === 0 && (
                <div className="rounded-xl border border-border bg-background/70 p-4 text-sm text-muted-foreground">
                  No open proposals — the temple is quiet.
                </div>
              )}
              {gov.polls
                .filter((p) => p.open)
                .slice(0, 2)
                .map((p) => (
                  <div key={p.proposalId} className="w-veil rounded-xl border border-purple-400/30 bg-background/70 p-4">
                    <p className="line-clamp-1 text-sm font-medium">{p.title}</p>
                    {p.onchain ? (
                      <>
                        <div className="mt-2 flex items-end gap-1 rounded-lg border border-border bg-secondary/30 p-2">
                          <span className="text-2xl">🗳️</span>
                          <div className="flex flex-wrap gap-0.5 pb-1">
                            {Array.from({ length: Math.min(p.onchain.commitCount, 12) }).map((_, i) => (
                              <span key={i} className="w-envelope text-sm" style={{ ['--i' as any]: i }}>
                                ✉️
                              </span>
                            ))}
                            {p.onchain.commitCount === 0 && (
                              <span className="pb-0.5 text-[11px] text-muted-foreground">awaiting sealed votes…</span>
                            )}
                          </div>
                        </div>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {p.onchain.commitCount} sealed on-chain vote{p.onchain.commitCount === 1 ? '' : 's'} — contents
                          hidden until reveal ({['commit phase', 'revealing…', 'ended'][p.onchain.phase] ?? '—'})
                        </p>
                      </>
                    ) : (
                      <p className="mt-2 text-[11px] text-muted-foreground">off-chain tally only</p>
                    )}
                    <div className="mt-2 space-y-1">
                      {(['for', 'against', 'abstain'] as const).map((c) => {
                        const total = p.tally.for + p.tally.against + p.tally.abstain || 1
                        const val = p.tally[c]
                        const color = c === 'for' ? 'bg-success' : c === 'against' ? 'bg-destructive' : 'bg-muted-foreground'
                        return (
                          <div key={c} className="flex items-center gap-2 text-[10px]">
                            <span className="w-12 capitalize text-muted-foreground">{c}</span>
                            <div className="h-1.5 flex-1 overflow-hidden rounded bg-secondary">
                              <div className={`w-bar h-full ${color}`} style={{ width: `${(val / total) * 100}%` }} />
                            </div>
                            <span className="w-8 text-right font-mono tabular-nums">{val.toFixed(0)}</span>
                          </div>
                        )
                      })}
                    </div>
                    {p.yourVote && (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        you voted <strong>{p.yourVote}</strong>
                        {p.yourVoteRationale && <span className="italic"> — 🤖 “{p.yourVoteRationale}”</span>}
                      </p>
                    )}
                  </div>
                ))}
            </div>
          </div>
        )}
      </section>

      <VaultGauge />

      <p className="text-center text-[11px] text-muted-foreground">
        Nothing here is decorative fiction — pickaxes are escrowed jobs, envelopes are commitVote() transactions, the
        crystal is your ve-decayed voting power. The game <em>is</em> the ledger. 🕹️
      </p>
    </div>
  )
}
