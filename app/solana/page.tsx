'use client'

/**
 * /solana — the devnet board, public and no-login like /live.
 *
 * This page is the visible half of the Eternal sprint (docs/solana-port.md):
 * the escrow money loop running on a second runtime. Everything rendered is a
 * live chain read through the same codec the tests pin against the Rust —
 * no database, no cache, and per the repo rule, no invented numbers. The
 * devnet banner is load-bearing disclosure, not decoration: this cluster's
 * tokens cost nothing, and the page must never dress them up as money.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, RefreshCw, Coins, CheckCircle2, Layers, AlertTriangle } from 'lucide-react'
import { getSolanaBoard, type SolanaBoardView } from '@/app/actions/solana'

const STATUS_STYLE: Record<string, string> = {
  Open: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  Accepted: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  Submitted: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  Completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Cancelled: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  Reclaimed: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
}

const fmtTokens = (baseUnits: string) => (Number(baseUnits) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })
const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a)
const shortHash = (h: string) => (h.length > 14 ? `${h.slice(0, 10)}…` : h)

export default function SolanaBoardPage() {
  const [board, setBoard] = useState<SolanaBoardView | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const load = () => getSolanaBoard().then((b) => alive && setBoard(b)).catch(() => {}).finally(() => alive && setLoading(false))
    load()
    const t = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const jobs = board?.jobs ?? []
  const completed = jobs.filter((j) => j.status === 'Completed')
  const escrowed = jobs
    .filter((j) => j.status === 'Open' || j.status === 'Accepted' || j.status === 'Submitted')
    .reduce((s, j) => s + Number(j.bounty), 0)

  return (
    <div className="min-h-svh bg-[#07090d] text-[#e7ebf3]">
      <div className="pointer-events-none fixed inset-0" style={{ background: 'radial-gradient(120% 70% at 50% -10%, rgba(153,69,255,0.14), transparent 60%)' }} />

      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-white/10 bg-black/40 px-4 backdrop-blur-md md:px-8">
        <Layers className="h-5 w-5 text-[#9945FF]" />
        <span className="font-semibold">Handsel × Solana</span>
        <span className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-white/70">{board?.cluster ?? '…'}</span>
        <div className="ml-auto flex items-center gap-4 text-sm">
          <Link href="/live" className="text-white/60 hover:text-white">Base mainnet →</Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-5xl px-4 py-8 md:px-8">
        {board && !board.realMoney && (
          <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <strong>{board.cluster} — no real money.</strong> These tokens cost nothing and are worth nothing.
            The escrow program below is the same money loop that runs with real USDC on Base mainnet,
            ported to a second runtime as a 4-week sprint. It has not earned mainnet standing yet — that
            takes publication, analysis and attack, same as the EVM contracts did.
          </div>
        )}

        <h1 className="text-2xl font-bold md:text-3xl">The escrow money loop, on Solana devnet</h1>
        <p className="mt-2 max-w-2xl text-white/60">
          post → accept (worker bonds) → submit → approve → withdraw. Every row below is a live{' '}
          <code className="rounded bg-white/10 px-1">getProgramAccounts</code> read of a real on-chain account —
          no database behind this page.
        </p>

        {board?.programId && (
          <a
            href={board.programExplorerUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 font-mono text-xs text-white/80 hover:bg-white/10"
          >
            program {shortAddr(board.programId)} <ExternalLink className="h-3 w-3" />
          </a>
        )}

        <div className="mt-6 grid grid-cols-3 gap-3">
          {[
            { icon: Layers, label: 'jobs on chain', value: String(jobs.length) },
            { icon: CheckCircle2, label: 'completed loops', value: String(completed.length) },
            { icon: Coins, label: 'in escrow now', value: `${fmtTokens(String(escrowed))} tok` },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <Icon className="h-4 w-4 text-white/40" />
              <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
              <div className="text-xs text-white/50">{label}</div>
            </div>
          ))}
        </div>

        <div className="mt-8">
          {loading && <div className="flex items-center gap-2 text-white/50"><RefreshCw className="h-4 w-4 animate-spin" /> reading the chain…</div>}

          {!loading && board?.state === 'unconfigured' && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-white/60">
              <AlertTriangle className="mb-2 h-5 w-5 text-amber-400" />
              This deployment is not pointed at a Solana cluster (<code>SOLANA_CLUSTER</code> / <code>SOLANA_PROGRAM_ID</code> unset).
              It is not that the board is empty — there is no board to read.
            </div>
          )}

          {!loading && board?.state === 'unreachable' && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-6 text-rose-200">
              <AlertTriangle className="mb-2 h-5 w-5" />
              The RPC could not be read just now — this is not an empty market. Retrying automatically.
            </div>
          )}

          {!loading && board?.state === 'ok' && jobs.length === 0 && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-white/60">
              No jobs on this program yet. The market is configured and reachable — this zero is real.
            </div>
          )}

          {!loading && board?.state === 'ok' && jobs.length > 0 && (
            <div className="space-y-3">
              {jobs.map((j) => (
                <div key={j.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-sm text-white/50">#{j.id}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[j.status] ?? 'bg-white/10 text-white/60 border-white/20'}`}>
                      {j.status}
                    </span>
                    <span className="font-semibold tabular-nums">{fmtTokens(j.bounty)} tok</span>
                    <span className="text-xs text-white/40">bond {fmtTokens(j.bond)} · fee {fmtTokens(j.fee)}</span>
                    {j.lapsed && <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-xs text-rose-300">deadline lapsed</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-white/50">
                    <a href={j.requesterUrl} target="_blank" rel="noreferrer" className="hover:text-white">
                      requester {shortAddr(j.requester)}
                    </a>
                    {!/^1+$/.test(j.worker) && (
                      <a href={j.workerUrl} target="_blank" rel="noreferrer" className="hover:text-white">
                        worker {shortAddr(j.worker)}
                      </a>
                    )}
                    {j.hasResult && <span title={j.resultHash}>result {shortHash(j.resultHash)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {board?.audit && (
          <div className="mt-8 rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${board.audit.ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              <h2 className="font-semibold">
                Live audit — every invariant recomputed from raw accounts on this refresh
              </h2>
            </div>
            <p className="mt-1 text-xs text-white/50">
              escrowed {fmtTokens(board.audit.totalEscrowed)} · withdrawable {fmtTokens(board.audit.totalWithdrawable)} ·
              vault holds {board.audit.vaultAmount ? fmtTokens(board.audit.vaultAmount) : 'unread'} · {board.audit.ledgerCount} pull-payment ledgers
            </p>
            <ul className="mt-3 space-y-1.5">
              {board.audit.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2 text-sm">
                  <span className={c.ok ? 'text-emerald-400' : 'text-rose-400'}>{c.ok ? '✓' : '✗'}</span>
                  <span className="text-white/80">{c.name}</span>
                  <span className="ml-auto font-mono text-xs text-white/40">{c.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <footer className="mt-10 border-t border-white/10 pt-4 text-xs text-white/40">
          Program source: <code>solana/programs/handsel-market</code> · design &amp; scope:{' '}
          <a
            className="underline hover:text-white/70"
            href="https://github.com/Kairose-master/handsel/blob/main/docs/solana-port.md"
            target="_blank"
            rel="noreferrer"
          >
            docs/solana-port.md
          </a>{' '}
          · the credit engine, grading and UI above this layer are chain-agnostic and already run against Base mainnet.
        </footer>
      </main>
    </div>
  )
}
