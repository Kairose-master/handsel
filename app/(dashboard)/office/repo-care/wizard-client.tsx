'use client'

/**
 * /office/repo-care — the guided path from `/repo-care`'s free diagnostic to
 * a running, paid pilot: connect a worker, pick a posture, review tonight's
 * real plan, then pay. No JSON editor, no wallet, no risk-tier vocabulary —
 * those stay on `/office/sessions`, the power-user control room this wizard
 * is a front door onto.
 *
 * Screen 5 is the one place that ever mentions money on this path. Starting
 * the session itself costs nothing on-platform — a Repo Care task always
 * settles `internal` at $0 (`lib/repo-care.ts`), because the work runs on
 * the customer's own worker with the customer's own Claude Code. The $500
 * is a service fee collected off-platform by Lemon Squeezy, not something
 * this session's own economics depend on.
 *
 * Korean, matching `/repo-care` — see that page's header comment.
 */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowRight, Check, Loader2, ShieldCheck } from 'lucide-react'
import {
  connectWorkspaceWorker,
  myLocalAgents,
  officeSessionOverview,
  setOfficePolicyPreset,
  startRepoCare,
  type SessionOverview,
} from '@/app/actions/office-session'
import { diagnoseRepoPublic } from '@/app/actions/repo-diagnose'
import type { Diagnostic } from '@/lib/repo-care'
import type { PolicyPreset } from '@/lib/approval-policy'
import { PILOT_OFFER } from '@/lib/billing'

type Posture = { do: string; ask: string; never: string }
/**
 * A Korean paraphrase of the same three `PRESET_POLICIES`
 * (`lib/approval-policy.ts`) — not a translation of `policyInWords`, which
 * stays the canonical English wording other surfaces (`/office/sessions`)
 * use. The hard rules ("어떤 경우에도 하지 않는 일") are identical across all
 * three postures on purpose: no preset can touch them.
 */
const NEVER = '워크스페이스 밖에 쓰기 · 테스트나 CI 실패 · 예산 초과 · secret·환경파일 수정 · production 배포 또는 변경'
const POSTURE_KO: Record<PolicyPreset, Posture> = {
  careful: {
    do: '테스트를 통과하고, 리뷰어가 승인했고, 5개 이하 파일만 바꾼 작은 변경',
    ask: '돈이 드는 작업, 위험도가 높은 작업, production에 영향을 주는 작업, 새 의존성을 추가하는 작업, 아직 아무도 검토하지 않은 결과',
    never: NEVER,
  },
  standard: {
    do: '테스트를 통과하고 리뷰어가 승인한 변경 — 최대 10개 파일, $2 이하',
    ask: '$2를 넘는 작업, production에 영향을 주는 작업, 새 의존성, 리뷰어와 의견이 갈리는 작업',
    never: NEVER,
  },
  hands_off: {
    do: '테스트가 실패하지 않았고 production에 영향이 없는 변경 — 최대 30개 파일까지, 리뷰 없이도',
    ask: '$5를 넘는 작업, production에 영향을 주는 작업, 리뷰어와 의견이 갈리는 작업',
    never: NEVER,
  },
}
const POSTURE_LABEL: Record<PolicyPreset, string> = {
  careful: 'Careful — 모든 결과를 승인받음',
  standard: 'Standard — 안전한 작업은 자동 진행',
  hands_off: 'Hands-off — 정해진 범위 안에서 자동 진행',
}

