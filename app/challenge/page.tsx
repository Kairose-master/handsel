import Link from 'next/link'
import { AlertTriangle, ExternalLink, Lock, ShieldCheck } from 'lucide-react'
import { getChallenge } from '@/app/actions/challenge'
import { CHALLENGE_WINDOW_DAYS, challengeHeadline } from '@/lib/challenge'

/**
 * /challenge — the live artifact for the open challenge.
 *
 * `docs/open-challenge.md` is explicit that the marketing object is a page and
 * not a blog post: "showing, from live data: the current escrow balance and the
 * address holding it, linked to the explorer; days elapsed." A challenger has
 * to be able to read the terms, the scope and the end date somewhere that is
 * not a git commit — otherwise, the first time a win is disputed, the operator
 * is the only one who knows what the rules were.
 *
 * Deliberately a server component with no session: it must be readable by
 * someone who will never sign up, and by whatever crawler renders the link.
 *
 * Every number is read at request time. The one thing this page must never do
 * is assert a locked prize that is not locked — see `lib/challenge.ts` for why
 * that is a live concern and not a hypothetical.
 *
 * English only, and not by oversight: the repo's i18n rule exists so product
 * copy reaches people in their language, and this is not product copy. It is
 * the terms of an offer of money. A translated rule that drifts from the
 * English one gives a challenger and the operator two different rulebooks to
 * point at on the day a win is disputed, which is the exact failure the doc
 * calls "quibbling about a win". Same call as `/try`, for a different reason.
 */
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Open challenge — take the escrow',
  description:
    'Real USDC, locked in escrow on Base mainnet. Extract it without doing graded work and it is yours. Terms, scope and live state.',
}

const IN_SCOPE = [
  'The LaborMarket / MiniVault contracts as deployed',
  'Application logic: escrow lifecycle, grading, settlement, scoring, lending',
  'The public agent, worker, and MCP APIs',
  'Prompt injection against workers, graders, and reviewers',
]

const OUT_OF_SCOPE: [string, string][] = [
  [
    'Infrastructure belonging to other companies',
    'Vercel, Neon, GitHub, ZeroDev, the RPC and bundler providers. Not mine to authorise, and saying otherwise would be inviting you into an offence against a third party.',
  ],
  [
    'Denial of service and volumetric attacks',
    'They prove a known truth — a solo deployment can be knocked over — and cost the challenge its remaining time.',
  ],
  [
    'Sybil / multi-account registration',
    'Undefended today, knowingly. Excluded because it extracts no money: the answer is identity verification at signup, a separate control, not a hole in the market mechanism.',
  ],
  ['Social engineering of the operator or of any user', 'Not a property of the system.'],
  [
    "Anything touching another person's account or data",
    'The deployment is meant to contain only operator funds. If that stops being true, this line is why the challenge pauses.',
  ],
]

const RULES: [string, string][] = [
  ['A win is an on-chain balance change, and nothing else.', "The deployment's USDC has to leave its control and land in yours. No off-chain claim, no “I could have”, no reputation number. The chain is the only judge — which is what makes DoS, board-spam and score-manufacturing non-wins by construction."],
  ['Take it and it is yours.', 'The extracted funds are the prize. No claim process, no adjudication, no quibbling — a hedge here would convert a credibility asset into a credibility liability at 100% efficiency.'],
  ['Report or don’t.', 'A working extraction is self-evidencing. A method description is requested, not required.'],
  ['Everything gets published, win or lose.', 'Credited to whatever name you choose, in docs/failure-modes.md, in the same format as every other entry — with a root cause and a fix. Withholding a finding after running a challenge like this would be worse than never running it.'],
]

function Chip({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'live' | 'warn' | 'muted' }) {
  const tones = {
    live: 'border-success/40 bg-success/10 text-success',
    warn: 'border-warning/40 bg-warning/10 text-warning',
    muted: 'border-border bg-secondary text-muted-foreground',
  }
  return (
    <span className={`rounded-md border px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${tones[tone]}`}>
      {children}
    </span>
  )
}

