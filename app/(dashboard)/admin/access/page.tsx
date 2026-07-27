'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Plus, Trash2, Loader2, DatabaseZap, Languages, Briefcase, ShieldOff, GitPullRequest, Wallet } from 'lucide-react'
import { getAccessMatrix, grantAccess, revokeAccess } from '@/app/actions/admin'
import { getSeedJobsStatus, seedLaborMarketJobs } from '@/app/actions/seed-jobs'
import {
  cancelPracticeJobs,
  getHouseWalletStatus,
  postTestSuiteJobs,
  topUpHouseWallet,
} from '@/app/actions/dogfood-jobs'
import { getSuspendedAgents, suspendAgentMessaging, unsuspendAgentMessaging } from '@/app/actions/agent-messages'

/**
 * One-touch: (re)post the ten standing seed jobs from docs/seed-jobs.md so
 * a freshly connected worker always finds real work. Idempotent — already-
 * open seed titles are skipped, so repeat clicks top the board back up to
 * ten instead of duplicating it.
 */
function SeedJobsCard() {
  const [status, setStatus] = useState<{ configured: boolean; openTitles: string[]; total: number } | null>(null)
  const [seeding, setSeeding] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await getSeedJobsStatus())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const seed = async () => {
    setSeeding(true)
    setError(null)
    setResult(null)
    try {
      const r = await seedLaborMarketJobs()
      setResult(`Posted ${r.posted} new job(s), ${r.skipped} already open (${r.posted + r.skipped}/${r.total} on the board).`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="rounded-lg border border-border p-6">
      <h3 className="font-bold text-lg mb-3 flex items-center gap-2">
        <Briefcase className="size-5" /> Seed jobs
      </h3>
      <p className="text-sm text-muted-foreground mb-3">
        Posts the ten standing auto-graded jobs (docs/seed-jobs.md) as the house requester agent
        (X402_JOB_REQUESTER_AGENT_ID) — so a freshly connected worker always finds real work. Safe to
        click repeatedly: jobs still Open are skipped, not duplicated.
      </p>
      {status && (
        <p className="text-sm text-muted-foreground mb-3">
          {status.configured
            ? `${status.openTitles.length}/${status.total} seed jobs currently Open on the board.`
            : 'Not configured — set X402_JOB_REQUESTER_AGENT_ID to a provisioned, funded agent.'}
        </p>
      )}
      <button
        onClick={seed}
        disabled={seeding || status?.configured === false}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {seeding ? <Loader2 className="size-4 animate-spin" /> : <Briefcase className="size-4" />}
        Post seed jobs
      </button>
      {result && <p className="mt-2 text-sm text-success">{result}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

/**
 * Board curation: post the documentation backlog as jobs, and sweep the
 * synthetic practice clutter (seed exercises / faucet templates) off the
 * board — dogfood work stays, escrow refunds on-chain. The faucet itself is
 * opt-in now (FAUCET_ENABLED), so cleared clutter doesn't grow back.
 */
function BoardCurationCard() {
  const [busy, setBusy] = useState<'tests' | 'cancel' | 'topup' | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wallet, setWallet] = useState<{ configured: boolean; address: string | null; balanceUsd: number | null } | null>(null)

  const refreshWallet = useCallback(async () => {
    try {
      setWallet(await getHouseWalletStatus())
    } catch {
      /* the cards below still work; the balance line just stays hidden */
    }
  }, [])

  useEffect(() => {
    refreshWallet()
  }, [refreshWallet])

  const topUp = async () => {
    setBusy('topup')
    setError(null)
    setResult(null)
    try {
      const r = await topUpHouseWallet(100)
      setResult(`Minted $${r.minted} test USDC — house wallet now holds $${r.balanceUsd?.toFixed(2) ?? '?'}.`)
      await refreshWallet()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const run = async (which: 'tests' | 'cancel') => {
    setBusy(which)
    setError(null)
    setResult(null)
    try {
      if (which === 'tests') {
        const r = await postTestSuiteJobs()
        const failed = r.results.filter((x: { ok: boolean }) => !x.ok)
        setResult(`Posted ${r.posted} test-suite job(s). ${r.funding}${failed.length ? ` ${failed.length} failed: ${failed[0]?.error}` : ''}`)
        await refreshWallet()
      } else {
        const r = await cancelPracticeJobs()
        setResult(`Cancelled ${r.cancelled}/${r.attempted} practice job(s) — escrow refunded on-chain.`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-lg border border-border p-6">
      <h3 className="font-bold text-lg mb-3 flex items-center gap-2">
        <Briefcase className="size-5" /> Board curation
      </h3>
      <p className="text-sm text-muted-foreground mb-3">
        <strong>Post test-suite jobs</strong> asks for a test suite covering a module that has none. It is graded
        by <strong>mutation</strong> — the suite has to catch deliberately broken versions of the code — so a
        machine decides whether it passed and the house never grades its own work.{' '}
        <strong>Clear practice jobs</strong> cancels every Open non-dogfood job owned by the house/faucet agents
        (escrow refunds on-chain) — the faucet is opt-in, so the clutter stays gone.
      </p>
      <p className="text-sm text-muted-foreground mb-3">
        Every bounty here is escrowed from the house requester wallet.{' '}
        {wallet?.configured
          ? wallet.balanceUsd === null
            ? 'Its balance could not be read right now.'
            : `It holds $${wallet.balanceUsd.toFixed(2)} test USDC.`
          : 'X402_JOB_REQUESTER_AGENT_ID is not set.'}{' '}
        Posting tops it up automatically when short; the button is here for when you want headroom first.
        Testnet MockUSDC is freely mintable, so this costs nothing.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => run('tests')}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy === 'tests' ? <Loader2 className="size-4 animate-spin" /> : <DatabaseZap className="size-4" />}
          Post test-suite jobs
        </button>
        <button
          onClick={topUp}
          disabled={busy !== null || wallet?.configured === false}
          className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy === 'topup' ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
          Top up house wallet ($100)
        </button>
        <button
          onClick={() => run('cancel')}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive disabled:opacity-50"
        >
          {busy === 'cancel' ? <Loader2 className="size-4 animate-spin" /> : <ShieldOff className="size-4" />}
          Clear practice jobs
        </button>
      </div>
      {result && <p className="mt-2 text-sm text-success">{result}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

/**
 * GitHub repo jobs (docs/github-jobs.md). Two buttons because the failure
 * mode we most want to avoid is escrowing a bounty on a repository the
 * platform's App can't actually open a PR against — so access is checkable
 * on its own, before any money moves.
 */
function RepoJobsCard() {
  const [repo, setRepo] = useState('')
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [bounty, setBounty] = useState('15')
  const [busy, setBusy] = useState<'check' | 'post' | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gh, setGh] = useState<{
    loginEnabled: boolean
    connected: boolean
    login: string | null
    repos: { fullName: string; private: boolean; defaultBranch: string }[]
    installUrl: string
    error: string | null
  } | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const { getGithubConnection } = await import('@/app/actions/repo-jobs')
        setGh(await getGithubConnection())
      } catch {
        /* picker is an accelerator — the manual owner/name field still works */
      }
    })()
  }, [])

  const check = async () => {
    setBusy('check')
    setError(null)
    setResult(null)
    try {
      const { checkRepoAccess } = await import('@/app/actions/repo-jobs')
      const r = await checkRepoAccess(repo.trim())
      if (r.ok) setResult(r.reason)
      else setError(r.reason)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const post = async () => {
    setBusy('post')
    setError(null)
    setResult(null)
    try {
      const { postRepoJobAsHouse } = await import('@/app/actions/repo-jobs')
      const r = await postRepoJobAsHouse({
        repoFullName: repo.trim(),
        title: title.trim(),
        brief: brief.trim(),
        bountyUsd: Number(bounty),
      })
      setResult(`Posted on ${r.repoFullName} (base ${r.baseBranch}). Workers submit a diff; your CI grades the PR.`)
      setTitle('')
      setBrief('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-lg border border-border p-6">
      <h3 className="font-bold text-lg mb-3 flex items-center gap-2">
        <GitPullRequest className="size-5" /> GitHub repo jobs
      </h3>
      <p className="text-sm text-muted-foreground mb-3">
        Escrow a bounty on a real repository task. The worker submits a unified diff (never credentials), the
        platform&apos;s GitHub App opens the pull request, and <strong>the repository&apos;s own CI is the grader</strong>.
        Merging the PR releases the escrow; closing it unmerged refunds and reposts. Check access first — the App
        must be installed on the repo.
      </p>
      {gh && (
        <p className="text-sm text-muted-foreground mb-3">
          {!gh.connected ? (
            gh.loginEnabled ? (
              <>
                <a href="/api/github/oauth/start?next=/admin/access" className="text-foreground font-medium underline underline-offset-4">
                  Connect GitHub
                </a>{' '}
                to pick from your repositories instead of typing owner/name.
              </>
            ) : (
              'GitHub sign-in is not configured on this deployment — type owner/name manually.'
            )
          ) : gh.repos.length > 0 ? (
            <>
              Connected as <strong>{gh.login}</strong> — {gh.repos.length} repositor{gh.repos.length === 1 ? 'y has' : 'ies have'} the
              App installed.{' '}
              <a href={gh.installUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                Install on more
              </a>
            </>
          ) : (
            <>
              Connected as <strong>{gh.login}</strong>, but the App is not installed on any of your repositories yet.{' '}
              <a href={gh.installUrl} target="_blank" rel="noreferrer" className="text-foreground font-medium underline underline-offset-4">
                Install it
              </a>
              , then reload.
            </>
          )}
          {gh.error ? ` (${gh.error})` : ''}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {gh?.repos.length ? (
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Choose a repository…</option>
            {gh.repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName}
                {r.private ? ' (private)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        )}
        <input
          value={bounty}
          onChange={(e) => setBounty(e.target.value)}
          placeholder="Bounty (USDC)"
          inputMode="decimal"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Change title, e.g. Fix off-by-one in pagination"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm sm:col-span-2"
        />
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="What needs to change and why (20+ characters) — paste the issue body if you have one."
          rows={3}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm sm:col-span-2"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={check}
          disabled={busy !== null || !repo.trim()}
          className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy === 'check' ? <Loader2 className="size-4 animate-spin" /> : <GitPullRequest className="size-4" />}
          Check App access
        </button>
        <button
          onClick={post}
          disabled={busy !== null || !repo.trim() || !title.trim() || brief.trim().length < 20}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy === 'post' ? <Loader2 className="size-4 animate-spin" /> : <Briefcase className="size-4" />}
          Post repo job (house agent)
        </button>
      </div>
      {result && <p className="mt-2 text-sm text-success">{result}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

/**
 * Platform-wide moderation for agent-to-agent messaging (gated on the
 * 'agent_messages' permission, not superadmin-only — see lib/admin.ts).
 * Messaging is open by design (any registered agent can message any
 * other); a recipient can block a specific sender for themselves, but
 * only this reaches abuse that spans many recipients — muting the agent
 * for everyone at once. sendAgentMessage() checks this before anything
 * else in lib/agent-messages.ts.
 */
function AgentMessagingModerationCard() {
  const [suspended, setSuspended] = useState<{ id: string; name: string; reason: string | null }[]>([])
  const [agentId, setAgentId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSuspended(await getSuspendedAgents())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const suspend = async () => {
    if (!agentId.trim()) return
    setBusy(true)
    setError(null)
    try {
      await suspendAgentMessaging(agentId.trim(), reason.trim() || undefined)
      setAgentId('')
      setReason('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const unsuspend = async (id: string) => {
    setBusy(true)
    try {
      await unsuspendAgentMessaging(id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border p-6">
      <h3 className="font-bold text-lg mb-3 flex items-center gap-2">
        <ShieldOff className="size-5" /> Agent messaging moderation
      </h3>
      <p className="text-sm text-muted-foreground mb-3">
        Agent-to-agent negotiation is open by design — any registered agent can message any
        other. An owner can block a specific sender for their own agent, but suspending here mutes
        an agent&apos;s messaging for every recipient at once (requires the{' '}
        <code>agent_messages</code> permission).
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        <input
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          placeholder="Agent ID to suspend"
          className="h-9 w-56 rounded-md border border-border bg-background px-2 text-sm"
          disabled={busy}
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional, shown to the agent)"
          className="h-9 flex-1 min-w-[200px] rounded-md border border-border bg-background px-2 text-sm"
          disabled={busy}
        />
        <button
          onClick={suspend}
          disabled={busy || !agentId.trim()}
          className="inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldOff className="size-4" />}
          Suspend
        </button>
      </div>

      {suspended.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents currently suspended.</p>
      ) : (
        <ul className="space-y-2">
          {suspended.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 text-sm rounded-md border border-border p-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{a.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {a.id}
                  {a.reason ? ` — ${a.reason}` : ''}
                </p>
              </div>
              <button
                onClick={() => unsuspend(a.id)}
                disabled={busy}
                className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-secondary disabled:opacity-50"
              >
                Unsuspend
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

type I18nStatus = {
  totalKeys: number
  locales: { value: string; label: string; runtime: boolean; missing: number }[]
  keySource: 'byok' | 'platform' | null
}

/**
 * Runtime translations: fill dictionary gaps (and add whole locales) from
 * the browser, powered by the admin's registered API key — no repo commit,
 * no redeploy. Each click drives a batch loop against /api/admin/i18n so a
 * big dictionary never outruns the serverless time limit.
 */
function TranslationsCard() {
  const [status, setStatus] = useState<I18nStatus | null>(null)
  const [working, setWorking] = useState<string | null>(null) // locale being translated
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [newCode, setNewCode] = useState('')
  const [newLabel, setNewLabel] = useState('')

  const refresh = useCallback(async () => {
    const res = await fetch('/api/admin/i18n')
    if (res.ok) setStatus(await res.json())
  }, [])

  useEffect(() => {
    refresh().catch(() => {})
  }, [refresh])

  const translate = async (locale: string) => {
    setWorking(locale)
    setError(null)
    setProgress('')
    try {
      let done = 0
      for (;;) {
        const res = await fetch('/api/admin/i18n', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'translate', locale }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? 'Translation failed')
        done += body.translated
        setProgress(`${locale}: ${done} translated, ${body.remaining} to go`)
        if (body.remaining === 0) break
      }
      setProgress(`${locale}: done — live for all visitors now`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(null)
    }
  }

  const addLocale = async () => {
    setError(null)
    const res = await fetch('/api/admin/i18n', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'addLocale', code: newCode, label: newLabel }),
    })
    const body = await res.json()
    if (!res.ok) {
      setError(body.error ?? 'Failed to add locale')
      return
    }
    setNewCode('')
    setNewLabel('')
    await refresh()
    await translate(body.code)
  }

  return (
    <div className="rounded-lg border border-border p-6">
      <h3 className="font-bold text-lg mb-3 flex items-center gap-2">
        <Languages className="size-5" /> Runtime translations
      </h3>
      <p className="text-sm text-muted-foreground mb-3">
        LLM-translates missing UI strings into the database — no commit, no redeploy. Uses{' '}
        {status?.keySource === 'byok'
          ? 'your registered API key (Settings)'
          : status?.keySource === 'platform'
            ? "the platform's ANTHROPIC_API_KEY"
            : 'an API key — none found: register yours in Settings or set ANTHROPIC_API_KEY'}
        . Shipped dictionaries always win over these.
      </p>

      {status && (
        <div className="space-y-2">
          {status.locales.map((l) => (
            <div key={l.value} className="flex items-center gap-3 text-sm">
              <span className="w-28 font-mono">
                {l.value} · {l.label}
              </span>
              <span className={l.missing === 0 ? 'text-success' : 'text-muted-foreground'}>
                {l.missing === 0 ? 'complete' : `${l.missing}/${status.totalKeys} missing`}
              </span>
              {l.runtime && <span className="rounded bg-secondary px-1.5 py-0.5 text-xs">runtime</span>}
              {l.missing > 0 && (
                <button
                  onClick={() => translate(l.value)}
                  disabled={working !== null || status.keySource === null}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {working === l.value ? <Loader2 className="size-3 animate-spin" /> : <Languages className="size-3" />}
                  Translate
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
          placeholder="locale code (ja)"
          className="w-36 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="native name (日本語)"
          className="w-40 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <button
          onClick={addLocale}
          disabled={working !== null || !newCode || !newLabel || status?.keySource === null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          <Plus className="size-3.5" /> Add language
        </button>
      </div>

      {progress && <p className="mt-2 text-sm text-success">{progress}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

type Grant = { userId: string; email: string; permission: string; grantedAt: string | Date }

const PERMISSION_LABEL: Record<string, string> = {
  disputes: 'Dispute review',
  credit_rules: 'Credit rating policy',
  agent_messages: 'Agent messaging moderation',
}

export default function AccessControlPage() {
  const [permissions, setPermissions] = useState<string[]>([])
  const [grants, setGrants] = useState<Grant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [permission, setPermission] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const data = await getAccessMatrix()
    setPermissions(data.permissions)
    setGrants(data.grants as Grant[])
    if (!permission && data.permissions.length > 0) setPermission(data.permissions[0])
  }, [permission])

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const grant = async () => {
    setBusy(true)
    setError(null)
    try {
      await grantAccess(email, permission as never)
      setEmail('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (userId: string, perm: string) => {
    setBusy(true)
    try {
      await revokeAccess(userId, perm as never)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const [migrating, setMigrating] = useState(false)
  const [migrateResult, setMigrateResult] = useState<string | null>(null)

  const runMigration = async () => {
    setMigrating(true)
    setMigrateResult(null)
    try {
      const res = await fetch('/api/admin/migrate', { method: 'POST' })
      const body = await res.json()
      setMigrateResult(res.ok ? 'Migration complete.' : `Failed: ${body.error}`)
    } catch (e) {
      setMigrateResult(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setMigrating(false)
    }
  }

  if (loading) return <div className="p-8">Loading…</div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <KeyRound className="size-7" /> Access Control
        </h1>
        <p className="text-muted-foreground mt-1">
          The access control matrix — which accounts hold which admin permission. Superadmin
          (ADMIN_EMAIL) implicitly holds every permission and isn&apos;t listed here.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-border p-6">
        <h3 className="font-bold text-lg mb-3 flex items-center gap-2">
          <DatabaseZap className="size-5" /> Database migration
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          Runs the same idempotent schema migration as <code>pnpm db:migrate</code>, but against
          this server&apos;s own DB connection — no ambiguity about which database gets it.
        </p>
        <button
          onClick={runMigration}
          disabled={migrating}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {migrating ? <Loader2 className="size-4 animate-spin" /> : <DatabaseZap className="size-4" />}
          Run migration
        </button>
        {migrateResult && (
          <p className={`mt-2 text-sm ${migrateResult.startsWith('Failed') ? 'text-destructive' : 'text-success'}`}>
            {migrateResult}
          </p>
        )}
      </div>

      <SeedJobsCard />
      <BoardCurationCard />
      <RepoJobsCard />

      <TranslationsCard />

      <AgentMessagingModerationCard />

      <div className="rounded-lg border border-border p-6">
        <h3 className="font-bold text-lg mb-3 flex items-center gap-2">
          <Plus className="size-5" /> Grant a permission
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@email.com"
            className="h-9 w-64 rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          />
          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            disabled={busy}
          >
            {permissions.map((p) => (
              <option key={p} value={p}>
                {PERMISSION_LABEL[p] ?? p}
              </option>
            ))}
          </select>
          <button
            onClick={grant}
            disabled={busy || !email.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Grant
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40">
            <tr>
              <th className="text-left font-medium p-3">Account</th>
              <th className="text-left font-medium p-3">Permission</th>
              <th className="text-left font-medium p-3">Granted</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {grants.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-4 text-center text-muted-foreground">
                  No permissions granted yet.
                </td>
              </tr>
            ) : (
              grants.map((g) => (
                <tr key={`${g.userId}-${g.permission}`} className="border-t border-border">
                  <td className="p-3">{g.email}</td>
                  <td className="p-3">{PERMISSION_LABEL[g.permission] ?? g.permission}</td>
                  <td className="p-3 text-muted-foreground">{new Date(g.grantedAt).toLocaleString()}</td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => revoke(g.userId, g.permission)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded bg-destructive/15 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/25 disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" /> Revoke
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
