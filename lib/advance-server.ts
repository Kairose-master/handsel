/**
 * Opening an advance: the sequence, and the record it leaves.
 *
 * `lib/advance.ts` decides. `lib/onchain/advance-chain.ts` writes. This joins
 * them to the database and to the borrower's actual history, and it is where
 * the ordering that keeps a lender secured is enforced:
 *
 *   1. read the collateral from chain      (never from a mirror)
 *   2. quote against the borrower's record
 *   3. record the intent as `pledging`     (before any write — a row that
 *                                           exists is how a crash mid-flow is
 *                                           discoverable at all)
 *   4. assignPayee, sent by the BORROWER
 *   5. read the lien back from chain
 *   6. only now, move the lender's USDC
 *
 * Step 5 is not ceremony. A mined transaction is not a confirmed state, and
 * this is the single point where "the lender is secured" stops being an
 * assumption. Everything before step 6 fails safe; nothing after it does.
 *
 * The table creates itself, for the reason in lib/db/ensure-columns.ts:
 * drizzle expands `db.select().from(x)` to name every declared column, so
 * adding one to an existing table breaks every read of it between deploy and
 * a hand-run migration. A side table is free of that.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Address } from 'viem'
import { db, pool } from '@/lib/db'
import { agent, agentEvent } from '@/lib/db/schema'
import { quoteAdvance, REFUSAL_TEXT, type AdvanceQuote } from '@/lib/advance'
import {
  DELEGATION_COMPLETED,
  DELEGATION_FAILED,
  orchestrationRecord,
  type OrchestrationEvent,
  type OrchestrationRecord,
} from '@/lib/orchestration-risk'
import { assignPayeeOnchain, readCollateral, verifyLien } from '@/lib/onchain/advance-chain'
import { transferUsdc, usdcBalanceOf } from '@/lib/onchain/treasury'

let ready: Promise<void> | null = null

async function ensureTable(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS agent_advance (
           id text PRIMARY KEY,
           borrower_agent_id text NOT NULL,
           lender_agent_id text NOT NULL,
           delegation_id text,
           collateral_contract text NOT NULL,
           collateral_job_id integer NOT NULL,
           advance_usd numeric(12,2) NOT NULL,
           fee_usd numeric(12,2) NOT NULL,
           pledge_usd numeric(12,2) NOT NULL,
           ltv double precision NOT NULL,
           fee_rate double precision NOT NULL,
           status text NOT NULL,
           failure text,
           assign_tx text,
           disburse_tx text,
           created_at timestamptz NOT NULL DEFAULT now(),
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      // One live advance per job, enforced by the database rather than by a
      // read-then-write in application code. The contract already refuses a
      // second `assignPayee`, so without this the second borrower's money
      // moves and the revert arrives afterwards.
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS agent_advance_live_job
           ON agent_advance (collateral_contract, collateral_job_id)
           WHERE status <> 'failed'`,
      )
      await pool.query(`CREATE INDEX IF NOT EXISTS agent_advance_borrower ON agent_advance (borrower_agent_id, created_at DESC)`)
      await pool.query(`CREATE INDEX IF NOT EXISTS agent_advance_lender ON agent_advance (lender_agent_id, created_at DESC)`)
    })()
      .then(() => undefined)
      .catch((e) => {
        ready = null // not cached on failure, or every later call believes it exists
        throw e
      })
  }
  return ready
}

export type AdvanceStatus = 'pledging' | 'open' | 'failed'

export type AdvanceRow = {
  id: string
  borrowerAgentId: string
  lenderAgentId: string
  delegationId: string | null
  collateralContract: string
  collateralJobId: number
  advanceUsd: number
  feeUsd: number
  pledgeUsd: number
  ltv: number
  feeRate: number
  status: AdvanceStatus
  failure: string | null
  assignTx: string | null
  disburseTx: string | null
  createdAt: Date
  updatedAt: Date
}

const toRow = (r: Record<string, unknown>): AdvanceRow => ({
  id: r.id as string,
  borrowerAgentId: r.borrower_agent_id as string,
  lenderAgentId: r.lender_agent_id as string,
  delegationId: (r.delegation_id as string | null) ?? null,
  collateralContract: r.collateral_contract as string,
  collateralJobId: Number(r.collateral_job_id),
  advanceUsd: Number(r.advance_usd),
  feeUsd: Number(r.fee_usd),
  pledgeUsd: Number(r.pledge_usd),
  ltv: Number(r.ltv),
  feeRate: Number(r.fee_rate),
  status: r.status as AdvanceStatus,
  failure: (r.failure as string | null) ?? null,
  assignTx: (r.assign_tx as string | null) ?? null,
  disburseTx: (r.disburse_tx as string | null) ?? null,
  createdAt: new Date(r.created_at as string),
  updatedAt: new Date(r.updated_at as string),
})

/**
 * The borrower's orchestration history, as the LTV reads it.
 *
 * Only the two terminal delegation events count. A prime's task-level
 * successes say how well it works, not how well it coordinates, and folding
 * them in here would quietly price a different risk than the one the lender
 * carries.
 */
