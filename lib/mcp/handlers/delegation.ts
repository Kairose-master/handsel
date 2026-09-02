/**
 * MCP tools — delegation.
 *
 * Delegation: decompose a goal into escrowed subtasks and watch them settle.
 *
 * Split out of a single 75KB route file. Each case body is unchanged; only
 * where it lives moved. Returning `null` for an unrecognised name is what lets
 * the router try the next group, so a handler must never answer for a tool it
 * does not own.
 */
import { MAX_BUDGET_USD } from '@/lib/mcp/tools-manifest'
import { after } from 'next/server'
import { agent, delegation } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { planDelegation, confirmDelegationJobs, tickDelegation, subtaskViews, delegationCost } from '@/lib/delegation'
import { toolText, type McpToolContext } from '../rpc'

export async function handleDelegation(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth } = ctx
  switch (name) {
    case 'plan_delegation': {
      const goal = String(args.goal ?? '').trim()
      const budgetUsd = Number(args.budget_usd)
      if (goal.length < 20) return toolText(id, 'Describe the goal in at least 20 characters.', true)
      if (!Number.isFinite(budgetUsd) || budgetUsd < 2 || budgetUsd > MAX_BUDGET_USD) {
        return toolText(id, `budget_usd must be between 2 and ${MAX_BUDGET_USD}.`, true)
      }
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const wantedId = args.prime_agent_id ? String(args.prime_agent_id) : null
      const wanted = args.prime_agent_name ? String(args.prime_agent_name) : null
      const prime = wantedId
        ? agents.find((a) => a.id === wantedId)
        : wanted
          ? agents.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
          : agents.find((a) => a.smartAccountAddress)
      if (!prime) return toolText(id, wantedId ? `No agent with id "${wantedId}" on this account.` : wanted ? `No agent named "${wanted}" on this account.` : 'No provisioned agent found.', true)
      if (!prime.smartAccountAddress) return toolText(id, `Agent ${prime.name} has no wallet yet — provision it first.`, true)

      const subtasks = await planDelegation(auth.userId, goal, budgetUsd)
      const dlgId = `dlg-${nanoid(10)}`
      await db.insert(delegation).values({
        id: dlgId,
        userId: auth.userId,
        primeAgentId: prime.id,
        task: goal,
        budgetUsd: budgetUsd.toFixed(2),
        status: 'planned',
        subtasks,
        autoVerify: true,
      })
      const planText = subtasks
        .map((st, i) => `${i + 1}. [$${st.bountyUsd.toFixed(2)}] ${st.title}\n   ${st.description}\n   Accept when: ${st.acceptanceCriteria}`)
        .join('\n')
      return toolText(
        id,
        `Plan ready (delegation_id: ${dlgId}, prime agent: ${prime.name}, total $${budgetUsd.toFixed(2)}):\n\n${planText}\n\n` +
          `Nothing is escrowed yet. Show this plan to the user; call confirm_delegation only after they approve.`,
      )
    }
    case 'confirm_delegation': {
      const dlgId = String(args.delegation_id ?? '')
      const result = await confirmDelegationJobs(dlgId, auth.userId)
      return result.ok
        ? toolText(id, `Posted ${result.subtasks.length} escrowed jobs. Track with delegation_status.`)
        : toolText(id, result.error, true)
    }
    case 'delegation_status': {
      const rows = await db
        .select()
        .from(delegation)
        .where(eq(delegation.userId, auth.userId))
        .orderBy(desc(delegation.createdAt))
        .limit(10)
      if (rows.length === 0) return toolText(id, 'No delegations yet.')

      // A finished delegation with an undecided verdict stake still has one
      // thing left to read from the chain: the owner's judgment of the
      // refused piece. It is never ticked, so it is swept here and in the
      // ops cycle — see resolveReviewStakes. It counts as active for the
      // chain read below for exactly that reason.
      const { hasHeldReviewStake } = await import('@/lib/review-stake')
      const staked = rows.filter(
        (r) => r.status === 'completed' && hasHeldReviewStake(r.subtasks as { reviewStake?: import('@/lib/review-stake').ReviewStake }[]),
      )
      const hasActive = rows.some((r) => r.status === 'posted') || staked.length > 0
      const { readJobs } = await import('@/lib/onchain/labor')
      // `null` for a read that FAILED, `[]` for "no active delegation, so we
      // did not ask". Collapsing the two rendered every subtask of every
      // delegation as unposted and every cost as $0 — including a delegation
      // that had already COMPLETED and paid out, which no on-chain state can
      // ever go back to. Read live, that is indistinguishable from "the money
      // never moved", on the one surface an owner checks to find out whether
      // it did. Invariant 10 in docs/failure-modes.md, in the tick path this
      // time rather than the roster.
      const jobs = hasActive ? await readJobs().catch(() => null) : []
      if (jobs === null) {
        return toolText(
          id,
          'Could not read the market contract just now, so I cannot report where your delegations stand. ' +
            'Nothing has changed on-chain — this is a failed read, not a settlement. Try again in a moment.',
          true,
        )
      }
      if (hasActive) {
        const active = rows.filter((r) => r.status === 'posted')
        after(async () => {
          const { sweepStuckGradedJobs } = await import('@/lib/labor-settle')
          await sweepStuckGradedJobs().catch(() => {})
          const { resolveReviewStakes } = await import('@/lib/delegation')
          for (const row of staked) await resolveReviewStakes(row, jobs).catch(() => {})
          for (const row of active) await tickDelegation(row, jobs).catch(() => {})
        })
      }

      const blocks: string[] = []
      for (const row of rows) {
        // A planned delegation has no on-chain jobs to read, but it does have
        // the plan — and that plan is the thing the caller is told to review
        // before confirm_delegation escrows. Rendering nothing for it made the
        // two-step safety story unusable from a connector: the only way to see
        // what you were about to buy was the web dashboard. Straight from the
        // stored jsonb; no chain reads, which is why they were skipped here.
        let subLines: string
        if (row.status === 'planned') {
          const planned = (row.subtasks ?? []) as Array<{
            title: string
            bountyUsd: number
            dependsOn?: string[]
            reviewOf?: string
            payerAgentId?: string
            assignedAgentId?: string
          }>
          subLines = planned
            .map((st) => {
              const notes: string[] = []
              if (st.reviewOf) notes.push(`REVIEWS "${st.reviewOf}" — a REVISE goes back to that worker`)
              else if (st.dependsOn?.length) notes.push(`waits on ${st.dependsOn.join(', ')}`)
              if (st.payerAgentId) notes.push(`paid by ${st.payerAgentId}`)
              if (st.assignedAgentId) notes.push('reserved for this office')
              return `   - ${st.title} ($${st.bountyUsd.toFixed(2)})${notes.length ? `\n       ${notes.join(' · ')}` : ''}`
            })
            .join('\n')
        } else {
          const views = await subtaskViews(row, jobs)
          subLines = views
            .map((v) => `   - ${v.failed ? '❌' : v.jobStatus ?? '…'} ${v.title} ($${v.bountyUsd.toFixed(2)})${v.workerLabel ? ` by ${v.workerLabel}` : ''}`)
            .join('\n')
        }
        const preview =
          row.finalOutput && row.finalOutput.length > 2000
            ? `${row.finalOutput.slice(0, 2000)}\n… [TRUNCATED — ${row.finalOutput.length - 2000} more chars. Call get_delegation_output with delegation_id "${row.id}" for the complete document.]`
            : row.finalOutput
        const c = delegationCost(row, jobs)
        const costLine =
          row.status === 'planned'
            ? ''
            : `\n   cost: $${c.escrowedUsd.toFixed(2)} escrowed (paid $${c.releasedUsd.toFixed(2)}, refunded $${c.refundedUsd.toFixed(2)}, locked $${c.lockedUsd.toFixed(2)}) · gas $0 sponsored · fee $0`
        blocks.push(
          `${row.id} [${row.status}] $${Number(row.budgetUsd).toFixed(2)} budget — ${row.task.slice(0, 80)}` +
            costLine +
            (subLines ? `\n${subLines}` : '') +
            (preview ? `\n   FINAL OUTPUT:\n${preview}` : '') +
            (row.error ? `\n   error: ${row.error}` : ''),
        )
      }
      return toolText(id, blocks.join('\n\n'))
    }
    case 'get_delegation_output': {
      const dlgId = String(args.delegation_id ?? '')
      const [row] = await db.select().from(delegation).where(eq(delegation.id, dlgId))
      if (!row || row.userId !== auth.userId) return toolText(id, 'Delegation not found on this account.', true)
      if (!row.finalOutput) return toolText(id, `Delegation is ${row.status} — no final output assembled yet.`, true)
      return toolText(id, row.finalOutput)
    }
    default:
      return null
  }
}
