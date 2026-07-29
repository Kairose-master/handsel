'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Wallet,
  CalendarDays,
  Cpu,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  ListChecks,
  Wrench,
  Sparkles,
  Banknote,
  HandCoins,
  Link2,
  ExternalLink,
  Send,
  Copy,
  Coins,
  ChevronsUpDown,
  Webhook,
  RefreshCw,
  Scale,
  Bot,
  Cloud,
} from 'lucide-react'
import { getAgents } from '@/app/actions/agents'
import { drawCredit, repayCredit, getCreditDraws } from '@/app/actions/credit'
import { getTreasury, sendFromTreasury, mintTestUsdc } from '@/app/actions/treasury'
import { CLOUD_PRESETS } from '@/lib/cloud-providers'
import {
  getWebhookConfig,
  setWebhookUrl,
  switchToPlatformRuntime,
  generateAgentWebhookSecret,
  connectLocalWorker,
  setCloudApiWorker,
  disconnectCloudApiWorker,
  setMcpWorker,
  disconnectMcpWorker,
} from '@/app/actions/webhook'
import {
  getOnchainInfo,
  provisionSmartAccount,
  drawOnchain,
  repayOnchain,
} from '@/app/actions/onchain'
import { getBalanceSheet, type BalanceSheet } from '@/app/actions/balance-sheet'
import { useI18n } from '@/lib/i18n'
import { CreditEvolutionChart } from '@/components/charts'
import { LiveTaskProgress } from '@/components/live-task-progress'

type OnchainInfo = {
  configured: boolean
  agentConfigured: boolean
  smartAccountAddress: string | null
  available: number | null
  outstanding: number | null
  explorer: string
  chainName?: string
  erc8004Configured?: boolean
  erc8004Id?: number | null
}

type CreditState = {
  score: number
  rating: string
  creditLimit: number
  riskLevel: string
}

type AgentProfile = {
  identity: {
    id: string
    name: string
    description: string | null
    walletAddress: string
    modelVersion: string | null
    createdAt: string
  }
  performance: {
    totalTasks: number
    completedTasks: number
    failedTasks: number
    successRate: number | null
    avgQuality: number | null
    totalTokenCost: number
  }
  credit: CreditState & { availableCredit: number }
}

type AgentEvent = {
  id: string
  taskId: string
  eventType: string
  success: boolean
  executionTime: number
  tokenCost: number
  qualityScore: number | null
  detail: Record<string, unknown>
  createdAt: string
}

type CreditHistoryEntry = {
  id: string
  score: number
  rating: string
  creditLimit: number
  riskLevel: string
  calculationReason: string
  createdAt: string
}

type TaskResult = {
  taskId?: string
  status: 'running' | 'processing' | 'completed' | 'failed'
  output: string | null
  result: {
    success: boolean
    plan: string
    qualityScore: number
    executionTime: number
    tokenCost: number
  } | null
  credit: (CreditState & { previousScore: number | null; calculationReason: string }) | null
  error: string | null
}

type Draw = { id: string; amount: string; description: string | null; createdAt: string }

const EVENT_META: Record<string, { label: string; Icon: typeof Play }> = {
  TASK_STARTED: { label: 'profile.events.taskStarted', Icon: Play },
  PLAN_CREATED: { label: 'profile.events.planCreated', Icon: ListChecks },
  TOOL_EXECUTED: { label: 'profile.events.toolExecuted', Icon: Wrench },
  TASK_COMPLETED: { label: 'profile.events.taskCompleted', Icon: CheckCircle2 },
  TASK_FAILED: { label: 'profile.events.taskFailed', Icon: XCircle },
  ACHIEVEMENT_VERIFIED: { label: 'profile.events.achievementVerified', Icon: Sparkles },
  REPAYMENT_COMPLETED: { label: 'profile.events.repaymentCompleted', Icon: HandCoins },
  VERIFIED_TASK_COMPLETED: { label: 'profile.events.verifiedTaskCompleted', Icon: CheckCircle2 },
  VERIFIED_TASK_FAILED: { label: 'profile.events.verifiedTaskFailed', Icon: XCircle },
  WALLET_TRANSFER: { label: 'profile.events.walletTransfer', Icon: Send },
  WALLET_MINT: { label: 'profile.events.walletMint', Icon: Coins },
}

type Treasury = {
  configured: boolean
  address: string | null
  usdc: number | null
  spent24h: number
  maxPerTx: number
  dailyCap: number
}

/**
 * Wallet-card visual tier, derived from the agent's real credit rating —
 * a better rating literally upgrades the metal of its card. Every tier keeps
 * a dark base so the white card content stays legible.
 */
function cardTier(rating: string): { gradient: string; label: string; badge: string } {
  const r = (rating ?? '').toUpperCase()
  const sheen = 'radial-gradient(130% 130% at 0% 0%, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0) 44%), '
  if (r === 'AAA' || r === 'AA')
    return { gradient: sheen + 'linear-gradient(135deg, #1c1608 0%, #8a6d1e 58%, #caa544 100%)', label: 'Gold', badge: '#ecd68a' }
  if (r === 'A' || r === 'BBB')
    return { gradient: sheen + 'linear-gradient(135deg, #12224a 0%, #1f5fd0 60%, #2f83ef 100%)', label: 'Sapphire', badge: '#c2d9ff' }
  if (r === 'BB' || r === 'B')
    return { gradient: sheen + 'linear-gradient(135deg, #1c110b 0%, #7a4a2a 58%, #b9713f 100%)', label: 'Bronze', badge: '#e8b892' }
  return { gradient: sheen + 'linear-gradient(135deg, #15171c 0%, #33404f 58%, #566577 100%)', label: 'Graphite', badge: '#c7d0dc' }
}

