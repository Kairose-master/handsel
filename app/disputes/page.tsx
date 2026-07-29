import { desc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { disputeRuling } from '@/lib/db/schema'
import { decisionTableToMarkdown, REFUND_GATE_TABLE } from '@/lib/decision-table'

/**
 * The public ruling log — no login.
 *
 * A market that decides who gets money owes an answer to "on what rule". The
 * rule is printed here from `REFUND_GATE_TABLE` itself, not transcribed, so the
 * page cannot drift from the code: the same object that decides is the object
 * rendered. Under it is every decision it has made.
 *
 * That pairing is the point. Either half alone is a claim you have to take on
 * trust — a published rule nobody can see applied, or a list of outcomes with
 * no stated reason. Together they are checkable by a stranger.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata = {
  title: 'Dispute rulings · Handsel',
  description: 'Every dispute decision, and the published rule that produced it.',
}

export default async function DisputesPage() {
  let rulings: (typeof disputeRuling.$inferSelect)[] = []
  let unavailable = false
  try {
    rulings = await db.select().from(disputeRuling).orderBy(desc(disputeRuling.createdAt)).limit(100)
  } catch {
    // The table self-migrates on first use; before that there is nothing to
    // show and saying so is more honest than an empty state that implies zero.
    unavailable = true
  }

  const refunded = rulings.filter((r) => r.decision === 'refund').length

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Dispute rulings</h1>
        <p className="text-muted-foreground">
          Nobody adjudicates disputes here. A refund is only ever derived from evidence the requester
          did not author; everything else settles on a deadline, and the deadline pays the worker.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">The rule</h2>
        <p className="text-sm text-muted-foreground">
          Rendered from the decision table the settlement path actually calls — not a description of
          it. If this table is wrong, the behaviour is wrong in the same way.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border bg-secondary/30 p-4 text-xs leading-relaxed">
          {decisionTableToMarkdown(REFUND_GATE_TABLE)}
        </pre>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">Every ruling</h2>
          {rulings.length > 0 && (
            <span className="font-mono text-sm text-muted-foreground">
              {refunded} refunded · {rulings.length - refunded} left to the deadline
            </span>
          )}
        </div>

        {unavailable ? (
          <p className="text-sm text-muted-foreground">The ruling log is not readable right now.</p>
        ) : rulings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No dispute has been ruled on yet. This is a real zero, not a placeholder.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-4">Job</th>
                  <th className="pb-2 pr-4">Decision</th>
                  <th className="pb-2 pr-4">Ground</th>
                  <th className="pb-2 pr-4">Why</th>
                  <th className="pb-2">When</th>
                </tr>
              </thead>
              <tbody className="align-top">
                {rulings.map((r) => (
                  <tr key={r.id} className="border-t border-border/60">
                    <td className="py-2 pr-4 font-mono">#{r.onchainJobId}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={
                          r.decision === 'refund'
                            ? 'rounded bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive'
                            : 'rounded bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground'
                        }
                      >
                        {r.decision === 'refund' ? 'refunded' : 'no refund'}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.ground}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{r.reason}</td>
                    <td className="py-2 whitespace-nowrap text-xs text-muted-foreground">
                      {r.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2 border-t border-border pt-6 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">What this does not claim</h2>
        <p>
          The operator still holds the arbiter key and can settle any disputed job directly. Removing
          the admin route would not remove that authority, so it is stated rather than hidden. What
          changed is that the automatic path no longer decides anything: it opens and closes a
          dispute in one pass, only on the grounds above, and otherwise stands aside.
        </p>
        <p>
          None of the grounds judge quality. There is no independent notion of &ldquo;good&rdquo;
          here, and the requester&rsquo;s own acceptance criteria are the only quality signal that
          exists — which is exactly why a verdict from them cannot move escrow back to them.
        </p>
      </section>
    </div>
  )
}
