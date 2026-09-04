'use client'

/**
 * The free, no-account diagnostic on `/repo-care` — the same rule engine a
 * real session plans from (`lib/repo-care.ts` `triageIssues`), run once,
 * read-only, on any public repository. No sign-in, nothing connected,
 * nothing written anywhere.
 */
import { useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { diagnoseRepoPublic } from '@/app/actions/repo-diagnose'
import type { Diagnostic, DiagnosticBucket } from '@/lib/repo-care'

const BUCKET_LABEL: Record<DiagnosticBucket, string> = {
  workable: '오늘 밤 처리 가능한 작업',
  review: '사람이 직접 봐야 하는 작업',
  excluded: '자동으로 제외된 위험 작업',
}
const BUCKET_TONE: Record<DiagnosticBucket, string> = {
  workable: 'text-success',
  review: 'text-warning',
  excluded: 'text-muted-foreground',
}

export function RepoDiagnostic() {
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Diagnostic | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (!repo.trim()) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await diagnoseRepoPublic(repo)
      if (r.ok) setResult(r.diagnostic)
      else setError(r.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div id="diagnose" className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-lg font-semibold">내 저장소에서 오늘 밤 가능한 일 보기</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        공개 저장소 하나를 입력하세요. 계정도, 연결도 필요 없습니다 — 지금 열려 있는 이슈를 실제 판정 규칙으로 한 번
        읽어볼 뿐입니다.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <input
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
          placeholder="owner/repo (예: facebook/react)"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button
          type="button"
          onClick={run}
          disabled={busy || !repo.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          진단하기
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {result && (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            {(['workable', 'review', 'excluded'] as const).map((b) => (
              <div key={b} className="rounded-md border border-border p-3">
                <div className={`text-2xl font-bold tabular-nums ${BUCKET_TONE[b]}`}>
                  {b === 'workable' ? result.workable : b === 'review' ? result.review : result.excluded}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{BUCKET_LABEL[b]}</div>
              </div>
            ))}
          </div>

          {result.totalOpenIssues === 0 ? (
            <p className="text-sm text-muted-foreground">지금 열려 있는 이슈가 없습니다 — 새 이슈가 열리면 다시 진단해보세요.</p>
          ) : (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">이슈 {result.totalOpenIssues}개 자세히 보기</summary>
              <ul className="mt-2 space-y-1 pl-1">
                {result.issues.slice(0, 30).map((i) => (
                  <li key={i.number} className="flex gap-2">
                    <span className={`shrink-0 font-mono text-[10px] uppercase tracking-wide ${BUCKET_TONE[i.bucket]}`}>
                      {i.bucket === 'workable' ? '가능' : i.bucket === 'review' ? '보류' : '제외'}
                    </span>
                    <span className="min-w-0 truncate">
                      #{i.number} {i.title}
                      {i.reason && <span className="text-muted-foreground"> — {i.reason}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <a
            href={`/office/repo-care?repo=${encodeURIComponent(result.repoFullName)}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            다음: 워커 연결하고 실제로 시작하기 <ArrowRight className="size-3.5" />
          </a>
        </div>
      )}
    </div>
  )
}
