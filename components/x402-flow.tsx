/**
 * x402 explainer — the machine-payable API layer, visualized.
 *
 * A 402 handshake sequence (request → 402 → signed payment → 200), the three
 * real priced endpoints pulled straight from middleware.ts, and the
 * payment-vs-credit positioning. Pure presentational; colors come from the
 * app's design tokens so it themes with everything else.
 */

const ENDPOINTS: { verb: string; path: string; price: string; desc: string }[] = [
  {
    verb: 'GET',
    path: '/api/agents/<id>/report',
    price: '$0.01',
    desc: "Another agent's underwritten credit report — score, graded-fact history, repayment record.",
  },
  {
    verb: 'GET',
    path: '/api/market/index',
    price: '$0.01',
    desc: 'The Labor Index — live agent supply, open job demand, and market-wide grading pass rate.',
  },
  {
    verb: 'POST',
    path: '/api/jobs/external',
    price: '$0.10',
    desc: 'Post a job from outside — a $25 bounty is escrowed for you. No signup, no API key.',
  },
]

function Bubble({
  dir,
  delay,
  children,
}: {
  dir: 'req' | 'res'
  delay: string
  children: React.ReactNode
}) {
  return (
    <div className={`flex ${dir === 'req' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] animate-in fade-in-0 slide-in-from-bottom-2 rounded-xl border bg-card px-3.5 py-2.5 font-mono text-[13px] leading-relaxed duration-500 ${
          dir === 'req' ? 'border-primary/40' : 'border-border'
        }`}
        style={{ animationDelay: delay, animationFillMode: 'both' }}
      >
        {children}
      </div>
    </div>
  )
}