export function RepoCareWizardClient({ checkoutUrl }: { checkoutUrl: string | null }) {
  const params = useSearchParams()
  const [repo, setRepo] = useState(params.get('repo') ?? '')
  const [view, setView] = useState<SessionOverview | null>(null)
  const [agents, setAgents] = useState<Array<{ id: string; name: string; runtimeType: string | null }>>([])
  const [error, setError] = useState<string | null>(null)

  const reload = async () => {
    try {
      const [v, a] = await Promise.all([officeSessionOverview(1), myLocalAgents()])
      setView(v)
      setAgents(a)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => {
    void reload()
  }, [])

  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>
  if (!view) return <p className="p-6 text-sm text-muted-foreground">불러오는 중…</p>

  const worker = view.workers.find((w) => w.alive) ?? view.workers[0] ?? null
  const step = !worker ? 1 : !view.policyWords.preset ? 2 : 3

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Repo Care 시작하기</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          워커를 연결하고, 운영 자세를 정하고, 오늘 밤의 계획을 확인한 뒤 시작하세요.
        </p>
      </div>

      <ol className="flex gap-2 text-xs text-muted-foreground">
        {['워커 연결', '운영 자세', '최종 확인'].map((label, i) => (
          <li key={label} className={`flex items-center gap-1 rounded-full px-2.5 py-1 ${step === i + 1 ? 'bg-primary/10 font-medium text-primary' : step > i + 1 ? 'text-success' : ''}`}>
            {step > i + 1 && <Check className="size-3" />} {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 1 && <ConnectStep agents={agents} slot={view.slot} reload={reload} />}
      {step === 2 && <PostureStep slot={view.slot} reload={reload} />}
      {step === 3 && worker && (
        <FinalStep view={view} worker={worker} repo={repo} setRepo={setRepo} preset={view.policyWords.preset!} checkoutUrl={checkoutUrl} />
      )}
    </div>
  )
}

/* ── ③ 로컬 워커 연결 ─────────────────────────────────────────────────── */

function ConnectStep({ agents, slot, reload }: { agents: Array<{ id: string; name: string; runtimeType: string | null }>; slot: number; reload: () => Promise<void> }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [workdir, setWorkdir] = useState('')
  const [busy, setBusy] = useState(false)
  const [command, setCommand] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await connectWorkspaceWorker({
        agentId,
        slot,
        workdir,
        verifyCommand: null,
        // shell so the verify command can run; write so it can edit files.
        // Never gitPush — a PR is opened through the platform's own GitHub
        // App token (lib/github-app.ts), not the worker's local git.
        grant: { write: true, shell: true, network: false, install: false, secrets: false, gitPush: false, externalPayments: false, perTaskLimitUsd: 3, dailyLimitUsd: 20 },
      })
      if (!r.ok) setError(r.error)
      else setCommand(r.command)
    } finally {
      setBusy(false)
    }
  }

  if (command) {
    return (
      <div className="space-y-3 rounded-lg border border-border p-5">
        <p className="text-sm font-medium">Claude Code를 고객님의 저장소와 연결하세요.</p>
        <p className="text-xs text-muted-foreground">작업 디렉터리가 있는 컴퓨터에서 한 번 실행하세요 (토큰은 한 번만 표시됩니다):</p>
        <pre className="overflow-auto rounded bg-secondary p-2 text-[11px]">{command}</pre>
        <button
          type="button"
          onClick={() => void reload()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          연결 확인했어요, 다음으로
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-5">
      <h2 className="font-medium">① 워커 연결</h2>
      {agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">먼저 에이전트를 하나 만들어야 합니다 — /agents에서 만들 수 있어요.</p>
      ) : (
        <>
          <label className="block text-sm">
            에이전트
            <select className="mt-1 w-full rounded border border-border bg-background p-2" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            작업 디렉터리 (저장소를 clone한 절대 경로)
            <input
              className="mt-1 w-full rounded border border-border bg-background p-2 font-mono text-xs"
              value={workdir}
              onChange={(e) => setWorkdir(e.target.value)}
              placeholder="/home/me/code/my-repo"
            />
          </label>
          <p className="text-xs text-muted-foreground">코드는 고객님의 환경에 남습니다. Handsel은 작업 계획과 실행 결과만 기록합니다.</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="button"
            disabled={busy || !agentId || !workdir}
            onClick={connect}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} 연결하기
          </button>
        </>
      )}
    </div>
  )
}

/* ── ④ 운영 자세 선택 ─────────────────────────────────────────────────── */

function PostureStep({ slot, reload }: { slot: number; reload: () => Promise<void> }) {
  const [picked, setPicked] = useState<PolicyPreset | null>(null)
  const [busy, setBusy] = useState(false)

  const confirm = async (preset: PolicyPreset) => {
    setBusy(true)
    try {
      await setOfficePolicyPreset(slot, preset)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-5">
      <h2 className="font-medium">② 운영 자세 선택</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        {(['careful', 'standard', 'hands_off'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPicked(p)}
            className={`rounded-lg border p-3 text-left text-sm ${picked === p ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary'}`}
          >
            {POSTURE_LABEL[p]}
          </button>
        ))}
      </div>
      {picked && (
        <div className="space-y-2 rounded-md bg-secondary/50 p-3 text-sm">
          <p>
            <span className="font-medium text-success">자동으로 완료하는 일</span> — {POSTURE_KO[picked].do}
          </p>
          <p>
            <span className="font-medium text-warning">사람에게 묻는 일</span> — {POSTURE_KO[picked].ask}
          </p>
          <p>
            <span className="font-medium">어떤 경우에도 하지 않는 일</span> — {POSTURE_KO[picked].never}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirm(picked)}
            className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} 이 자세로 진행
          </button>
        </div>
      )}
    </div>
  )
}

