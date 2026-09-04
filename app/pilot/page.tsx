import type { Metadata } from 'next'
import { PublicShell } from '@/components/public-shell'
import { isRealMoney } from '@/lib/onchain/real-money'
import { PILOT_OFFER } from '@/lib/billing'

/**
 * /pilot — the one thing docs/positioning.md §8 asks a stranger to buy: a
 * fixed-price, fixed-length Repo Care pilot, not a self-serve subscription
 * nobody has proven yet.
 *
 * English deliberately, like /start — quoted in outbound messages where a
 * locale switcher can't follow. The checkout link comes from
 * LEMONSQUEEZY_PILOT_CHECKOUT_URL and degrades to a plain email ask when
 * unset, same posture every other optional integration in this repo takes
 * (mirror it, don't special-case it) — a payment page that renders before
 * the payment account exists must never show a dead button.
 */
export const metadata: Metadata = {
  title: 'Repo Care pilot — Handsel',
  description: `$${PILOT_OFFER.priceUsd}, ${PILOT_OFFER.days} days, one repository. ${PILOT_OFFER.summary}`,
}

export default function PilotPage() {
  const checkoutUrl = process.env.LEMONSQUEEZY_PILOT_CHECKOUT_URL || null
  return (
    <PublicShell current="/pilot" eyebrow="Repo Care pilot" width="prose" realMoney={isRealMoney()}>
      <div id="content" className="space-y-8 py-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            ${PILOT_OFFER.priceUsd} · {PILOT_OFFER.days}-day Repo Care pilot
          </h1>
          <p className="mt-3 text-muted-foreground">{PILOT_OFFER.summary}</p>
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">What happens</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>You connect one repository, and a Notion board if you use one.</li>
            <li>
              Each night the office reads your open backlog and works the tests, docs and low-risk bugs it can verify
              — a few per run, oldest first.
            </li>
            <li>Every change lands as a pull request with its verification beside it, in your own checkout, on your own CI.</li>
            <li>By morning there is a report: what ran, what passed, and what it left for you and why.</li>
          </ol>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">What it never touches without you</h2>
          <p className="text-sm text-muted-foreground">
            Anything shaped like production, a dependency bump, a secret, or money is left for a person, with the
            reason written down on the timeline — a fixed list, not a model&rsquo;s judgment call
            (<a className="underline underline-offset-4" href="https://github.com/Kairose-master/handsel/blob/main/docs/repo-care.md" target="_blank" rel="noreferrer">the exact rules</a>).
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">What ${PILOT_OFFER.priceUsd} buys</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Setup on one repository, running for {PILOT_OFFER.days} days.</li>
            <li>A person on the other end reading your first few nights with you — not a self-serve trial.</li>
            <li>One payment. No card kept on file, no subscription started for you.</li>
          </ul>
        </section>

        {checkoutUrl ? (
          <a
            href={checkoutUrl}
            className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Start the pilot — ${PILOT_OFFER.priceUsd}
          </a>
        ) : (
          <p className="text-sm text-muted-foreground">
            Pilot checkout isn&rsquo;t open yet.{' '}
            <a className="underline underline-offset-4" href="mailto:hello@handsel.dev?subject=Repo%20Care%20pilot">
              Email hello@handsel.dev
            </a>{' '}
            and we&rsquo;ll set one up.
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          Payment is processed by Lemon Squeezy, our merchant of record — Handsel never sees or stores your card
          details.
        </p>
      </div>
    </PublicShell>
  )
}
