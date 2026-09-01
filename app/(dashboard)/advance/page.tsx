'use client'

/**
 * The advance desk.
 *
 * For a month the product's headline claim — behaviour earns a score, the
 * score unlocks borrowing — was true of two components and reachable from
 * nothing. `advanceLimit` was called nowhere; `assignPayee` appeared only in
 * tests. This page is where a person walks it.
 *
 * It shows the refusals as loudly as the offers. A job that cannot be borrowed
 * against and simply does not appear is indistinguishable from a bug, and the
 * borrower is the one who cannot tell the difference.
 */
import { useCallback, useEffect, useState } from 'react'
import { PageHead, Panel, Readout, Chip, StatusDot } from '@/components/deck'
import { getAdvanceDesk, openAdvanceAction, type AdvanceDesk, type CollateralCandidate } from '@/app/actions/advance'

const usd = (n: number) => `$${n.toFixed(2)}`
const pct = (n: number) => `${Math.round(n * 100)}%`

function runway(deadlineMs: number): string {
  const ms = deadlineMs - Date.now()
  if (ms <= 0) return 'expired'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export default function AdvancePage() {
  const [desk, setDesk] = useState<AdvanceDesk | null>(null)
  const [loading, setLoading] = useState(true)
  const [borrower, setBorrower] = useState<string | null>(null)
  const [lender, setLender] = useState<string>('')
  const [busyJob, setBusyJob] = useState<number | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const load = useCallback((agentId?: string) => {
    setLoading(true)
    getAdvanceDesk(agentId)
      .then((d) => {
        setDesk(d)
        setBorrower(d.borrowerAgentId)
        setLender((prev) => prev || d.agents.find((a) => a.id !== d.borrowerAgentId)?.id || '')
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const open = async (c: CollateralCandidate) => {
    if (!borrower || !lender) return
    setBusyJob(c.jobId)
    setResult(null)
    const r = await openAdvanceAction({ borrowerAgentId: borrower, lenderAgentId: lender, jobId: c.jobId })
    setBusyJob(null)
    setResult(
      r.ok
        ? { ok: true, message: `Advanced ${usd(r.advance.advanceUsd)} against job #${c.jobId}. The lender is assigned ${usd(r.advance.pledgeUsd)} of the release.` }
        : { ok: false, message: r.message },
    )
    load(borrower)
  }

  return (
    <div className="space-y-5">
      <PageHead
        title="Advance desk"
        subtitle="Borrow working capital against a job you have already accepted. The bounty is locked in escrow, so the lender's claim is attached to it on chain before any money moves — what is being priced is whether you finish, not whether you repay."
      />

      {loading && !desk ? (
        <p className="text-sm text-muted-foreground">Reading the market…</p>
      ) : !desk ? null : desk.agents.length === 0 ? (
        <Panel title="No agents">
          <p className="text-sm text-muted-foreground">Create an agent first — an advance is secured against a job an agent accepted.</p>
        </Panel>
      ) : (
        <>
          <Panel title="Borrower">
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-xs">
                <span className="mb-1 block font-mono uppercase tracking-[0.14em] text-muted-foreground">Borrowing agent</span>
                <select
                  className="rounded-[var(--radius-sm)] border border-border bg-background px-2 py-1.5 text-sm"
                  value={borrower ?? ''}
                  onChange={(e) => {
                    setBorrower(e.target.value)
                    load(e.target.value)
                  }}
                >
                  {desk.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-mono uppercase tracking-[0.14em] text-muted-foreground">Lending agent</span>
                <select
                  className="rounded-[var(--radius-sm)] border border-border bg-background px-2 py-1.5 text-sm"
                  value={lender}
                  onChange={(e) => setLender(e.target.value)}
                >
                  <option value="">Select…</option>
                  {desk.agents
                    .filter((a) => a.id !== borrower)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="flex gap-6">
                <Readout label="LTV" value={desk.ltv === null ? '—' : pct(desk.ltv)} hint="Set by how reliably this agent has finished delegations, not by its credit score." />
                <Readout
                  label="Delegations"
                  value={desk.record ? `${desk.record.completed}/${desk.record.attempts}` : '—'}
                  hint="Fully delivered out of attempted. Partial delivery counts as a failure here — for a lender it is the same outcome as zero."
                />
                <Readout
                  label="Largest finished"
                  value={desk.record?.largestCompletedUsd === null || !desk.record ? '—' : usd(desk.record.largestCompletedUsd)}
                  hint="An advance is capped near this: finishing ten $5 delegations says nothing about a $500 one."
                />
              </div>
            </div>
          </Panel>

          {result && (
            <div
              className={`rounded-[var(--radius-md)] border p-3 text-sm ${
                result.ok ? 'border-[var(--success)]/40 text-[var(--success)]' : 'border-[var(--destructive)]/40 text-[var(--destructive)]'
              }`}
            >
              {result.message}
            </div>
          )}

          <Panel title="Collateral — jobs this agent has accepted">
            {!desk.chainAvailable ? (
              <p className="text-sm text-muted-foreground">
                The market contract could not be read, so there is nothing to quote against. This is a connection problem, not an empty portfolio.
              </p>
            ) : desk.candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This agent has no accepted job. Only a job already in escrow is collateral — an open job has not chosen its worker, and a
                delivered one has already been paid.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {desk.candidates.map((c) => (
                  <li key={c.jobId} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
                    <div className="flex min-w-[8rem] items-center gap-2">
                      <Chip tone="accent">#{c.jobId}</Chip>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">{runway(c.deliveryDeadlineMs)} left</span>
                    </div>
                    <Readout label="Bounty" value={usd(c.bountyUsd)} />
                    {c.quote ? (
                      <>
                        <Readout label="Advance" value={usd(c.quote.advanceUsd)} tone="ok" />
                        <Readout label="Fee" value={`${usd(c.quote.feeUsd)} · ${pct(c.quote.feeRate)}`} hint="Charged per advance, not annualised — the exposure ends when the job releases." />
                        <Readout label="Lender is assigned" value={usd(c.quote.pledgeUsd)} hint="payeeAmount on chain: advance plus fee, irrevocable once set." />
                        <Readout label="You keep" value={usd(c.quote.residualUsd)} />
                        <button
                          type="button"
                          disabled={!lender || busyJob !== null}
                          onClick={() => open(c)}
                          className="ml-auto rounded-[var(--radius-sm)] border border-primary px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-primary disabled:opacity-40"
                        >
                          {busyJob === c.jobId ? 'Pledging…' : 'Take advance'}
                        </button>
                      </>
                    ) : (
                      <div className="ml-auto flex items-center gap-2">
                        <StatusDot tone="warn" label="no offer" />
                        <span className="text-xs text-muted-foreground">{c.refusalText}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Advances">
            {desk.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing borrowed or funded yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {desk.history.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
                    <Chip tone={a.status === 'open' ? 'ok' : a.status === 'failed' ? 'bad' : 'warn'}>{a.status}</Chip>
                    <Readout label="Job" value={`#${a.collateralJobId}`} />
                    <Readout label="Advance" value={usd(a.advanceUsd)} />
                    <Readout label="Pledged" value={usd(a.pledgeUsd)} />
                    <Readout label="LTV" value={pct(a.ltv)} />
                    {a.failure && <span className="text-xs text-[var(--destructive)]">{a.failure}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
