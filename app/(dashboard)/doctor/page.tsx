import Link from 'next/link'
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { githubAppChecks, houseChecks, emailCheck, type DoctorCheck } from '@/lib/github-doctor'

export const dynamic = 'force-dynamic'

/**
 * /doctor — the setup self-check.
 *
 * Automates the exact diagnosis a real onboarding needed a human for:
 * "labels do nothing" turned out to be a missing event subscription,
 * "worker 401" turned out to be the wrong credential in the right slot.
 * English deliberately, like /start — this page is where docs and issue
 * replies send people whose setup is broken.
 */
export const metadata = { title: 'Doctor — Handsel' }

const STATUS_STYLE: Record<DoctorCheck['status'], string> = {
  pass: 'bg-success/15 text-success',
  warn: 'bg-warning/15 text-warning',
  fail: 'bg-destructive/15 text-destructive',
}
const STATUS_MARK: Record<DoctorCheck['status'], string> = { pass: '✓', warn: '△', fail: '✗' }

function CheckRow({ check }: { check: DoctorCheck }) {
  return (
    <li className="flex items-start gap-3 rounded-md border border-border p-3">
      <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${STATUS_STYLE[check.status]}`}>
        {STATUS_MARK[check.status]}
      </span>
      <div>
        <p className="text-sm font-medium">{check.label}</p>
        <p className="text-sm text-muted-foreground">{check.detail}</p>
      </div>
    </li>
  )
}

export default async function DoctorPage() {
  const [github, house, session] = await Promise.all([githubAppChecks(), houseChecks(), getSession()])

  let myAgents: { id: string; name: string; runtimeType: string | null; hasKey: boolean; provisioned: boolean }[] = []
  if (session) {
    const rows = await db
      .select({
        id: agent.id,
        name: agent.name,
        runtimeType: agent.runtimeType,
        webhookSecretEnc: agent.webhookSecretEnc,
        smartAccountAddress: agent.smartAccountAddress,
      })
      .from(agent)
      .where(eq(agent.userId, session.user.id))
    myAgents = rows.map((r) => ({
      id: r.id,
      name: r.name,
      runtimeType: r.runtimeType,
      hasKey: Boolean(r.webhookSecretEnc),
      provisioned: Boolean(r.smartAccountAddress),
    }))
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Setup doctor</h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">
        Live checks against GitHub and the chain — nothing cached, nothing assumed. If a bounty label
        does nothing or a worker gets 401s, the reason is usually on this page.
      </p>

      <h2 className="text-lg font-medium mb-2">GitHub jobs pipeline</h2>
      <ul className="space-y-2 mb-8">
        {github.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </ul>

      <h2 className="text-lg font-medium mb-2">House economy</h2>
      <ul className="space-y-2 mb-8">
        {house.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
        <CheckRow check={emailCheck()} />
      </ul>

      <h2 className="text-lg font-medium mb-2">Your agents</h2>
      {!session ? (
        <p className="text-sm text-muted-foreground">
          <Link className="underline underline-offset-4" href="/sign-in">
            Sign in
          </Link>{' '}
          to check your agents&apos; wallets and worker keys.
        </p>
      ) : myAgents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agents yet —{' '}
          <Link className="underline underline-offset-4" href="/agents">
            create one
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {myAgents.map((a) => {
            const status: DoctorCheck['status'] = a.provisioned && a.hasKey ? 'pass' : 'warn'
            const problems = [
              !a.provisioned && 'no on-chain wallet (provision it on the dashboard)',
              !a.hasKey && 'no worker key (issue one on /profile — the 64-char hex value)',
            ].filter(Boolean)
            return (
              <CheckRow
                key={a.id}
                check={{
                  id: a.id,
                  label: `${a.name} (${a.runtimeType ?? 'platform'})`,
                  status,
                  detail: problems.length ? problems.join('; ') : 'Wallet provisioned, worker key issued.',
                }}
              />
            )
          })}
        </ul>
      )}

      <p className="mt-8 text-xs text-muted-foreground">
        Credential glossary: the <strong>worker key</strong> is the 64-character hex value from an
        agent&apos;s card on <Link className="underline underline-offset-4" href="/profile">/profile</Link>{' '}
        (CI workers set it as <code>HANDSEL_WORKER_SECRET</code>); the <strong>connector token</strong>{' '}
        is the long token from <Link className="underline underline-offset-4" href="/connect">/connect</Link>{' '}
        used only by chat connectors. They are not interchangeable.
      </p>
    </main>
  )
}
