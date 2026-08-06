'use client'

import { useEffect, useState } from 'react'
import { getGovernance, lockLedger, openProposal, voteOnProposal, setAgentAutoVote, resolveReview } from '@/app/actions/governance'

type Gov = Awaited<ReturnType<typeof getGovernance>>
type VotingAgent = Gov['agents'][number]

function DelegateRow({
  agent,
  busy,
  onSave,
}: {
  agent: VotingAgent
  busy: boolean
  onSave: (agentId: string, enabled: boolean, policy: string) => void
}) {
  const [policy, setPolicy] = useState(agent.votePolicy)
  return (
    <div className="glass-card rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{agent.name}</span>
        <span className="font-mono text-xs text-muted-foreground">score {agent.creditScore.toFixed(0)}</span>
        {agent.autoVote && <span className="rounded bg-primary/15 px-2 py-0.5 text-xs text-primary">🤖 auto-voting on</span>}
      </div>
      {(
        <div className="mt-2">
          <textarea
            value={policy}
            onChange={(e) => setPolicy(e.target.value)}
            placeholder='Voting policy, e.g. "favor lower platform fees and higher miner rewards; oppose anything that raises risk for new miners"'
            rows={2}
            className="block w-full rounded-md border border-border bg-background p-2 text-sm"
          />
          <div className="mt-2 flex gap-2">
            <button
              disabled={busy || !policy.trim()}
              onClick={() => onSave(agent.id, true, policy)}
              className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {agent.autoVote ? 'Update policy' : 'Enable auto-vote'}
            </button>
            {agent.autoVote && (
              <button
                disabled={busy}
                onClick={() => onSave(agent.id, false, policy)}
                className="h-8 rounded-md border border-border px-3 text-xs hover:bg-secondary/50 disabled:opacity-50"
              >
                Disable
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function GovernancePage() {
  const [gov, setGov] = useState<Gov | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [amount, setAmount] = useState('')
  const [weeks, setWeeks] = useState('26')
  const [pTitle, setPTitle] = useState('')
  const [pBody, setPBody] = useState('')

  const refresh = () =>
    getGovernance()
      .then(setGov)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false))

  useEffect(() => {
    refresh()
  }, [])

  const run = async (fn: () => Promise<{ error?: string } | { ok: true }>) => {
    setBusy(true)
    setErr(null)
    const r = await fn()
    if ('error' in r && r.error) setErr(r.error)
    await refresh()
    setBusy(false)
  }

  if (loading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>

  const s = gov?.summary
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Governance</h1>
        <p className="text-muted-foreground">
          $LEDGER is <strong>earned</strong> from completed work, never bought — so a say in the platform tracks real
          contribution. Lock it (longer = more voting power per token) to vote on proposals. Signaling v1: passed
          proposals direct the operator.
        </p>
      </div>

      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div>}

      <div className="grid gap-4 sm:grid-cols-4">
        {[
          ['Balance', `${s?.balance.toFixed(1) ?? '0'} LEDGER`],
          ['Locked', `${s?.locked.toFixed(1) ?? '0'} LEDGER`],
          ['Voting power', `${s?.votingPower.toFixed(1) ?? '0'}`],
          ['Total earned', `${s?.totalEarned.toFixed(1) ?? '0'} LEDGER`],
        ].map(([label, value]) => (
          <div key={label} className="glass-card rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold">{value}</p>
          </div>
        ))}
      </div>

      <div className="glass-card rounded-lg border border-border p-5">
        <h2 className="font-semibold">Lock $LEDGER for voting power</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Power = amount × (weeks / 52). It decays to zero as the lock nears expiry; principal returns to your balance at
          unlock.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            Amount
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              type="number"
              min="0"
              className="mt-1 block h-9 w-32 rounded-md border border-border bg-background px-3 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Weeks (1–52)
            <input
              value={weeks}
              onChange={(e) => setWeeks(e.target.value)}
              type="number"
              min="1"
              max="52"
              className="mt-1 block h-9 w-28 rounded-md border border-border bg-background px-3 text-sm"
            />
          </label>
          <button
            disabled={busy || !amount}
            onClick={() => run(() => lockLedger(parseFloat(amount), parseInt(weeks || '0', 10)))}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Lock
          </button>
        </div>
      </div>

      <div className="glass-card rounded-lg border border-border p-5">
        <h2 className="font-semibold">Open a proposal</h2>
        <input
          value={pTitle}
          onChange={(e) => setPTitle(e.target.value)}
          placeholder="Proposal title"
          className="mt-3 block h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        />
        <textarea
          value={pBody}
          onChange={(e) => setPBody(e.target.value)}
          placeholder="What are you proposing, and why? (e.g. raise the faucet target, add a platform fee, change dispute rules)"
          rows={3}
          className="mt-2 block w-full rounded-md border border-border bg-background p-3 text-sm"
        />
        <button
          disabled={busy || pTitle.trim().length < 8}
          onClick={() => run(() => openProposal(pTitle, pBody).then((r) => { if ('ok' in r) { setPTitle(''); setPBody('') } return r }))}
          className="mt-2 h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Open proposal
        </button>
      </div>

      <div className="glass-card rounded-lg border border-border p-5">
        <h2 className="font-semibold">🤖 AI delegate voting</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Let an agent <strong>you trust</strong> cast <strong>your</strong> $LEDGER vote on open proposals automatically,
          following a stance you set — so you don&apos;t have to be online. It&apos;s your call which agent, not a
          credit-score gate. The platform
          heartbeat asks the agent how your policy applies to each proposal and votes with your locked voting power. One
          delegate per account (your highest-trust enabled agent). It only auto-casts when it&apos;s{' '}
          <strong>≥ 70% confident</strong>; anything uncertain, or that could hurt the least-advantaged, is parked above
          for you to decide — never cast silently.
        </p>
        <div className="mt-3 space-y-2">
          {gov?.agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents yet — create one to enable delegate voting.</p>
          ) : (
            gov?.agents.map((a) => (
              <DelegateRow
                key={a.id}
                agent={a}
                busy={busy}
                onSave={(agentId, enabled, policy) => run(() => setAgentAutoVote(agentId, enabled, policy))}
              />
            ))
          )}
        </div>
      </div>

      {gov && gov.reviews.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-5">
          <h2 className="font-semibold">🔍 Needs your review</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Your delegate wasn&apos;t confident enough to auto-vote these — either it&apos;s a close call, or the proposal
            could hurt the least-advantaged. It never casts those silently. Confirm its recommendation or dismiss it.
          </p>
          <div className="mt-3 space-y-3">
            {gov.reviews.map((r) => (
              <div key={r.proposalId} className="glass-card rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.proposalTitle}</span>
                  <span className="rounded bg-secondary px-2 py-0.5 text-xs">
                    recommends <strong>{r.choice}</strong>
                  </span>
                  {r.confidence != null && (
                    <span className="font-mono text-xs text-muted-foreground">
                      {(r.confidence * 100).toFixed(0)}% confident
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    closes {new Date(r.closesAt).toLocaleDateString()}
                  </span>
                </div>
                {r.reason && <p className="mt-1 text-xs text-warning">⚠ {r.reason}</p>}
                {r.rationale && <p className="mt-1 text-sm text-muted-foreground italic">🤖 “{r.rationale}”</p>}
                <div className="mt-2 flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() => run(() => resolveReview(r.proposalId, 'accept'))}
                    className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  >
                    Vote {r.choice}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(() => resolveReview(r.proposalId, 'dismiss'))}
                    className="h-8 rounded-md border border-border px-3 text-xs hover:bg-secondary/50 disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="mb-3 font-semibold">Proposals</h2>
        {gov?.proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No proposals yet — be the first.</p>
        ) : (
          <div className="space-y-3">
            {gov?.proposals.map((p) => (
              <div key={p.id} className="glass-card rounded-lg border border-border p-4">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{p.title}</span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      p.open ? 'bg-primary/15 text-primary' : p.tally.passed ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {p.open ? 'open' : p.tally.passed ? 'passed' : 'rejected'}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    closes {new Date(p.closesAt).toLocaleDateString()}
                  </span>
                </div>
                {p.body && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{p.body}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  <span className="text-success">For {p.tally.for.toFixed(1)}</span>
                  <span className="text-destructive">Against {p.tally.against.toFixed(1)}</span>
                  <span className="text-muted-foreground">Abstain {p.tally.abstain.toFixed(1)}</span>
                  <span className="text-muted-foreground">· quorum {p.tally.quorumMet ? 'met' : 'not met'}</span>
                  {p.delegateVotes > 0 && (
                    <span className="text-muted-foreground">· 🤖 {p.delegateVotes} delegate</span>
                  )}
                </div>
                {p.yourVote && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    You voted: <strong>{p.yourVote}</strong>
                    {p.yourVoteRationale && <span className="italic"> — 🤖 “{p.yourVoteRationale}”</span>}
                  </p>
                )}
                {p.open &&
                  (p.yourVote ? null : (
                    <div className="mt-2 flex gap-2">
                      {(['for', 'against', 'abstain'] as const).map((c) => (
                        <button
                          key={c}
                          disabled={busy}
                          onClick={() => run(() => voteOnProposal(p.id, c))}
                          className="rounded border border-border px-3 py-1 text-xs hover:bg-secondary/50 disabled:opacity-50"
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
