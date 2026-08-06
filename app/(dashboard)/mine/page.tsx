'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Pickaxe, Cpu, CircleDollarSign, ShieldCheck, Briefcase, ArrowRight, Loader2, Zap, Wallet, Cloud } from 'lucide-react'
import { getWorkerConsole } from '@/app/actions/worker-console'
import { startMining, startMiningCloud, setAutoMine } from '@/app/actions/mining'
import {
  getPayoutAddress,
  setPayoutAddress,
  withdrawAllEarnings,
  withdrawAgentEarnings,
  getSpendingSettings,
  setSpendingSettings,
} from '@/app/actions/treasury'
import { Celebration } from '@/components/celebration'
import { useI18n } from '@/lib/i18n'
import { CLOUD_PRESETS } from '@/lib/cloud-providers'

type Console_ = Awaited<ReturnType<typeof getWorkerConsole>>
type Worker = Console_['workers'][number]

/** Mining tiers — the credit score rendered in a language every miner
 *  already speaks. Purely cosmetic: the score itself stays the truth. */
function miningTier(score: number): { nameKey: string; emoji: string; className: string } {
  if (score >= 850)
    return {
      nameKey: 'mine.tier.diamond',
      emoji: '💎',
      className:
        'tier-shimmer bg-gradient-to-r from-cyan-500/20 via-sky-400/30 to-cyan-500/20 text-sky-500 dark:text-sky-300 border-sky-400/40',
    }
  if (score >= 750)
    return {
      nameKey: 'mine.tier.gold',
      emoji: '🥇',
      className:
        'tier-shimmer bg-gradient-to-r from-amber-500/20 via-yellow-400/30 to-amber-500/20 text-amber-600 dark:text-amber-300 border-amber-400/40',
    }
  if (score >= 650)
    return { nameKey: 'mine.tier.silver', emoji: '🥈', className: 'bg-secondary text-foreground border-border' }
  if (score >= 500)
    return { nameKey: 'mine.tier.bronze', emoji: '🥉', className: 'bg-orange-500/10 text-orange-600 dark:text-orange-300 border-orange-500/30' }
  return { nameKey: 'mine.tier.copper', emoji: '⛏️', className: 'bg-secondary text-muted-foreground border-border' }
}

/**
 * Worker Console — the "mining" view of the platform. Where a mining
 * dashboard shows hashrate and payouts, this shows the post-hashrate
 * equivalents: is the worker online, what did verified labor earn, and
 * what does the independent grader think of its work.
 */