export async function orchestrationRecordFor(agentId: string): Promise<OrchestrationRecord> {
  const rows = await db
    .select()
    .from(agentEvent)
    .where(and(eq(agentEvent.agentId, agentId), inArray(agentEvent.eventType, [DELEGATION_COMPLETED, DELEGATION_FAILED])))
  const events: OrchestrationEvent[] = rows.map((r) => {
    const d = (r.detail ?? {}) as Record<string, unknown>
    return {
      eventType: r.eventType,
      delivered: Number(d.delivered ?? 0),
      total: Number(d.total ?? 0),
      budgetUsd: Number(d.budgetUsd ?? 0),
      createdAt: r.createdAt,
    }
  })
  return orchestrationRecord(events)
}

export type AdvanceOffer =
  | { ok: true; quote: AdvanceQuote; collateralBountyUsd: number; record: OrchestrationRecord }
  | { ok: false; message: string }

/** What this borrower could raise against one accepted job, right now. */
export async function offerFor(input: {
  borrowerAgentId: string
  jobId: number
  requestedUsd?: number
  now?: number
}): Promise<AdvanceOffer> {
  const collateral = await readCollateral(input.jobId)
  if (!collateral) return { ok: false, message: 'That job is not on the configured market.' }

  const [borrower] = await db.select().from(agent).where(eq(agent.id, input.borrowerAgentId))
  if (!borrower?.smartAccountAddress) return { ok: false, message: 'Provision the borrowing agent first — it needs a wallet to be paid into.' }
  // The contract accepts `assignPayee` from `job.worker` alone. Checking it
  // here turns a revert the borrower cannot read into a sentence it can.
  if (collateral.status === 'Accepted' && borrower.smartAccountAddress.toLowerCase() !== (await workerOf(input.jobId))) {
    return { ok: false, message: 'This agent is not the worker on that job, so it has nothing to pledge.' }
  }

  const record = await orchestrationRecordFor(input.borrowerAgentId)
  const quote = quoteAdvance({ collateral, record, requestedUsd: input.requestedUsd, now: input.now ?? Date.now() })
  if (!quote.ok) return { ok: false, message: REFUSAL_TEXT[quote.reason] }
  return { ok: true, quote, collateralBountyUsd: collateral.bountyUsd, record }
}

async function workerOf(jobId: number): Promise<string> {
  const { publicClient } = await import('@/lib/onchain/clients')
  const { onchainEnv } = await import('@/lib/onchain/config')
  const { LABOR_MARKET_V2_ABI } = await import('@/lib/onchain/labor-v2-artifact')
  const job = (await publicClient().readContract({
    address: onchainEnv.laborMarketAddress as Address,
    abi: LABOR_MARKET_V2_ABI,
    functionName: 'jobs',
    args: [BigInt(jobId)],
  })) as readonly unknown[]
  return String(job[1]).toLowerCase()
}

export type OpenAdvanceResult = { ok: true; advance: AdvanceRow } | { ok: false; message: string }

/**
 * Open an advance. Lien first, money second — see the file header.
 *
 * Re-quotes rather than trusting a quote passed in from a page. A quote is a
 * snapshot of a job whose deadline is moving and whose status a submission can
 * change; honouring one the borrower's browser was holding for four minutes is
 * how a lender ends up secured against a job that no longer exists.
 */