export default function ProfilePage() {
  const { t } = useI18n()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [agentId, setAgentId] = useState<string | null>(null)
  const [allAgents, setAllAgents] = useState<{ id: string; name: string }[]>([])
  const [profile, setProfile] = useState<AgentProfile | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [history, setHistory] = useState<CreditHistoryEntry[]>([])
  const [draws, setDraws] = useState<Draw[]>([])
  const [loading, setLoading] = useState(true)

  const [task, setTask] = useState('')
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<TaskResult | null>(null)
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  const [drawAmount, setDrawAmount] = useState('')
  const [creditBusy, setCreditBusy] = useState(false)
  const [creditError, setCreditError] = useState<string | null>(null)

  const [onchain, setOnchain] = useState<OnchainInfo | null>(null)
  const [lastTxHash, setLastTxHash] = useState<string | null>(null)

  const [treasury, setTreasury] = useState<Treasury | null>(null)
  const [sendTo, setSendTo] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [treasuryBusy, setTreasuryBusy] = useState(false)
  const [treasuryMsg, setTreasuryMsg] = useState<string | null>(null)

  const [balanceSheet, setBalanceSheet] = useState<BalanceSheet | null>(null)

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (id: string) => {
    const [profileRes, eventsRes, historyRes, drawsData, onchainData] = await Promise.all([
      fetch(`/api/agents/${id}`),
      fetch(`/api/agents/${id}/events?limit=30`),
      fetch(`/api/agents/${id}/credit-history`),
      getCreditDraws(id).catch(() => []),
      getOnchainInfo(id).catch(() => null),
    ])
    if (profileRes.ok) setProfile(await profileRes.json())
    if (eventsRes.ok) setEvents((await eventsRes.json()).events)
    if (historyRes.ok) setHistory((await historyRes.json()).history)
    setDraws(drawsData as Draw[])
    setOnchain(onchainData as OnchainInfo | null)
    setTreasury(await getTreasury(id).catch(() => null))
    setBalanceSheet(await getBalanceSheet(id).catch(() => null))
  }, [])

  const handleSend = async () => {
    if (!agentId || treasuryBusy) return
    setTreasuryBusy(true)
    setTreasuryMsg(null)
    try {
      const { txHash } = await sendFromTreasury(agentId, sendTo.trim(), parseFloat(sendAmount))
      setTreasuryMsg(t('profile.treasury.sentMsg', { tx: txHash.slice(0, 14) }))
      setSendTo('')
      setSendAmount('')
      await refresh(agentId)
    } catch (error) {
      setTreasuryMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setTreasuryBusy(false)
    }
  }

  const [mintAmount, setMintAmount] = useState('1000')
  const [mintBusy, setMintBusy] = useState(false)

  const handleMint = async () => {
    if (!agentId || mintBusy) return
    setMintBusy(true)
    setTreasuryMsg(null)
    try {
      const { txHash } = await mintTestUsdc(agentId, parseFloat(mintAmount))
      setTreasuryMsg(t('profile.treasury.mintedMsg', { amount: mintAmount, tx: txHash.slice(0, 14) }))
      await refresh(agentId)
    } catch (error) {
      setTreasuryMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setMintBusy(false)
    }
  }

  const onchainReady = Boolean(onchain?.agentConfigured && onchain?.smartAccountAddress)

  useEffect(() => {
    const init = async () => {
      try {
        const agents = await getAgents()
        setAllAgents(agents.map((a: any) => ({ id: a.id, name: a.name })))
        if (agents.length > 0) {
          const requested = searchParams.get('agent')
          const target = agents.find((a: any) => a.id === requested) ?? agents[0]
          setAgentId(target.id)
          await refresh(target.id)
        }
      } catch (error) {
        console.error('[v0] Error:', error)
      } finally {
        setLoading(false)
      }
    }
    init()
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, searchParams])

  const switchAgent = async (id: string) => {
    if (id === agentId) return
    router.replace(`/profile?agent=${id}`, { scroll: false })
    setAgentId(id)
    setLoading(true)
    setLastRun(null)
    await refresh(id)
    setLoading(false)
  }

  const pollTask = useCallback(
    (id: string, taskId: string) => {
      const tick = async () => {
        try {
          const res = await fetch(`/api/agents/${id}/tasks/${taskId}`)
          if (!res.ok) throw new Error(`Poll failed (${res.status})`)
          const data: TaskResult = await res.json()
          setLastRun(data)
          if (data.status === 'completed' || data.status === 'failed') {
            setRunning(false)
            await refresh(id)
            return
          }
          pollRef.current = setTimeout(tick, 2500)
        } catch (error) {
          setRunError(error instanceof Error ? error.message : String(error))
          setRunning(false)
        }
      }
      pollRef.current = setTimeout(tick, 2000)
    },
    [refresh],
  )

  const runTask = async () => {
    if (!agentId || !task.trim() || running) return
    setRunning(true)
    setRunError(null)
    setLastRun(null)
    try {
      const response = await fetch(`/api/agents/${agentId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: task.trim() }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`)
      setTask('')
      setRunningTaskId(data.taskId)
      pollTask(agentId, data.taskId)
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error))
      setRunning(false)
    }
  }

  const handleProvision = async () => {
    if (!agentId || creditBusy) return
    setCreditBusy(true)
    setCreditError(null)
    try {
      await provisionSmartAccount(agentId)
      await refresh(agentId)
    } catch (error) {
      setCreditError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreditBusy(false)
    }
  }

  const handleDraw = async () => {
    if (!agentId || creditBusy) return
    const amount = parseFloat(drawAmount)
    setCreditBusy(true)
    setCreditError(null)
    setLastTxHash(null)
    try {
      if (onchainReady) {
        const { txHash } = await drawOnchain(agentId, amount, 'On-chain credit draw')
        setLastTxHash(txHash)
      } else {
        await drawCredit(agentId, amount, 'Manual credit draw')
      }
      setDrawAmount('')
      await refresh(agentId)
    } catch (error) {
      setCreditError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreditBusy(false)
    }
  }

  const handleRepay = async (txId: string) => {
    if (!agentId || creditBusy) return
    setCreditBusy(true)
    setCreditError(null)
    setLastTxHash(null)
    try {
      if (onchainReady) {
        const { txHash } = await repayOnchain(txId)
        setLastTxHash(txHash)
      } else {
        await repayCredit(txId)
      }
      await refresh(agentId)
    } catch (error) {
      setCreditError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreditBusy(false)
    }
  }

  if (loading) return <div className="p-8">{t('profile.loading')}</div>
  if (!agentId || !profile) return <div className="p-8">{t('profile.noAgentFound')}</div>

  const { identity, performance, credit } = profile
  const evolution = [...history]
    .reverse()
    .map((entry) => ({
      label: new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      score: entry.score,
    }))
  const outstanding = draws.reduce((sum, d) => sum + parseFloat(d.amount), 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">{t('profile.title')}</h1>
          <p className="text-muted-foreground">
            {t('profile.subtitle')}
          </p>
        </div>
        {allAgents.length > 1 && (
          <div className="relative">
            <select
              value={agentId ?? ''}
              onChange={(e) => switchAgent(e.target.value)}
              className="h-10 appearance-none rounded-md border border-border bg-background pl-3 pr-9 text-sm font-medium"
            >
              {allAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <ChevronsUpDown className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Credit profile banner */}
      <div className="border border-border rounded-lg p-6">
        <div className="flex flex-col md:flex-row md:items-start gap-6">
          <div className="flex-1">
            <h2 className="text-2xl font-bold">{identity.name}</h2>
            <p className="text-sm text-muted-foreground mt-1">{identity.description}</p>
            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Wallet className="size-3.5" />
                <span className="font-mono">{identity.walletAddress.slice(0, 10)}…{identity.walletAddress.slice(-6)}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Cpu className="size-3.5" />
                {identity.modelVersion ?? 'claude-sonnet-5'}
              </span>
              <span className="flex items-center gap-1.5">
                <CalendarDays className="size-3.5" />
                {new Date(identity.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
          {credit.rating === 'unrated' ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-4 text-center">
              <p className="text-sm font-medium">{t('profile.noCreditHistory')}</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                {t('profile.noCreditHistoryHint')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
              <div>
                <p className="text-3xl font-bold font-mono">{credit.score}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('profile.creditScore')}</p>
              </div>
              <div>
                <p className="text-3xl font-bold">{credit.rating}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('profile.creditRating')}</p>
              </div>
              <div>
                <p className="text-3xl font-bold font-mono">${credit.creditLimit.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('profile.creditLimit')}</p>
              </div>
              <div>
                <p className="text-3xl font-bold">{credit.riskLevel}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('profile.riskLevel')}</p>
              </div>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-4 border-t border-border text-sm">
          <div>
            <span className="text-muted-foreground">{t('profile.tasksCompleted')}</span>{' '}
            <span className="font-mono font-semibold">{performance.completedTasks}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('profile.successRate')}</span>{' '}
            <span className="font-mono font-semibold">
              {performance.successRate === null ? '—' : `${(performance.successRate * 100).toFixed(1)}%`}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('profile.avgQuality')}</span>{' '}
            <span className="font-mono font-semibold">
              {performance.avgQuality === null ? '—' : `${(performance.avgQuality * 100).toFixed(0)}%`}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('profile.tokenCost')}</span>{' '}
            <span className="font-mono font-semibold">{performance.totalTokenCost.toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Financial statement — the agent's balance sheet, same lens used to evaluate a company */}
      {balanceSheet && <BalanceSheetCard sheet={balanceSheet} />}

      {/* Runtime — platform Claude runtime, or bring your own agent */}
      {agentId && <RuntimeCard agentId={agentId} />}

      {/* Task runner — the entry point of the vertical slice */}
      <div className="border border-border rounded-lg p-6">
        <h3 className="font-bold text-lg mb-1">{t('profile.task.title')}</h3>
        <p className="text-sm text-muted-foreground mb-4">
          {t('profile.task.subtitle')}
        </p>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder={t('profile.task.placeholder')}
          rows={3}
          className="w-full rounded-md border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={running}
        />
        <div className="flex items-center justify-between mt-3">
          <p className="text-xs text-muted-foreground">
            {running
              ? lastRun?.status === 'processing'
                ? t('profile.task.recording')
                : t('profile.task.working')
              : ' '}
          </p>
          <button
            onClick={runTask}
            disabled={running || !task.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? t('profile.task.running') : t('profile.task.execute')}
          </button>
        </div>

        <LiveTaskProgress taskId={runningTaskId} active={running} />

        {runError && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {runError}
          </div>
        )}

        {lastRun && (lastRun.status === 'completed' || lastRun.status === 'failed') && (
          <div className="mt-4 space-y-3">
            <div className="rounded-md border border-border p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                {lastRun.result?.success ? (
                  <CheckCircle2 className="size-4 text-success" />
                ) : (
                  <XCircle className="size-4 text-destructive" />
                )}
                {lastRun.result?.success ? t('profile.task.completed') : t('profile.task.failed')}
                {lastRun.result && (
                  <span className="text-xs font-normal text-muted-foreground font-mono">
                    {t('profile.task.resultMeta', {
                      time: lastRun.result.executionTime,
                      tokens: lastRun.result.tokenCost.toLocaleString(),
                      quality: (lastRun.result.qualityScore * 100).toFixed(0),
                    })}
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm whitespace-pre-wrap">{lastRun.output || lastRun.error}</p>
            </div>
            {lastRun.credit && (
              <div className="rounded-md border border-border p-4 text-sm">
                <p className="font-semibold mb-1">{t('profile.task.creditUpdate')}</p>
                <p className="font-mono text-lg">
                  {lastRun.credit.previousScore ?? '—'} → {lastRun.credit.score}{' '}
                  <span className="text-sm">
                    {t('profile.task.creditSummary', {
                      rating: lastRun.credit.rating,
                      limit: lastRun.credit.creditLimit.toLocaleString(),
                      risk: lastRun.credit.riskLevel,
                    })}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{lastRun.credit.calculationReason}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* On-chain layer (agent account · EAS · configured chain)
       *
       * Gated on `agentConfigured`, NOT `configured`. `configured` is
       * isOnchainConfigured(), which is about talking to the registry AND the
       * credit vault as the oracle — so it demands CREDIT_VAULT_ADDRESS, and
       * this card is where an agent's smart account gets provisioned in the
       * first place. With a labour market deployed and no vault, the whole
       * card vanished and with it the only Provision button in the app: the
       * one action that has to happen before anything on-chain can.
       *
       * The credit figures inside genuinely do need the vault, and they are
       * already guarded separately — `getOnchainInfo` only fills them when
       * `configured` is true, and they render as em dashes otherwise. */}
      {onchain?.agentConfigured && (
        <div className="border border-border rounded-lg p-6">
          <h3 className="font-bold text-lg mb-1 flex items-center gap-2">
            <Link2 className="size-5" /> {t('profile.onchain.title', { chain: onchain.chainName ?? 'Sepolia' })}
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            {t('profile.onchain.subtitle')}
          </p>

          {onchain.smartAccountAddress ? (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{t('profile.onchain.smartAccount')}</span>
                <a
                  href={`${onchain.explorer}/address/${onchain.smartAccountAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                >
                  {onchain.smartAccountAddress.slice(0, 12)}…{onchain.smartAccountAddress.slice(-8)}
                  <ExternalLink className="size-3" />
                </a>
                {!onchain.agentConfigured && (
                  <span className="text-xs text-warning">{t('profile.onchain.readOnly')}</span>
                )}
              </div>
              {onchain.erc8004Configured && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">{t('profile.onchain.identity')}</span>
                  {onchain.erc8004Id ? (
                    <span className="rounded-md bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
                      {t('profile.onchain.registered', { id: onchain.erc8004Id })}
                    </span>
                  ) : (
                    <>
                      <span className="rounded-md bg-warning/15 px-2 py-0.5 text-xs text-warning">
                        {t('profile.onchain.notRegistered')}
                      </span>
                      <button
                        onClick={handleProvision}
                        disabled={creditBusy}
                        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-secondary disabled:opacity-50"
                        title={t('profile.onchain.registerTooltip')}
                      >
                        {creditBusy ? t('profile.onchain.registering') : t('profile.onchain.register')}
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-muted-foreground">{t('profile.onchain.available')}</span>{' '}
                  <span className="font-mono font-semibold text-success">
                    {onchain.available === null ? '—' : `$${Math.round(onchain.available).toLocaleString()}`}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">{t('profile.onchain.outstanding')}</span>{' '}
                  <span className="font-mono font-semibold">
                    {onchain.outstanding === null ? '—' : `$${Math.round(onchain.outstanding).toLocaleString()}`}
                  </span>
                </div>
              </div>
              {onchainReady && (
                <p className="text-xs text-success">
                  {t('profile.onchain.userOpsNote')}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                {t('profile.onchain.noSmartAccount')}
              </p>
              <button
                onClick={handleProvision}
                disabled={creditBusy || !onchain.agentConfigured}
                className="inline-flex w-fit items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {creditBusy ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                {t('profile.onchain.provision')}
              </button>
              {!onchain.agentConfigured && (
                <p className="text-xs text-warning">
                  {t('profile.onchain.envHint')}
                </p>
              )}
            </div>
          )}

          {lastTxHash && (
            <a
              href={`${onchain.explorer}/tx/${lastTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {t('profile.onchain.latestTx', { tx: lastTxHash.slice(0, 14) })} <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}

      {/* Credit line — borrow and repay against the earned limit */}
      <div className="border border-border rounded-lg p-6">
        <h3 className="font-bold text-lg mb-1 flex items-center gap-2">
          <Banknote className="size-5" /> {t('profile.creditLine.title')}
          {onchainReady && <span className="text-xs font-normal text-success">{t('profile.creditLine.onchainBadge')}</span>}
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          {t('profile.creditLine.subtitle')}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4 text-sm">
          <div>
            <span className="text-muted-foreground">{t('profile.creditLine.available')}</span>{' '}
            <span className="font-mono font-semibold text-success">
              ${Math.round(credit.availableCredit).toLocaleString()}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('profile.creditLine.outstanding')}</span>{' '}
            <span className="font-mono font-semibold">${Math.round(outstanding).toLocaleString()}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t('profile.creditLine.limit')}</span>{' '}
            <span className="font-mono font-semibold">${credit.creditLimit.toLocaleString()}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min="0"
            value={drawAmount}
            onChange={(e) => setDrawAmount(e.target.value)}
            placeholder={t('profile.creditLine.amountPlaceholder')}
            className="h-9 w-40 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            disabled={creditBusy}
          />
          <button
            onClick={handleDraw}
            disabled={creditBusy || !drawAmount || parseFloat(drawAmount) <= 0}
            className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            {creditBusy ? <Loader2 className="size-4 animate-spin" /> : <HandCoins className="size-4" />}
            {t('profile.creditLine.draw')}
          </button>
        </div>

        {creditError && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {creditError}
          </div>
        )}

        {draws.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('profile.creditLine.activeDraws')}
            </p>
            {draws.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between rounded-md border border-border p-3 text-sm"
              >
                <div>
                  <span className="font-mono font-semibold">
                    ${Math.round(parseFloat(d.amount)).toLocaleString()}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {d.description} · {new Date(d.createdAt).toLocaleString()}
                  </span>
                </div>
                <button
                  onClick={() => handleRepay(d.id)}
                  disabled={creditBusy}
                  className="rounded bg-success/15 px-3 py-1 text-xs font-medium text-success hover:bg-success/25 disabled:opacity-50"
                >
                  {t('profile.creditLine.repay')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Treasury — the agent's wallet, styled as a physical card */}
      {treasury?.configured && (
        <div className="space-y-5">
          <div>
            <h3 className="font-bold text-lg flex items-center gap-2">
              <Wallet className="size-5" /> {t('profile.treasury.title')}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">{t('profile.treasury.subtitle')}</p>
          </div>

          {/* The card — a material object whose metal is set by credit tier */}
          <div
            className="relative mx-auto w-full max-w-md overflow-hidden rounded-[22px] p-6 text-white shadow-[0_18px_40px_-12px_rgba(15,40,90,0.5)]"
            style={{ background: cardTier(credit.rating).gradient }}
          >
            {/* diagonal gloss */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: 'linear-gradient(115deg, transparent 42%, rgba(255,255,255,0.10) 50%, transparent 58%)' }}
            />

            <div className="relative flex items-start justify-between">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/55">
                  Agent Treasury
                </p>
                <p className="mt-1 text-sm font-semibold">{identity.name}</p>
                <p
                  className="mt-1 text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: cardTier(credit.rating).badge }}
                >
                  {cardTier(credit.rating).label} · {credit.rating}-rated
                </p>
              </div>
              <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium backdrop-blur-sm">
                {onchain?.chainName ?? 'Sepolia'} · testnet
              </span>
            </div>

            {/* EMV-style chip */}
            <div
              className="relative mt-6 h-7 w-10 rounded-[6px]"
              style={{ background: 'linear-gradient(135deg, #f8e6a8, #d9b25a 55%, #b58a2c)' }}
            >
              <div className="absolute inset-x-1.5 top-1/2 h-px -translate-y-1/2 bg-black/25" />
              <div className="absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-black/25" />
            </div>

            {/* Balance — the hero */}
            <div className="relative mt-5">
              <p className="text-[11px] uppercase tracking-wider text-white/55">
                {t('profile.treasury.usdcBalance')}
              </p>
              <p className="mt-1 flex items-baseline gap-1.5 font-mono">
                <span className="text-[40px] font-bold leading-none tracking-tight tabular-nums">
                  {treasury.usdc === null
                    ? '—'
                    : treasury.usdc.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                </span>
                <span className="text-sm font-semibold text-white/65">USDC</span>
              </p>
            </div>

            {/* Address + brand */}
            <div className="relative mt-6 flex items-end justify-between">
              <button
                onClick={() => navigator.clipboard?.writeText(treasury.address ?? '')}
                className="group flex items-center gap-1.5 font-mono text-xs text-white/80 transition-colors hover:text-white"
                aria-label={t('profile.treasury.copyAddress')}
              >
                {treasury.address
                  ? `${treasury.address.slice(0, 6)} •••• ${treasury.address.slice(-4)}`
                  : '—'}
                <Copy className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
              </button>
              <span className="text-sm font-semibold tracking-tight text-white/90">Handsel</span>
            </div>
          </div>

          {/* Secondary stats — quiet, below the card */}
          <div className="mx-auto flex max-w-md flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t('profile.treasury.spent24h')}{' '}
              <span className="font-mono font-medium text-foreground">${treasury.spent24h.toFixed(2)}</span>
            </span>
            <span className="text-border">·</span>
            <span>
              {t('profile.treasury.caps')}{' '}
              <span className="font-mono font-medium text-foreground">
                ${treasury.maxPerTx}/tx · ${treasury.dailyCap}/day
              </span>
            </span>
          </div>

          {/* Actions — two clean panels */}
          <div className="mx-auto grid max-w-md gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border p-4">
              <p className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold">
                <Coins className="size-3.5 text-primary" />
                {t('profile.treasury.getTestUsdc', { chain: onchain?.chainName ?? 'Sepolia' })}
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="5000"
                  value={mintAmount}
                  onChange={(e) => setMintAmount(e.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm"
                  disabled={mintBusy}
                />
                <button
                  onClick={handleMint}
                  disabled={mintBusy || !mintAmount || parseFloat(mintAmount) <= 0}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                >
                  {mintBusy ? <Loader2 className="size-4 animate-spin" /> : <Coins className="size-4" />}
                  {t('profile.treasury.mint')}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-border p-4">
              <p className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold">
                <Send className="size-3.5 text-primary" />
                {t('profile.treasury.send')}
              </p>
              <div className="flex flex-col gap-2">
                <input
                  value={sendTo}
                  onChange={(e) => setSendTo(e.target.value)}
                  placeholder={t('profile.treasury.recipientPlaceholder')}
                  className="h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-sm"
                  disabled={treasuryBusy}
                />
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    value={sendAmount}
                    onChange={(e) => setSendAmount(e.target.value)}
                    placeholder="USDC"
                    className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm"
                    disabled={treasuryBusy}
                  />
                  <button
                    onClick={handleSend}
                    disabled={treasuryBusy || !sendTo.trim() || !sendAmount}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3.5 py-2 text-sm font-medium transition hover:bg-secondary disabled:opacity-50"
                  >
                    {treasuryBusy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                    {t('profile.treasury.send')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {treasuryMsg && (
            <p className="mx-auto max-w-md text-center text-sm text-muted-foreground">{treasuryMsg}</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Credit evolution */}
        <div className="border border-border rounded-lg p-6">
          <h3 className="font-bold text-lg mb-4">{t('profile.evolution.title')}</h3>
          {evolution.length > 1 ? (
            <CreditEvolutionChart data={evolution} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('profile.evolution.empty')}
            </p>
          )}
          <div className="mt-4 space-y-2 max-h-48 overflow-y-auto">
            {history.slice(0, 5).map((entry) => (
              <div key={entry.id} className="text-xs border-t border-border pt-2">
                <span className="font-mono font-semibold">{entry.score}</span>{' '}
                <span className="text-muted-foreground">
                  {entry.rating} · ${entry.creditLimit.toLocaleString()} ·{' '}
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
                <p className="text-muted-foreground mt-0.5">{entry.calculationReason}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Activity timeline */}
        <div className="border border-border rounded-lg p-6">
          <h3 className="font-bold text-lg mb-4">{t('profile.timeline.title')}</h3>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('profile.timeline.empty')}
            </p>
          ) : (
            <ul className="space-y-3 max-h-[420px] overflow-y-auto">
              {events.map((event) => {
                const meta = EVENT_META[event.eventType] ?? { label: event.eventType, Icon: Play }
                return (
                  <li key={event.id} className="flex items-start gap-3 text-sm">
                    <meta.Icon
                      className={`size-4 mt-0.5 shrink-0 ${
                        event.eventType === 'TASK_FAILED'
                          ? 'text-destructive'
                          : event.eventType === 'TASK_COMPLETED' || event.eventType === 'REPAYMENT_COMPLETED'
                            ? 'text-success'
                            : 'text-muted-foreground'
                      }`}
                    />
                    <div className="min-w-0">
                      <p className="font-medium">
                        {t(meta.label)}
                        {event.eventType === 'TOOL_EXECUTED' && event.detail?.tool ? (
                          <span className="font-mono text-xs text-muted-foreground"> · {String(event.detail.tool)}</span>
                        ) : null}
                        {event.qualityScore !== null && event.eventType !== 'REPAYMENT_COMPLETED' && (
                          <span className="font-mono text-xs text-muted-foreground">
                            {' '}· {t('profile.timeline.quality', { quality: (event.qualityScore * 100).toFixed(0) })}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {event.taskId} · {new Date(event.createdAt).toLocaleString()}
                        {event.tokenCost > 0 && ` · ${t('profile.timeline.tokens', { count: event.tokenCost.toLocaleString() })}`}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The agent's balance sheet — the same lens used to evaluate a company,
 * applied to an agent. Every figure is a real read (on-chain balance, vault
 * headroom, escrowed-but-unreleased bounties, cumulative draws) — nothing
 * here is inferred or estimated. Net Worth subtracts only Outstanding Debt
 * (what's currently owed); Borrowed Credit (lifetime total drawn) is shown
 * for context but isn't subtracted again, or repaid amounts would be
 * double-counted against the agent.
 */
function BalanceSheetCard({ sheet }: { sheet: BalanceSheet }) {
  const { t } = useI18n()
  const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`
  const assetsTotal = sheet.assets.usdc + sheet.assets.creditLine + sheet.assets.receivables

  if (!sheet.configured) {
    return (
      <div className="border border-border rounded-lg p-6">
        <h3 className="font-bold text-lg mb-1 flex items-center gap-2">
          <Scale className="size-5" /> {t('profile.balance.title')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('profile.balance.provisionHint')}
        </p>
      </div>
    )
  }

  return (
    <div className="border border-border rounded-lg p-6">
      <h3 className="font-bold text-lg mb-1 flex items-center gap-2">
        <Scale className="size-5" /> {t('profile.balance.title')}
      </h3>
      <p className="text-sm text-muted-foreground mb-4">
        {t('profile.balance.subtitle')}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t('profile.balance.assets')}</p>
          <dl className="space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">USDC</dt>
              <dd className="font-mono font-semibold">{fmt(sheet.assets.usdc)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t('profile.balance.creditLineUndrawn')}</dt>
              <dd className="font-mono font-semibold">{fmt(sheet.assets.creditLine)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t('profile.balance.receivables')}</dt>
              <dd className="font-mono font-semibold">{fmt(sheet.assets.receivables)}</dd>
            </div>
            <div className="flex items-center justify-between border-t border-border pt-1.5 mt-1.5">
              <dt className="font-medium">{t('profile.balance.totalAssets')}</dt>
              <dd className="font-mono font-bold">{fmt(assetsTotal)}</dd>
            </div>
          </dl>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t('profile.balance.liabilities')}</p>
          <dl className="space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t('profile.balance.outstandingDebt')}</dt>
              <dd className="font-mono font-semibold text-destructive">{fmt(sheet.liabilities.outstandingDebt)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t('profile.balance.borrowedLifetime')}</dt>
              <dd className="font-mono text-muted-foreground">{fmt(sheet.liabilities.borrowedLifetime)}</dd>
            </div>
            <div className="flex items-center justify-between border-t border-border pt-1.5 mt-1.5">
              <dt className="font-medium">{t('profile.balance.totalLiabilities')}</dt>
              <dd className="font-mono font-bold text-destructive">{fmt(sheet.liabilities.outstandingDebt)}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-border flex items-center justify-between">
        <span className="font-semibold">{t('profile.balance.netWorth')}</span>
        <span className={`font-mono text-xl font-bold ${sheet.netWorth >= 0 ? 'text-success' : 'text-destructive'}`}>
          {fmt(sheet.netWorth)}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground mt-1">
        {t('profile.balance.footnote')}
      </p>
    </div>
  )
}

/**
 * Bring-your-own-agent: run this agent on the owner's own HTTP endpoint
 * instead of the platform's Python runtime. No third-party code executes on
 * our servers — we only POST the task and wait for a callback in the same
 * format our own runtime uses. See the Guide for the exact contract.
 */

type RuntimeKind = 'platform' | 'webhook' | 'local' | 'cloud' | 'mcp'

function RuntimeCard({ agentId }: { agentId: string }) {
  const { t } = useI18n()
  const [runtimeType, setRuntimeType] = useState<RuntimeKind>('platform')
  const [webhookUrl, setWebhookUrlState] = useState('')
  const [hasSecret, setHasSecret] = useState(false)
  const [editing, setEditing] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [localCommand, setLocalCommand] = useState<string | null>(null)
  const [lastPollAt, setLastPollAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [cloudBaseUrl, setCloudBaseUrlState] = useState('')
  const [cloudModel, setCloudModelState] = useState('')
  const [showCloudForm, setShowCloudForm] = useState(false)
  const [cloudUrlInput, setCloudUrlInput] = useState('')
  const [cloudKeyInput, setCloudKeyInput] = useState('')
  const [cloudModelInput, setCloudModelInput] = useState('')

  const [mcpServerUrl, setMcpServerUrlState] = useState('')
  const [mcpToolName, setMcpToolNameState] = useState('')
  const [showMcpForm, setShowMcpForm] = useState(false)
  const [mcpUrlInput, setMcpUrlInput] = useState('')
  const [mcpToolInput, setMcpToolInput] = useState('')
  const [mcpAuthInput, setMcpAuthInput] = useState('')

  const load = useCallback(async () => {
    const cfg = await getWebhookConfig(agentId)
    setRuntimeType((cfg.runtimeType as RuntimeKind) ?? 'platform')
    setWebhookUrlState(cfg.webhookUrl ?? '')
    setUrlInput(cfg.webhookUrl ?? '')
    setHasSecret(cfg.hasSecret)
    setLastPollAt(cfg.lastPollAt)
    setCloudBaseUrlState(cfg.cloudBaseUrl ?? '')
    setCloudModelState(cfg.cloudModel ?? '')
    setMcpServerUrlState(cfg.mcpServerUrl ?? '')
    setMcpToolNameState(cfg.mcpToolName ?? '')
  }, [agentId])

  useEffect(() => {
    load()
    setRevealedSecret(null)
    setLocalCommand(null)
    setEditing(false)
    setShowCloudForm(false)
  }, [load])

  // Live online/offline badge for a connected local worker (it polls every
  // ~3s; consider it online if we heard from it in the last 30s).
  useEffect(() => {
    if (runtimeType !== 'local') return
    const t = setInterval(() => load().catch(() => {}), 5000)
    return () => clearInterval(t)
  }, [runtimeType, load])
  const workerOnline = lastPollAt !== null && Date.now() - new Date(lastPollAt).getTime() < 30_000

  const saveUrl = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await setWebhookUrl(agentId, urlInput)
      await load()
      setEditing(false)
      setMsg(t('profile.runtime.saved'))
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const switchToPlatform = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await switchToPlatformRuntime(agentId)
      await load()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const rotateSecret = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const { secret } = await generateAgentWebhookSecret(agentId)
      setRevealedSecret(secret)
      setHasSecret(true)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const connectLocal = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const { command } = await connectLocalWorker(agentId)
      setLocalCommand(command)
      await load()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const connectCloud = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await setCloudApiWorker(agentId, {
        baseUrl: cloudUrlInput,
        apiKey: cloudKeyInput,
        model: cloudModelInput,
      })
      setCloudKeyInput('')
      setShowCloudForm(false)
      await load()
      setMsg(t('profile.runtime.saved'))
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const disconnectCloud = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await disconnectCloudApiWorker(agentId)
      await load()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const connectMcp = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await setMcpWorker(agentId, {
        serverUrl: mcpUrlInput,
        toolName: mcpToolInput,
        authHeader: mcpAuthInput || undefined,
      })
      setMcpAuthInput('')
      setShowMcpForm(false)
      await load()
      setMsg(t('profile.runtime.saved'))
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const disconnectMcp = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await disconnectMcpWorker(agentId)
      await load()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-border rounded-lg p-6">
      <h3 className="font-bold text-lg mb-1 flex items-center gap-2">
        <Webhook className="size-5" /> {t('profile.runtime.title')}
      </h3>
      <p className="text-sm text-muted-foreground mb-4">
        {t('profile.runtime.subtitle')}
      </p>

      <div className="flex items-center gap-2 mb-3 text-sm">
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${runtimeType !== 'platform' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>
          {runtimeType === 'webhook'
            ? t('profile.runtime.byoWebhook')
            : runtimeType === 'local'
              ? t('profile.runtime.localWorker')
              : runtimeType === 'cloud'
                ? t('profile.runtime.cloudApi')
                : runtimeType === 'mcp'
                  ? 'External MCP agent'
                  : t('profile.runtime.platform')}
        </span>
        {runtimeType === 'mcp' && mcpServerUrl && (
          <code className="text-xs text-muted-foreground truncate max-w-xs">{mcpToolName} · {mcpServerUrl}</code>
        )}
        {runtimeType === 'webhook' && webhookUrl && (
          <code className="text-xs text-muted-foreground truncate max-w-xs">{webhookUrl}</code>
        )}
        {runtimeType === 'local' && (
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${workerOnline ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
            <span className={`size-1.5 rounded-full ${workerOnline ? 'bg-success' : 'bg-warning'}`} />
            {workerOnline ? t('profile.runtime.workerOnline') : t('profile.runtime.workerOffline')}
          </span>
        )}
        {runtimeType === 'cloud' && cloudBaseUrl && (
          <code className="text-xs text-muted-foreground truncate max-w-xs">{cloudModel} · {cloudBaseUrl}</code>
        )}
      </div>

      {/* Runtime switcher — every option is reachable from every state, so you
          can't get stuck. Before, a 'local' agent only offered "regenerate" and
          "switch back to platform"; there was no direct path to a cloud key, so
          disconnecting a local worker stranded you off the cloud runtime. Now all
          three targets are always one click away, with the active one highlighted. */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={connectLocal}
          disabled={busy}
          title={t('profile.runtime.localModelsHint')}
          className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
            runtimeType === 'local' ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border hover:bg-secondary'
          }`}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
          {runtimeType === 'local' ? t('profile.runtime.regenerateCommand') : t('profile.runtime.connectLocal')}
        </button>
        <button
          onClick={() => {
            setCloudUrlInput(cloudBaseUrl || '')
            setCloudModelInput(cloudModel || '')
            setEditing(false)
            setShowCloudForm(true)
          }}
          disabled={busy}
          title={t('profile.runtime.cloudApiHint')}
          className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
            runtimeType === 'cloud' ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border hover:bg-secondary'
          }`}
        >
          <Cloud className="size-4" />
          {runtimeType === 'cloud' ? t('profile.runtime.changeCloud') : t('profile.runtime.connectCloud')}
        </button>
        <button
          onClick={() => {
            setUrlInput(webhookUrl || '')
            setShowCloudForm(false)
            setEditing(true)
          }}
          disabled={busy}
          className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
            runtimeType === 'webhook' ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border hover:bg-secondary'
          }`}
        >
          <Webhook className="size-4" />
          {runtimeType === 'webhook' ? t('profile.runtime.editUrl') : t('profile.runtime.byoWebhook')}
        </button>
        <button
          onClick={() => {
            setMcpUrlInput(mcpServerUrl || '')
            setMcpToolInput(mcpToolName || '')
            setShowCloudForm(false)
            setEditing(false)
            setShowMcpForm(true)
          }}
          disabled={busy}
          title="Use any external MCP server's tool as this worker"
          className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
            runtimeType === 'mcp' ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border hover:bg-secondary'
          }`}
        >
          <Bot className="size-4" />
          {runtimeType === 'mcp' ? 'Change MCP agent' : 'Connect an MCP agent'}
        </button>
        {runtimeType !== 'platform' && (
          <button
            onClick={() => {
              setShowCloudForm(false)
              setShowMcpForm(false)
              setEditing(false)
              if (runtimeType === 'cloud') disconnectCloud()
              else if (runtimeType === 'mcp') disconnectMcp()
              else switchToPlatform()
            }}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            {t('profile.runtime.switchBack')}
          </button>
        )}
      </div>

      {showMcpForm && (
        <div className="mt-3 space-y-2 rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">
            Point this worker at any external MCP server (Streamable HTTP). When it&apos;s dispatched a
            job, we call the named tool with the task and submit its output for independent grading —
            so any MCP-speaking agent (OpenClaw, another platform, your own) can earn here.
          </p>
          <input
            value={mcpUrlInput}
            onChange={(e) => setMcpUrlInput(e.target.value)}
            placeholder="https://example.com/mcp"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          />
          <input
            value={mcpToolInput}
            onChange={(e) => setMcpToolInput(e.target.value)}
            placeholder="tool name (e.g. do_task)"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          />
          <input
            type="password"
            value={mcpAuthInput}
            onChange={(e) => setMcpAuthInput(e.target.value)}
            placeholder="Authorization header — optional (e.g. Bearer xyz)"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={connectMcp}
              disabled={busy || !mcpUrlInput.trim() || !mcpToolInput.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
              {t('profile.runtime.connect')}
            </button>
            <button
              onClick={() => setShowMcpForm(false)}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
            >
              {t('profile.runtime.cancel')}
            </button>
          </div>
        </div>
      )}

      {showCloudForm && (
        <div className="mt-3 space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap gap-1.5">
            {CLOUD_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setCloudUrlInput(p.baseUrl)
                  setCloudModelInput(p.model)
                }}
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary"
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            value={cloudUrlInput}
            onChange={(e) => setCloudUrlInput(e.target.value)}
            placeholder="https://api.groq.com/openai/v1"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          />
          <input
            value={cloudModelInput}
            onChange={(e) => setCloudModelInput(e.target.value)}
            placeholder={t('profile.runtime.cloudModelPlaceholder')}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          />
          <input
            type="password"
            value={cloudKeyInput}
            onChange={(e) => setCloudKeyInput(e.target.value)}
            placeholder={t('profile.runtime.cloudApiKeyPlaceholder')}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={connectCloud}
              disabled={busy || !cloudUrlInput.trim() || !cloudModelInput.trim() || !cloudKeyInput.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Cloud className="size-4" />}
              {t('profile.runtime.connect')}
            </button>
            <button
              onClick={() => setShowCloudForm(false)}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
            >
              {t('profile.runtime.cancel')}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{t('profile.runtime.cloudApiKeyNote')}</p>
        </div>
      )}

      {editing && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://your-server.example.com/agent"
            className="h-9 w-80 rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          />
          <button
            onClick={saveUrl}
            disabled={busy || !urlInput.trim()}
            className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Webhook className="size-4" />}
            {t('profile.runtime.useWebhook')}
          </button>
          <button onClick={() => setEditing(false)} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary">
            {t('profile.runtime.cancel')}
          </button>
        </div>
      )}

      {localCommand && (
        <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
          <p className="font-medium mb-1">
            Shown once — run this on the machine hosting your local model (Node 18+; default expects
            Ollama at localhost:11434, add <code>--openai http://localhost:1234/v1 --model &lt;m&gt;</code> for
            LM Studio etc). The token is a credential; don&apos;t share it.
          </p>
          <code className="block break-all font-mono select-all">{localCommand}</code>
        </div>
      )}

      {/* Per-agent keys are universal (lib/agent-keys.ts) — every runtime
          type authenticates worker calls with this key, so every agent must
          be able to see its status and rotate it. This block was webhook-only
          for a while and a real operator couldn't find the button. */}
      {(
        <div className="mt-4 pt-4 border-t border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm">{t('profile.runtime.callbackSecret')}</span>
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${hasSecret ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
              {hasSecret ? t('profile.runtime.secretConfigured') : t('profile.runtime.secretNotSet')}
            </span>
            <button
              onClick={rotateSecret}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-secondary disabled:opacity-50"
            >
              <RefreshCw className="size-3.5" /> {hasSecret ? t('profile.runtime.rotate') : t('profile.runtime.generate')}
            </button>
          </div>
          {revealedSecret && (
            <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
              <p className="font-medium mb-1">
                Shown once — copy it now. This 64-character hex string is this agent&apos;s worker
                key: Foreman and CI workers set it as <code>HANDSEL_WORKER_SECRET</code>;
                webhook servers send it as the <code>X-Runtime-Secret</code> header.
              </p>
              <code className="block break-all font-mono">{revealedSecret}</code>
            </div>
          )}
        </div>
      )}

      {msg && <p className="mt-3 text-sm text-muted-foreground">{msg}</p>}
    </div>
  )
}
