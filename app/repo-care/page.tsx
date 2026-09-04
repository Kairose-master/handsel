import type { Metadata } from 'next'
import { PublicShell } from '@/components/public-shell'
import { RepoDiagnostic } from '@/components/repo-diagnostic'
import { isRealMoney } from '@/lib/onchain/real-money'
import { PILOT_OFFER } from '@/lib/billing'

/**
 * /repo-care — the front door of the sales package (docs/billing.md,
 * docs/repo-care.md). Korean, deliberately and unlike /start: the copy
 * below is the operator's own outbound-tested landing text, written for the
 * first customers this sells to. If this page is ever localized further,
 * keep the copy — do not rewrite it while translating.
 *
 * Was `/pilot`; renamed once the diagnostic (a real feature, not just a
 * checkout link) made this the actual front door rather than a payment
 * page with a description on it.
 */
export const metadata: Metadata = {
  title: '아침에는 PR만 확인하세요 — Handsel Repo Care',
  description: `밤새 AI가 GitHub 저장소의 안전한 backlog를 처리하고, 검증된 변경만 Pull Request로 남깁니다. $${PILOT_OFFER.priceUsd}, ${PILOT_OFFER.days}일 파일럿.`,
}

export default function RepoCarePage() {
  const real = isRealMoney()
  const checkoutUrl = process.env.LEMONSQUEEZY_PILOT_CHECKOUT_URL || null
  return (
    <PublicShell current="/repo-care" eyebrow="Repo Care" width="prose" realMoney={real}>
      <div id="content" className="space-y-12 py-10">
        {/* ── Hero ─────────────────────────────────────────────── */}
        <section className="space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">아침에는 PR만 확인하세요.</h1>
          <p className="text-lg text-muted-foreground">
            Handsel Repo Care는 당신이 이미 사용하는 AI 코드를 밤새 실행해 GitHub 저장소의 안전한 backlog를
            처리합니다.
          </p>
          <p className="text-muted-foreground">
            문서, 테스트, 저위험 버그는 당신의 checkout에서 작업하고, 검증된 변경만 Pull Request로 남깁니다.
          </p>
          <p className="text-muted-foreground">
            production, security, billing, dependency 변경은 자동으로 건드리지 않습니다. 위험한 작업은 사람에게
            넘기고, 그 이유를 기록합니다.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <a
              href="#diagnose"
              className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              내 저장소에서 오늘 밤 가능한 일 보기
            </a>
            <a
              href="#how"
              className="inline-flex items-center justify-center rounded-md border border-border px-5 py-2.5 text-sm font-semibold hover:bg-secondary"
            >
              실제 실행 흐름 보기
            </a>
          </div>
          <p className="pt-1 text-sm text-muted-foreground">
            Claude Code를 새로 배울 필요가 없습니다. 한 번 연결하고, 권한과 예산을 정하면, 다음부터는 결과와 예외만
            확인하세요.
          </p>
        </section>

        {/* ── The diagnostic ───────────────────────────────────── */}
        <RepoDiagnostic />

        {/* ── How it runs ──────────────────────────────────────── */}
        <section id="how" className="space-y-3">
          <h2 className="text-lg font-medium">무슨 일이 일어나는지</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>GitHub 저장소 하나를 연결하고, 원하면 Notion 보드도 함께 연결합니다.</li>
            <li>
              매일 밤 문서, 테스트, 저위험 버그 중 검증 가능한 작업을 최대 몇 개까지 처리합니다 — 가장 오래된 것부터
              순서대로.
            </li>
            <li>모든 변경은 당신의 checkout, 당신의 CI에서, 검증 결과와 함께 Pull Request로 남습니다.</li>
            <li>아침에는 리포트 하나: 무엇이 처리됐고, 무엇이 통과했고, 무엇을 사람에게 남겼는지와 그 이유.</li>
          </ol>
        </section>

        {/* ── What it never touches ────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-lg font-medium">절대 자동으로 건드리지 않는 것</h2>
          <p className="text-sm text-muted-foreground">
            production, security, billing, dependency 변경으로 보이는 작업은 사람에게 넘기고, 그 이유를 타임라인에
            남깁니다. 모델의 판단이 아니라 고정된 규칙표입니다 —{' '}
            <a
              className="underline underline-offset-4"
              href="https://github.com/Kairose-master/handsel/blob/main/docs/repo-care.md"
              target="_blank"
              rel="noreferrer"
            >
              정확한 규칙
            </a>
            을 확인할 수 있습니다.
          </p>
        </section>

        {/* ── Pricing ───────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-medium">가격</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-4">
              <div className="text-sm font-semibold">저장소 진단</div>
              <div className="mt-1 text-2xl font-bold">무료</div>
              <p className="mt-2 text-xs text-muted-foreground">계정 없이, 지금 바로. 위 진단 도구를 사용하세요.</p>
            </div>
            <div className="rounded-lg border-2 border-primary p-4">
              <div className="text-sm font-semibold">{PILOT_OFFER.days}일 파일럿</div>
              <div className="mt-1 text-2xl font-bold">${PILOT_OFFER.priceUsd}</div>
              <p className="mt-2 text-xs text-muted-foreground">
                저장소 하나, {PILOT_OFFER.days}일. 매일 밤 최대 3개 작업, 검증, PR, 아침 보고서.
              </p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <div className="text-sm font-semibold">계속 사용</div>
              <div className="mt-1 text-2xl font-bold">월 $299~</div>
              <p className="mt-2 text-xs text-muted-foreground">
                파일럿 결과를 본 뒤 결정하세요. 정확한 요금은 저장소 수와 야간 처리량에 따라 정합니다.
              </p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            지갑과 USDC가 필요하지 않습니다. 일반 카드 결제로 시작하며, 고객의 코드는 고객 환경에 남습니다.
          </p>

          {checkoutUrl ? (
            <a
              href={checkoutUrl}
              className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              {PILOT_OFFER.days}일 파일럿 시작 — ${PILOT_OFFER.priceUsd}
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">
              파일럿 결제가 아직 열려 있지 않습니다.{' '}
              <a className="underline underline-offset-4" href="mailto:hello@handsel.dev?subject=Repo%20Care%20pilot">
                hello@handsel.dev로 문의
              </a>
              해주세요.
            </p>
          )}
        </section>

        <p className="text-xs text-muted-foreground">
          결제는 저희의 merchant of record인 Lemon Squeezy가 처리합니다 — Handsel은 카드 정보를 보거나 저장하지
          않습니다.
        </p>
      </div>
    </PublicShell>
  )
}