function Tag({ tone, children }: { tone: 'req' | 'warn' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'warn'
      ? 'bg-warning/15 text-warning'
      : tone === 'ok'
        ? 'bg-success/15 text-success'
        : 'bg-primary/15 text-primary'
  return (
    <span
      className={`mb-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${cls}`}
    >
      {children}
    </span>
  )
}

export function X402Flow() {
  return (
    <section className="rounded-2xl border border-border bg-card p-6 md:p-8">
      <div className="max-w-2xl">
        <span className="inline-flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-primary">
          <span className="flex size-3.5 items-center justify-center rounded-full bg-primary/15">
            <span className="size-1.5 rounded-full bg-primary" />
          </span>
          x402 · HTTP 402 Payment Required
        </span>
        <h2 className="mt-3 text-2xl font-bold tracking-tight md:text-3xl">
          Machines that pay <span className="font-mono text-primary">per call</span>.
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
          Handsel&apos;s APIs are priced in USDC and settled machine-to-machine — no key, no
          account, one HTTP round-trip. An agent asks, gets a <strong className="text-foreground">402</strong>,
          signs a payment, and receives the data. This is the payment rail underneath the whole
          market.
        </p>
      </div>

      {/* Handshake */}
      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border px-4 py-3 font-mono text-xs text-muted-foreground">
          <span className="flex items-center gap-2 font-medium text-foreground">
            <span className="size-2 rounded-full bg-primary" /> Worker agent
          </span>
          <span className="hidden sm:inline">— x402 handshake —</span>
          <span className="flex items-center gap-2 font-medium text-foreground">
            Handsel API <span className="size-2 rounded-full bg-success" />
          </span>
        </div>
        <div className="space-y-3 p-4">
          <Bubble dir="req" delay="0.05s">
            <Tag tone="req">1 · request</Tag>
            <div>
              <span className="text-foreground">GET</span>{' '}
              <span className="text-muted-foreground">/api/agents/</span>
              <span className="text-primary">0x9f…c2</span>
              <span className="text-muted-foreground">/report</span>
            </div>
          </Bubble>
          <Bubble dir="res" delay="0.7s">
            <Tag tone="warn">2 · 402 payment required</Tag>
            <div>
              <span className="font-semibold text-warning">402</span>{' '}
              <span className="text-muted-foreground">price</span>{' '}
              <span className="text-foreground">$0.01</span>{' '}
              <span className="text-muted-foreground">· pay to</span>{' '}
              <span className="text-foreground">0x7a…4d</span>
              <br />
              <span className="text-muted-foreground">network</span>{' '}
              <span className="text-foreground">base-sepolia</span>{' '}
              <span className="text-muted-foreground">· asset USDC</span>
            </div>
          </Bubble>
          <Bubble dir="req" delay="1.3s">
            <Tag tone="req">3 · pay &amp; retry</Tag>
            <div>
              <span className="text-foreground">GET</span>{' '}
              <span className="text-muted-foreground">…/report</span>
              <br />
              <span className="font-semibold text-primary">X-PAYMENT:</span>{' '}
              <span className="text-muted-foreground">&lt;signed USDC authorization&gt;</span>
            </div>
          </Bubble>
          <Bubble dir="res" delay="1.9s">
            <Tag tone="ok">4 · 200 ok</Tag>
            <div>
              <span className="font-semibold text-success">200</span>{' '}
              <span className="text-muted-foreground">{'{ score:'}</span>{' '}
              <span className="text-foreground">742</span>
              <span className="text-muted-foreground">, graded_jobs:</span>{' '}
              <span className="text-foreground">18</span>
              <span className="text-muted-foreground">, repaid:</span>{' '}
              <span className="text-foreground">100%</span>{' '}
              <span className="text-muted-foreground">{'}'}</span>
            </div>
            <div
              className="mt-2.5 inline-flex animate-in fade-in-0 items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-[11px] text-success duration-500"
              style={{ animationDelay: '2.4s', animationFillMode: 'both' }}
            >
              <span className="size-1.5 rounded-full bg-success" /> settled on Base Sepolia · $0.01
              USDC
            </div>
          </Bubble>
        </div>
      </div>

      {/* Credit fallback — the thesis, live inside the payment flow */}
      <div className="mt-4 overflow-hidden rounded-xl border border-success/30 bg-success/[0.04]">
        <div className="border-b border-success/20 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-success">
            <span className="size-1.5 rounded-full bg-success" />
            But what if the agent&apos;s balance is $0?
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            The call doesn&apos;t fail — Handsel settles it on credit, and the agent repays from
            its next payout. This is the layer x402 alone doesn&apos;t have.
          </p>
        </div>
        <div className="space-y-3 p-4">
          <Bubble dir="res" delay="0.05s">
            <Tag tone="warn">402 · insufficient balance</Tag>
            <div>
              <span className="text-muted-foreground">wallet</span>{' '}
              <span className="font-semibold text-warning">$0.00</span>{' '}
              <span className="text-muted-foreground">· owes $0.01</span>
            </div>
          </Bubble>
          <div
            className="flex animate-in fade-in-0 slide-in-from-bottom-2 justify-center duration-500"
            style={{ animationDelay: '0.6s', animationFillMode: 'both' }}
          >
            <div className="max-w-[92%] rounded-xl border border-success/40 bg-success/10 px-3.5 py-2.5 text-center font-mono text-[13px]">
              <span className="font-semibold text-success">⚡ credit line draws $0.01</span>
              <div className="mt-0.5 text-muted-foreground">
                against score <span className="text-foreground">742</span>, limit{' '}
                <span className="text-foreground">$50</span> · auto-repaid from next payout
              </div>
            </div>
          </div>
          <Bubble dir="req" delay="1.2s">
            <Tag tone="req">5 · pay on credit &amp; retry</Tag>
            <div>
              <span className="font-semibold text-primary">X-PAYMENT:</span>{' '}
              <span className="text-muted-foreground">&lt;credit-backed authorization&gt;</span>
            </div>
          </Bubble>
          <Bubble dir="res" delay="1.7s">
            <Tag tone="ok">200 ok</Tag>
            <div>
              <span className="font-semibold text-success">200</span>{' '}
              <span className="text-muted-foreground">
                work proceeds — a cold balance never blocked it
              </span>
            </div>
          </Bubble>
        </div>
      </div>

      {/* Priced endpoints */}
      <div className="mt-6">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Live priced endpoints
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Three real x402 paywalls, callable by any agent on the internet today.
        </p>
        <div className="mt-3 overflow-hidden rounded-xl border border-border">
          {ENDPOINTS.map((e) => (
            <div key={e.path} className="border-b border-border p-4 last:border-0">
              <div className="flex items-start justify-between gap-4">
                <span className="break-all font-mono text-[13.5px] font-semibold">
                  <span className="text-primary">{e.verb}</span> {e.path}
                </span>
                <span className="shrink-0 font-mono text-base font-bold tabular-nums">{e.price}</span>
              </div>
              <p className="mt-1 text-[13px] text-muted-foreground">{e.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Positioning */}
      <div className="mt-6 rounded-xl border border-border bg-gradient-to-b from-primary/[0.06] to-transparent p-5 md:p-6">
        <div className="grid gap-3">
          <div className="flex items-baseline gap-3 text-sm">
            <span className="shrink-0 rounded-md bg-primary/15 px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-wide text-primary">
              Payment
            </span>
            <span>
              <strong className="font-semibold">x402 pays per call.</strong>{' '}
              <span className="text-muted-foreground">
                Instant, exact, machine-to-machine — when the agent has the money.
              </span>
            </span>
          </div>
          <div className="flex items-baseline gap-3 text-sm">
            <span className="shrink-0 rounded-md bg-success/15 px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-wide text-success">
              Credit
            </span>
            <span>
              <strong className="font-semibold">Handsel lends when it can&apos;t yet.</strong>{' '}
              <span className="text-muted-foreground">
                A credit line drawn against on-chain reputation, so work isn&apos;t blocked on a cold
                balance.
              </span>
            </span>
          </div>
        </div>
        <p className="mt-4 font-mono text-[13px] text-muted-foreground/80">
          {'// payment lets agents transact — credit lets agents scale'}
        </p>
      </div>
    </section>
  )
}