export default async function ChallengePage() {
  const { state, read, escrowAddress, explorerUrl, chainName } = await getChallenge()
  const live = state.kind === 'live'

  return (
    <div className="min-h-svh bg-background text-foreground">
      <main className="mx-auto max-w-[820px] space-y-10 px-5 py-14 md:py-20">
        <header className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={live ? 'live' : 'warn'}>{live ? 'Escrow locked' : 'Not currently locked'}</Chip>
            {chainName && <Chip>{chainName}</Chip>}
            <Chip>Real USDC</Chip>
          </div>

          <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            {/* The headline the doc specifies, in whichever state the chain is
                actually in — including the two the doc did not anticipate. */}
            {read === 'ok' ? challengeHeadline(state) : 'The chain could not be read.'}
          </h1>

          <p className="max-w-[62ch] text-base leading-relaxed text-muted-foreground">
            There is money in an escrow contract on {chainName ?? 'mainnet'}. Get it out to an address you control,
            without doing graded work that entitled you to it, and it is yours. That is the whole game, and the chain
            is the only judge.
          </p>
        </header>

        {/* ── live state ─────────────────────────────────────────────── */}
        <section className="rounded-xl border border-border bg-card p-6">
          {read === 'unconfigured' && (
            <p className="text-sm text-muted-foreground">
              This deployment has no labour market configured — there is no escrow here to attack.
            </p>
          )}
          {read === 'unreachable' && (
            <p className="flex items-start gap-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              The chain could not be read just now. This is not “the prize is gone” — it is “I cannot currently tell
              you”, and those are different answers. Retry in a moment, or read the escrow yourself at the address
              below.
            </p>
          )}

          {read === 'ok' && (
            <dl className="grid gap-5 sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">Prize</dt>
                <dd className="mt-1 font-mono text-2xl font-semibold">
                  {state.kind === 'none' ? '—' : `$${state.prizeUsd}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">Day</dt>
                <dd className="mt-1 font-mono text-2xl font-semibold">
                  {state.kind === 'live' || state.kind === 'lapsed' ? state.daysElapsed : '—'}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">/ {CHALLENGE_WINDOW_DAYS}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                  {state.kind === 'lapsed' ? 'Window closed' : 'Ends'}
                </dt>
                <dd className="mt-1 font-mono text-sm">
                  {state.kind === 'live' || state.kind === 'lapsed'
                    ? new Date(state.endsAt * 1000).toISOString().slice(0, 10)
                    : '—'}
                </dd>
              </div>
            </dl>
          )}

          {state.kind === 'lapsed' && (
            <p className="mt-5 flex items-start gap-2 border-t border-border pt-4 text-sm text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              The delivery window closed, so this escrow is reclaimable and the prize is no longer reliably locked.
              Said plainly rather than left as “Accepted”, which is what the chain still calls it.
            </p>
          )}
          {state.kind === 'settled' && state.taken && (
            <p className="mt-5 border-t border-border pt-4 text-sm">
              The escrow paid out. For a self-to-self challenge escrow that should be impossible, so if you are reading
              this, the write-up is the next thing on this page.
            </p>
          )}

          {escrowAddress && (
            <div className="mt-5 border-t border-border pt-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Escrow held by</p>
              <a
                className="mt-1 inline-flex items-center gap-1.5 break-all font-mono text-sm text-primary hover:underline"
                href={explorerUrl ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
              >
                {escrowAddress}
                <ExternalLink className="size-3.5 shrink-0" />
              </a>
            </div>
          )}
        </section>

        {/* ── why it is shaped this way ───────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Lock className="size-4 text-muted-foreground" /> Why the prize is a job nobody will deliver
          </h2>
          <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">
            The prize is posted as a job and accepted by the operator&apos;s own worker, which never submits. So the
            escrow sits <span className="font-mono">Accepted</span> for the whole window. That removes the grader and
            the review timeout from the attack surface entirely: there is no open job to snipe, no submission to grade,
            no timeout to leak through. The only way the money moves is a real bug in the contract or the settlement
            path — which is the thing being tested.
          </p>
        </section>

        {/* ── scope ──────────────────────────────────────────────────── */}
        <section className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <ShieldCheck className="size-4 text-success" /> In scope
            </h2>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {IN_SCOPE.map((s) => (
                <li key={s} className="leading-relaxed">
                  {s}
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Out of scope</h2>
            <ul className="space-y-3 text-sm text-muted-foreground">
              {OUT_OF_SCOPE.map(([title, why]) => (
                <li key={title} className="leading-relaxed">
                  <span className="font-medium text-foreground">{title}</span> — {why}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── rules ──────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Rules</h2>
          <ul className="space-y-3 text-sm text-muted-foreground">
            {RULES.map(([title, body]) => (
              <li key={title} className="leading-relaxed">
                <span className="font-medium text-foreground">{title}</span> {body}
              </li>
            ))}
          </ul>
        </section>

        {/* ── where to start ─────────────────────────────────────────── */}
        <section className="space-y-3 rounded-xl border border-border bg-secondary/40 p-6">
          <h2 className="text-lg font-semibold">Where I have already been wrong</h2>
          <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">
            Usually the best map of where a system still breaks. Every production defect is written up with its root
            cause and fix, including the two found by other people.
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {[
              ['Failure log', 'https://github.com/Kairose-master/handsel/blob/main/docs/failure-modes.md'],
              ['Security audit', 'https://github.com/Kairose-master/handsel/blob/main/docs/security-audit.md'],
              ['Static analysis', 'https://github.com/Kairose-master/handsel/blob/main/docs/static-analysis.md'],
              ['Full terms', 'https://github.com/Kairose-master/handsel/blob/main/docs/open-challenge.md'],
              ['Source', 'https://github.com/Kairose-master/handsel'],
            ].map(([label, href]) => (
              <a
                key={label}
                className="text-primary hover:underline"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {label}
              </a>
            ))}
          </div>
        </section>

        <footer className="border-t border-border pt-6 text-xs leading-relaxed text-muted-foreground">
          <p>
            Solo-built. Nothing on this page is asserted — the prize, the day count and the end date are read from the
            chain when you load it, and the address above is where you can check them without trusting this page at
            all.
          </p>
          <p className="mt-2">
            <Link className="hover:underline" href="/guest">
              The market this is defending →
            </Link>
          </p>
        </footer>
      </main>
    </div>
  )
}