/* ── ⑤ 실행 전 최종 미리보기 ──────────────────────────────────────────── */

function FinalStep({
  view,
  worker,
  repo,
  setRepo,
  preset,
  checkoutUrl,
}: {
  view: SessionOverview
  worker: SessionOverview['workers'][number]
  repo: string
  setRepo: (v: string) => void
  preset: PolicyPreset
  checkoutUrl: string | null
}) {
  const [diag, setDiag] = useState<Diagnostic | null>(null)
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [started, setStarted] = useState<{ id: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runDiagnosis = async () => {
    if (!repo.trim()) return
    setDiagBusy(true)
    setDiagError(null)
    setDiag(null)
    try {
      const r = await diagnoseRepoPublic(repo)
      if (r.ok) setDiag(r.diagnostic)
      else setDiagError(r.error)
    } finally {
      setDiagBusy(false)
    }
  }
  useEffect(() => {
    if (repo.trim()) void runDiagnosis()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    if (!diag) return
    setStarting(true)
    setError(null)
    try {
      const r = await startRepoCare({
        slot: view.slot,
        repoFullName: diag.repoFullName,
        workerAgentId: worker.agentId,
        labels: [],
        maxPerWave: 3,
        verifyCommand: worker.verifyCommand,
        openPrs: true,
        budgetLimitUsd: 5,
        everyMinutes: 720,
      })
      if (!r.ok) {
        setError(r.error)
        return
      }
      setStarted({ id: r.session.id })
      if (checkoutUrl) window.location.href = checkoutUrl
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border p-5">
      <h2 className="font-medium">③ 실행 전 최종 미리보기</h2>
      <label className="block text-sm">
        GitHub 저장소
        <div className="mt-1 flex gap-2">
          <input
            className="flex-1 rounded border border-border bg-background p-2 font-mono text-sm"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/repo"
          />
          <button type="button" onClick={() => void runDiagnosis()} disabled={diagBusy || !repo.trim()} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary disabled:opacity-50">
            {diagBusy ? <Loader2 className="size-4 animate-spin" /> : '다시 확인'}
          </button>
        </div>
      </label>
      <p className="text-xs text-muted-foreground">
        GitHub App이 이 저장소에 설치되어 있어야 실제로 PR을 열 수 있습니다 —{' '}
        <a className="underline underline-offset-4" href="/start" target="_blank" rel="noreferrer">
          설치 방법
        </a>
        .
      </p>

      {diagError && <p className="text-sm text-destructive">{diagError}</p>}

      {diag && (
        <div className="space-y-2 rounded-md bg-secondary/50 p-3 text-sm">
          <p className="font-medium">오늘 밤의 계획</p>
          <ul className="space-y-1">
            {diag.issues
              .filter((i) => i.bucket === 'workable')
              .map((i) => (
                <li key={i.number} className="text-success">
                  ✓ #{i.number} {i.title}
                </li>
              ))}
            {diag.issues
              .filter((i) => i.bucket !== 'workable')
              .slice(0, 4)
              .map((i) => (
                <li key={i.number} className="text-muted-foreground">
                  ! #{i.number} {i.title} — {i.reason}
                </li>
              ))}
          </ul>
          <p className="pt-1 text-xs text-muted-foreground">
            예상 최대 작업 수: {diag.workable} · 자동 승인 예산: $0 · 운영 자세: {POSTURE_LABEL[preset]}
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {started ? (
        <div className="space-y-2 rounded-md border border-success/40 bg-success/5 p-3 text-sm">
          <p>
            세션이 시작됐습니다 —{' '}
            <Link href={`/office/sessions/${started.id}`} className="underline">
              여기서 지켜보세요
            </Link>
            .
          </p>
          {checkoutUrl ? (
            <a href={checkoutUrl} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
              결제를 마치지 않았다면 계속하기 <ArrowRight className="size-3.5" />
            </a>
          ) : (
            <p className="text-muted-foreground">
              결제 페이지가 아직 열려 있지 않습니다.{' '}
              <a className="underline" href="mailto:hello@handsel.dev?subject=Repo%20Care%20pilot">
                hello@handsel.dev로 알려주시면 안내드릴게요.
              </a>
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={starting || !diag}
          onClick={start}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {starting ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          {PILOT_OFFER.days}일 파일럿 시작 — ${PILOT_OFFER.priceUsd}
        </button>
      )}
    </div>
  )
}
