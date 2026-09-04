import { Check, Sparkles, ArrowRight } from 'lucide-react'
import { PILOT_OFFER } from '@/lib/billing'

/**
 * The `/repo-care` pricing section. Design pattern borrowed from Originkit's
 * "Pricing 02" (checkmark feature lists, a highlighted middle card, a
 * shine-hover CTA) — but hand-written against this repo's own tokens, not
 * the raw fetched module: that module was a generic SaaS monthly/yearly
 * template, minified, and `docs/positioning.md` §8 is explicit that this
 * product sells exactly one offer and never a subscription ladder before
 * the first rung has sold. So the three cards below are the real three
 * things on sale — a free diagnostic, one fixed-price pilot, ongoing care —
 * never a toggle between prices that don't exist yet.
 */

const FREE_FEATURES = ['계정 없이, 지금 바로', '실제 triage 규칙으로 이슈 분류', '위험한 작업은 자동 제외']
const PILOT_FEATURES = [
  `저장소 하나, ${PILOT_OFFER.days}일`,
  '매일 밤 최대 3개 작업',
  '검증 · Pull Request · 아침 보고서',
  '카드 결제, 지갑 불필요',
]
const ONGOING_FEATURES = ['파일럿 결과를 본 뒤 결정', '저장소 수·야간 처리량 기준 산정', '지속적인 야간 케어']

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 space-y-2">
      {items.map((f) => (
        <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
          <Check className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />
          {f}
        </li>
      ))}
    </ul>
  )
}

export function RepoCarePricing({ checkoutUrl }: { checkoutUrl: string | null }) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">가격</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col rounded-xl border border-border p-5 transition-shadow hover:shadow-md">
          <div className="text-sm font-semibold">저장소 진단</div>
          <div className="mt-1 text-2xl font-bold">무료</div>
          <p className="mt-2 text-xs text-muted-foreground">계정 없이, 지금 바로. 위 진단 도구를 사용하세요.</p>
          <FeatureList items={FREE_FEATURES} />
        </div>

        {/* The one thing actually on sale — visually the "Popular" card,
            because it is the whole offer. */}
        <div className="relative flex flex-col rounded-xl border-2 border-primary p-5 shadow-sm transition-shadow hover:shadow-lg">
          <span className="absolute -top-3 left-5 flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-primary-foreground">
            <Sparkles className="size-3" /> 지금 판매 중
          </span>
          <div className="text-sm font-semibold">{PILOT_OFFER.days}일 파일럿</div>
          <div className="mt-1 text-2xl font-bold">${PILOT_OFFER.priceUsd}</div>
          <p className="mt-2 text-xs text-muted-foreground">
            저장소 하나, {PILOT_OFFER.days}일. 매일 밤 최대 3개 작업, 검증, PR, 아침 보고서.
          </p>
          <FeatureList items={PILOT_FEATURES} />
          <div className="mt-5">
            {checkoutUrl ? (
              <a
                href={checkoutUrl}
                className="group relative inline-flex w-full items-center justify-center gap-1.5 overflow-hidden rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
              >
                {PILOT_OFFER.days}일 파일럿 시작 — ${PILOT_OFFER.priceUsd}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12 bg-white/20 opacity-0 transition-all duration-700 group-hover:left-full group-hover:opacity-100"
                />
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
          </div>
        </div>

        <div className="flex flex-col rounded-xl border border-border p-5 transition-shadow hover:shadow-md">
          <div className="text-sm font-semibold">계속 사용</div>
          <div className="mt-1 text-2xl font-bold">월 $299~</div>
          <p className="mt-2 text-xs text-muted-foreground">
            파일럿 결과를 본 뒤 결정하세요. 정확한 요금은 저장소 수와 야간 처리량에 따라 정합니다.
          </p>
          <FeatureList items={ONGOING_FEATURES} />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        지갑과 USDC가 필요하지 않습니다. 일반 카드 결제로 시작하며, 고객의 코드는 고객 환경에 남습니다.
      </p>
    </section>
  )
}