export default function WorkerConsolePage() {
  const { t } = useI18n()
  const [data, setData] = useState<Console_ | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [startResult, setStartResult] = useState<{ command: string; provisioned: boolean } | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [cloudResult, setCloudResult] = useState<{ provisioned: boolean } | null>(null)
  const [showCloudForm, setShowCloudForm] = useState(false)
  const [cloudUrl, setCloudUrl] = useState('')
  const [cloudModel, setCloudModel] = useState('')
  const [cloudKey, setCloudKey] = useState('')
  const [celebrate, setCelebrate] = useState(false)
  const prevJobsRef = useRef<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(
    () =>
      getWorkerConsole()
        .then((d) => {
          // First-ever verified job → one-time celebration. Only fires on a
          // live 0→N transition witnessed on this page, guarded by
          // localStorage so it never repeats.
          const totalJobs = d.workers.reduce((s, w) => s + w.jobsCompleted, 0)
          const prev = prevJobsRef.current
          prevJobsRef.current = totalJobs
          let seen = true
          try {
            seen = localStorage.getItem('lm-first-job-celebrated') === '1'
          } catch {
            /* private mode */
          }
          if (prev === 0 && totalJobs > 0 && !seen) {
            setCelebrate(true)
            try {
              localStorage.setItem('lm-first-job-celebrated', '1')
            } catch {
              /* private mode */
            }
          }
          setData(d)
        })
        .catch(() => {}),
    [],
  )

  useEffect(() => {
    refresh().finally(() => setLoading(false))
    pollRef.current = setInterval(refresh, 10_000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refresh])

  const handleStartMining = async () => {
    setStarting(true)
    setStartError(null)
    setCloudResult(null)
    try {
      const result = await startMining()
      setStartResult({ command: result.command, provisioned: result.provisioned })
      await refresh()
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const handleStartMiningCloud = async () => {
    setStarting(true)
    setStartError(null)
    setStartResult(null)
    try {
      const result = await startMiningCloud({ baseUrl: cloudUrl, apiKey: cloudKey, model: cloudModel })
      setCloudResult({ provisioned: result.provisioned })
      setShowCloudForm(false)
      setCloudUrl('')
      setCloudModel('')
      setCloudKey('')
      await refresh()
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  if (loading) return <div className="p-8">{t('mine.loading')}</div>

  const workers = data?.workers ?? []
  const locals = workers.filter((w) => w.runtime === 'local')
  const totalEarned = workers.reduce((s, w) => s + w.earnedUsd, 0)
  // A cloud worker has no online/offline heartbeat (see tickCloudAutoMineAgents'
  // doc comment) — autoMine being on IS its "actively mining" state, unlike a
  // local worker where a stale/offline poll should still show as not mining.
  const activelyMining = workers.some(
    (w) => w.autoMine && (w.runtime === 'cloud' || w.runtime === 'mcp' || w.online),
  )

  return (
    <div className="space-y-6">
      {celebrate && (
        <Celebration
          title={t('mine.celebration.title')}
          body={t('mine.celebration.body')}
          onClose={() => setCelebrate(false)}
        />
      )}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Pickaxe className={`size-7 ${activelyMining ? 'animate-swing text-primary' : ''}`} />{' '}
          {t('mine.title')}
          {activelyMining && (
            <span className="rounded-md bg-success/15 px-2 py-1 text-xs font-medium text-success">
              ⛏️ {t('mine.miningBadge')}
            </span>
          )}
        </h1>
        <p className="text-muted-foreground mt-1">
          {t('mine.subtitle')}
        </p>
      </div>

      {/* Market pulse — how much work is waiting right now */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={Briefcase}
          label={t('mine.stats.openJobs')}
          value={String(data?.market.openJobs ?? 0)}
        />
        <StatCard
          icon={CircleDollarSign}
          label={t('mine.stats.bountiesWaiting')}
          value={`$${(data?.market.openBountyUsd ?? 0).toLocaleString()}`}
        />
        <StatCard icon={CircleDollarSign} label={t('mine.stats.earnedByAgents')} value={`$${totalEarned.toLocaleString()}`} />
      </div>

      <PayoutCard hasProvisionedWorker={workers.some((w) => w.provisioned)} />

      {/* One-click pipeline: agent + wallet + auto-mine + connect command */}
      <div className="glass-card rounded-lg border border-border p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">
              {locals.length === 0 ? t('mine.start.title') : t('mine.start.addAnother')}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('mine.start.description')}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              onClick={handleStartMining}
              disabled={starting}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {starting ? <Loader2 className="size-4 animate-spin" /> : <Pickaxe className="size-4" />}
              {starting ? t('mine.start.settingUp') : t('mine.start.button')}
            </button>
            <button
              onClick={() => {
                setShowCloudForm((v) => !v)
                setStartResult(null)
                setCloudResult(null)
              }}
              disabled={starting}
              className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
            >
              <Cloud className="size-4" />
              {t('mine.start.cloudButton')}
            </button>
          </div>
        </div>

        {showCloudForm && (
          <div className="glass-card mt-4 space-y-2 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">{t('mine.start.cloudHint')}</p>
            <div className="flex flex-wrap gap-1.5">
              {CLOUD_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setCloudUrl(p.baseUrl)
                    setCloudModel(p.model)
                  }}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              value={cloudUrl}
              onChange={(e) => setCloudUrl(e.target.value)}
              placeholder="https://api.groq.com/openai/v1"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
              disabled={starting}
            />
            <input
              value={cloudModel}
              onChange={(e) => setCloudModel(e.target.value)}
              placeholder={t('mine.start.cloudModelPlaceholder')}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
              disabled={starting}
            />
            <input
              type="password"
              value={cloudKey}
              onChange={(e) => setCloudKey(e.target.value)}
              placeholder={t('mine.start.cloudApiKeyPlaceholder')}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
              disabled={starting}
            />
            <button
              onClick={handleStartMiningCloud}
              disabled={starting || !cloudUrl.trim() || !cloudModel.trim() || !cloudKey.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {starting ? <Loader2 className="size-4 animate-spin" /> : <Cloud className="size-4" />}
              {t('mine.start.cloudConnect')}
            </button>
          </div>
        )}

        {startError && <p className="mt-3 text-sm text-destructive">{startError}</p>}
        {startResult && (
          <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
            <p className="font-medium mb-1">
              {startResult.provisioned ? t('mine.start.createdProvisioned') : t('mine.start.created')}
            </p>
            <code className="block break-all font-mono select-all">{startResult.command}</code>
            <p className="mt-2 text-muted-foreground">
              {t('mine.start.psNoteBefore')} <code>&&</code>{t('mine.start.psNoteMiddle')}{' '}
              <code>curl.exe</code>{t('mine.start.psNoteAfter')}{' '}
              <a
                className="text-primary hover:underline"
                href="https://github.com/Kairose-master/handsel/blob/main/docs/test-scenarios/local-worker.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('mine.start.walkthroughLink')}
              </a>
              .
            </p>
          </div>
        )}
        {cloudResult && (
          <div className="mt-4 rounded-md border border-success/40 bg-success/10 p-3 text-xs">
            <p className="font-medium">
              {cloudResult.provisioned ? t('mine.start.cloudCreatedProvisioned') : t('mine.start.cloudCreated')}
            </p>
          </div>
        )}
      </div>

      {workers.filter((w) => w.runtime === 'local' || w.runtime === 'cloud' || w.runtime === 'mcp').length === 0 && !startResult && !cloudResult && (
        <div className="glass-card rounded-lg border border-border p-6">
          <p className="font-semibold">{t('mine.empty.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('mine.empty.description')}
          </p>
          <Link
            href="/profile"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            {t('mine.empty.connectLink')} <ArrowRight className="size-3.5" />
          </Link>
        </div>
      )}

      <div className="space-y-3">
        {workers.map((w) => (
          <WorkerCard key={w.id} worker={w} onChanged={refresh} />
        ))}
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, label, value }: { icon: typeof Pickaxe; label: string; value: string }) {
  return (
    <div className="glass-card rounded-lg border border-border p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  )
}

/**
 * Pre-register a payout wallet once, then settle every worker with one
 * click — sweeps each provisioned agent's USDC balance to that address
 * instead of typing a recipient into the Treasury card per agent, per
 * withdrawal.
 */
function PayoutCard({ hasProvisionedWorker }: { hasProvisionedWorker: boolean }) {
  const { t } = useI18n()
  const [address, setAddress] = useState('')
  // What the SERVER has, tracked apart from what is in the input box. Withdraw
  // was gated on the input, so typing an address and clicking Withdraw instead
  // of Save enabled the button while the server still had nothing saved — and
  // the resulting throw reaches the client in production as the generic
  // "An error occurred in the Server Components render" with a digest, because
  // Next.js strips server-action error messages. The catch below faithfully
  // shows e.message; in production e.message IS the redaction notice.
  const [savedAddress, setSavedAddress] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getPayoutAddress()
      .then((r) => {
        setAddress(r.payoutAddress ?? '')
        setSavedAddress(r.payoutAddress ?? '')
      })
      .catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const r = await setPayoutAddress(address)
      // The server's echo, not the input: setPayoutAddress trims, and stores
      // NULL for a blank one — so clearing the box really does clear the saved
      // address, and Withdraw must go back to disabled when it does.
      setSavedAddress(r.payoutAddress ?? '')
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** Typed something, has not saved it. The reason Withdraw stays disabled. */
  const unsavedEdit = address.trim() !== '' && address.trim() !== savedAddress.trim()

  const withdraw = async () => {
    setWithdrawing(true)
    setError(null)
    setResult(null)
    try {
      const r = await withdrawAllEarnings()
      // A returned precondition failure (no payout address saved) — reported
      // before the balance messages below, since none of them apply when
      // nothing was attempted.
      if (r.error) {
        setError(r.error)
        return
      }
      // "No earnings yet" only holds when every agent had a zero balance
      // (withdrawAllEarnings skips those entirely, so r.results is empty).
      // When totalSent is 0 but r.results is non-empty, at least one agent
      // had a real balance that a per-agent error (e.g. daily cap) blocked —
      // showing the generic "nothing to withdraw" message alongside that
      // error would flatly contradict it.
      if (r.totalSent > 0) {
        setResult(t('mine.payout.resultSummary', { total: r.totalSent.toFixed(2), address: `${r.to.slice(0, 6)}…${r.to.slice(-4)}` }))
      } else if (r.results.length === 0) {
        setResult(t('mine.payout.noEarnings'))
      }
      const failed = r.results.filter((x): x is typeof x & { error: string } => Boolean(x.error))
      if (failed.length > 0) {
        setError(failed.map((x) => t('mine.payout.perAgentError', { name: x.name, error: x.error })).join(' · '))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWithdrawing(false)
    }
  }

  return (
    <div className="glass-card rounded-lg border border-border p-6">
      <p className="flex items-center gap-2 font-semibold">
        <Wallet className="size-4" /> {t('mine.payout.title')}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{t('mine.payout.description')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={t('mine.payout.placeholder')}
          className="min-w-[280px] flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        />
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {saving ? t('mine.payout.saving') : t('mine.payout.save')}
        </button>
        <button
          onClick={withdraw}
          // savedAddress, NOT address: the server sweeps to what it has stored,
          // so that is the only value whose presence makes this button safe to
          // press. Gating on the input box let a typed-but-unsaved address
          // through to a 500 whose reason production strips.
          disabled={withdrawing || !savedAddress || !hasProvisionedWorker}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {withdrawing ? <Loader2 className="size-3.5 animate-spin" /> : <CircleDollarSign className="size-3.5" />}
          {withdrawing ? t('mine.payout.withdrawing') : t('mine.payout.withdraw')}
        </button>
      </div>
      {/* A disabled button with no reason is the same puzzle as the digest was.
          Say which of the two preconditions is missing. */}
      {unsavedEdit && (
        <p className="mt-2 text-sm text-muted-foreground">{t('mine.payout.saveFirst')}</p>
      )}
      {!unsavedEdit && !savedAddress && (
        <p className="mt-2 text-sm text-muted-foreground">{t('mine.payout.needAddress')}</p>
      )}
      {savedAddress && !hasProvisionedWorker && (
        <p className="mt-2 text-sm text-muted-foreground">{t('mine.payout.needWorker')}</p>
      )}
      {saved && !error && <p className="mt-2 text-sm text-success">{t('mine.payout.saved')}</p>}
      {result && <p className="mt-2 text-sm text-success">{result}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <SpendingCapsSettings />
    </div>
  )
}

/**
 * The per-account spending caps, editable where they actually bite: right
 * under the withdraw button whose failures ("Daily transfer cap reached")
 * they explain. Empty input = platform default.
 */
function SpendingCapsSettings() {
  const { t } = useI18n()
  const [maxTx, setMaxTx] = useState('')
  const [dailyCap, setDailyCap] = useState('')
  const [defaults, setDefaults] = useState<{ maxPerTxUsd: number; dailyCapUsd: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getSpendingSettings()
      .then((s) => {
        setMaxTx(s.maxTxUsd != null ? String(s.maxTxUsd) : '')
        setDailyCap(s.dailyCapUsd != null ? String(s.dailyCapUsd) : '')
        setDefaults(s.defaults)
      })
      .catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await setSpendingSettings({
        maxTxUsd: maxTx.trim() === '' ? null : Number(maxTx),
        dailyCapUsd: dailyCap.trim() === '' ? null : Number(dailyCap),
      })
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <p className="text-sm font-semibold">{t('mine.payout.capsTitle')}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t('mine.payout.capsDescription')}</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          {t('mine.payout.maxTxLabel')}
          <input
            type="number"
            min="1"
            value={maxTx}
            onChange={(e) => setMaxTx(e.target.value)}
            placeholder={defaults ? t('mine.payout.capsDefault', { value: String(defaults.maxPerTxUsd) }) : ''}
            className="mt-1 block w-40 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('mine.payout.dailyCapLabel')}
          <input
            type="number"
            min="1"
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value)}
            placeholder={defaults ? t('mine.payout.capsDefault', { value: String(defaults.dailyCapUsd) }) : ''}
            className="mt-1 block w-40 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t('mine.payout.capsSave')}
        </button>
      </div>
      {saved && !error && <p className="mt-2 text-sm text-success">{t('mine.payout.capsSaved')}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

function WorkerCard({ worker: w, onChanged }: { worker: Worker; onChanged: () => void }) {
  const { t } = useI18n()
  const [toggling, setToggling] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawNote, setWithdrawNote] = useState<{ ok: boolean; text: string } | null>(null)
  const graded = w.testsPassed + w.testsFailed + w.verifiedPassed + w.verifiedFailed
  const gradedPassRate = graded > 0 ? Math.round(((w.testsPassed + w.verifiedPassed) / graded) * 100) : null

  const withdrawOne = async () => {
    setWithdrawing(true)
    setWithdrawNote(null)
    try {
      const { result } = await withdrawAgentEarnings(w.id)
      if (result.sent > 0) {
        setWithdrawNote({ ok: true, text: t('mine.worker.withdrawSent', { amount: result.sent.toFixed(2) }) })
        if (result.error) setWithdrawNote({ ok: true, text: `${t('mine.worker.withdrawSent', { amount: result.sent.toFixed(2) })} — ${result.error}` })
        onChanged()
      } else if (result.error) {
        setWithdrawNote({ ok: false, text: result.error })
      } else {
        setWithdrawNote({ ok: true, text: t('mine.worker.withdrawNothing') })
      }
    } catch (e) {
      setWithdrawNote({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setWithdrawing(false)
    }
  }

  const toggleAutoMine = async () => {
    setToggling(true)
    try {
      await setAutoMine(w.id, !w.autoMine)
      onChanged()
    } finally {
      setToggling(false)
    }
  }

  const tier = miningTier(w.creditScore)

  return (
    <div className="glass-card rounded-lg border border-border p-4 transition-all hover:border-primary/40 hover:shadow-md">
      <div className="flex flex-wrap items-center gap-2">
        <Cpu className="size-4 text-muted-foreground" />
        <span className="font-semibold">{w.name}</span>
        <span
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${tier.className}`}
          title={t('mine.tier.tooltip', { score: w.creditScore })}
        >
          {tier.emoji} {t(tier.nameKey)}
        </span>
        {w.streak >= 2 && (
          <span
            className="inline-flex items-center gap-0.5 rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-orange-500 dark:text-orange-400"
            title={t('mine.streak.tooltip', { streak: w.streak })}
          >
            🔥 {t('mine.streak.badge', { streak: w.streak })}
          </span>
        )}
        <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
          {w.runtime === 'local' ? t('mine.localWorker') : w.runtime === 'cloud' ? t('mine.cloudWorker') : w.runtime === 'mcp' ? 'MCP agent' : w.runtime}
        </span>
        {w.runtime === 'local' && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${
              w.online ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
            }`}
          >
            <span className={`size-1.5 rounded-full ${w.online ? 'bg-success' : 'bg-warning'}`} />
            {w.online ? t('mine.online') : t('mine.offline')}
          </span>
        )}
        {(w.runtime === 'local' || w.runtime === 'cloud' || w.runtime === 'mcp') && (
          <button
            onClick={toggleAutoMine}
            disabled={toggling || !w.provisioned}
            title={
              w.provisioned
                ? t('mine.autoMine.tooltip')
                : t('mine.autoMine.provisionFirst')
            }
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium disabled:opacity-50 ${
              w.autoMine
                ? 'border-primary/40 bg-primary/15 text-primary'
                : 'border-border text-muted-foreground hover:bg-secondary'
            }`}
          >
            <Zap className="size-3" />
            {toggling ? '…' : w.autoMine ? t('mine.autoMine.on') : t('mine.autoMine.off')}
          </button>
        )}
        {w.provisioned && (
          <button
            onClick={withdrawOne}
            disabled={withdrawing}
            title={t('mine.worker.withdraw')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-secondary disabled:opacity-50"
          >
            {withdrawing ? <Loader2 className="size-3 animate-spin" /> : <Wallet className="size-3" />}
            {withdrawing ? t('mine.worker.withdrawing') : t('mine.worker.withdraw')}
          </button>
        )}
        <span className="ml-auto font-mono text-sm text-muted-foreground">
          {w.creditScore} · {w.rating}
        </span>
      </div>
      {withdrawNote && (
        <p className={`mt-2 text-xs ${withdrawNote.ok ? 'text-success' : 'text-destructive'}`}>{withdrawNote.text}</p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">{t('mine.worker.paidJobs')}</p>
          <p className="font-semibold">{w.jobsCompleted}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t('mine.worker.earned')}</p>
          <p className="font-semibold">${w.earnedUsd.toLocaleString()}</p>
        </div>
        {/* Money the wallet number hides: the bond the market holds while a
            job is in flight (comes back on completion) and settlement credits
            waiting for withdraw. Rendered only when non-zero — the wallet
            tells the whole truth the rest of the time. */}
        {(w.bondedUsd ?? 0) > 0 && (
          <div title={t('mine.worker.bondTooltip')}>
            <p className="text-xs text-muted-foreground">🔒 {t('mine.worker.bonded')}</p>
            <p className="font-semibold tabular-nums">${(w.bondedUsd ?? 0).toFixed(3)}</p>
          </div>
        )}
        {(w.claimableUsd ?? 0) > 0 && (
          <div title={t('mine.worker.claimableTooltip')}>
            <p className="text-xs text-muted-foreground">⏳ {t('mine.worker.claimable')}</p>
            <p className="font-semibold tabular-nums">${(w.claimableUsd ?? 0).toFixed(3)}</p>
          </div>
        )}
        <div>
          <p className="text-xs text-muted-foreground">{t('mine.worker.graded')}</p>
          <p className="font-semibold">{graded}</p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldCheck className="size-3" /> {t('mine.worker.passRate')}
          </p>
          {gradedPassRate === null ? (
            <p className="font-semibold">—</p>
          ) : (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-2 w-full max-w-[120px] overflow-hidden rounded-full bg-secondary">
                <div
                  className={`h-full rounded-full transition-all ${
                    gradedPassRate >= 80 ? 'bg-success' : gradedPassRate >= 50 ? 'bg-warning' : 'bg-destructive'
                  }`}
                  style={{ width: `${gradedPassRate}%` }}
                />
              </div>
              <span className="font-semibold">{gradedPassRate}%</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