export async function openAdvance(input: {
  borrowerAgentId: string
  lenderAgentId: string
  jobId: number
  requestedUsd?: number
  delegationId?: string | null
}): Promise<OpenAdvanceResult> {
  await ensureTable()

  if (input.borrowerAgentId === input.lenderAgentId) {
    // Lending to yourself against your own receivable moves no capital and
    // manufactures an orchestration record for free.
    return { ok: false, message: 'An agent cannot advance against its own job.' }
  }

  const [lender] = await db.select().from(agent).where(eq(agent.id, input.lenderAgentId))
  if (!lender?.smartAccountAddress) return { ok: false, message: 'The lending agent has no wallet.' }

  const offer = await offerFor({ borrowerAgentId: input.borrowerAgentId, jobId: input.jobId, requestedUsd: input.requestedUsd })
  if (!offer.ok) return offer
  const q = offer.quote

  const balance = await usdcBalanceOf(lender.smartAccountAddress as Address)
  if (balance + 1e-6 < q.advanceUsd) {
    return { ok: false, message: `The lender holds $${balance.toFixed(2)} — short of the $${q.advanceUsd.toFixed(2)} advance.` }
  }

  const id = `adv-${nanoid(10)}`
  try {
    await pool.query(
      `INSERT INTO agent_advance
         (id, borrower_agent_id, lender_agent_id, delegation_id, collateral_contract, collateral_job_id,
          advance_usd, fee_usd, pledge_usd, ltv, fee_rate, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pledging')`,
      [
        id,
        input.borrowerAgentId,
        input.lenderAgentId,
        input.delegationId ?? null,
        (await readCollateral(input.jobId))!.contract,
        input.jobId,
        q.advanceUsd,
        q.feeUsd,
        q.pledgeUsd,
        q.ltv,
        q.feeRate,
      ],
    )
  } catch {
    // The partial unique index is the arbiter of "one live advance per job",
    // so losing this race is a normal outcome and not an error to surface raw.
    return { ok: false, message: 'This job already has an advance against it.' }
  }

  const fail = async (message: string): Promise<OpenAdvanceResult> => {
    await pool
      .query(`UPDATE agent_advance SET status='failed', failure=$2, updated_at=now() WHERE id=$1`, [id, message.slice(0, 500)])
      .catch(() => {})
    return { ok: false, message }
  }

  let assignTx: string
  try {
    assignTx = await assignPayeeOnchain(
      input.borrowerAgentId,
      input.jobId,
      lender.smartAccountAddress as Address,
      q.pledgeUsd,
    )
  } catch (error) {
    return fail(`Could not pledge the job: ${error instanceof Error ? error.message : String(error)}`)
  }
  await pool.query(`UPDATE agent_advance SET assign_tx=$2, updated_at=now() WHERE id=$1`, [id, assignTx]).catch(() => {})

  const lien = await verifyLien(input.jobId, lender.smartAccountAddress as Address, q.pledgeUsd)
  if (!lien.ok) return fail(`The pledge did not take hold, so nothing was paid out. ${lien.reason}`)

  let disburseTx: string
  try {
    disburseTx = await transferUsdc(input.lenderAgentId, (await borrowerWallet(input.borrowerAgentId)) as Address, q.advanceUsd)
  } catch (error) {
    // The lien stands and the money did not move. The borrower has an unused
    // pledge on its own job — recoverable by paying, and the honest thing to
    // say is exactly that rather than "advance failed".
    return fail(
      `The job is pledged to the lender but the transfer failed, so no money moved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const { rows } = await pool.query(
    `UPDATE agent_advance SET status='open', disburse_tx=$2, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, disburseTx],
  )
  return { ok: true, advance: toRow(rows[0]) }
}

async function borrowerWallet(agentId: string): Promise<string> {
  const [row] = await db.select().from(agent).where(eq(agent.id, agentId))
  if (!row?.smartAccountAddress) throw new Error('borrower has no wallet')
  return row.smartAccountAddress
}

/** Every advance this agent borrowed or funded, newest first. */
export async function advancesFor(agentId: string, limit = 50): Promise<AdvanceRow[]> {
  await ensureTable()
  const { rows } = await pool.query(
    `SELECT * FROM agent_advance WHERE borrower_agent_id=$1 OR lender_agent_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, limit],
  )
  return rows.map(toRow)
}

/** Advances against a delegation, for the page that shows how it was funded. */
export async function advancesForDelegation(delegationId: string): Promise<AdvanceRow[]> {
  await ensureTable()
  const { rows } = await pool.query(
    `SELECT * FROM agent_advance WHERE delegation_id=$1 ORDER BY created_at DESC`,
    [delegationId],
  )
  return rows.map(toRow)
}
