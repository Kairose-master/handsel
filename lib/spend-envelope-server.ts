/**
 * The envelope's two impure halves: which envelope an agent has, and the
 * 24-hour ledger the daily ceiling is measured against. Every money path
 * calls `checkSpend` immediately before it signs and `recordSpend` right
 * after the transfer is sent; the pure grading lives in
 * `lib/spend-envelope.ts`.
 *
 * Tables self-create (the `work_proofs` pattern). `agent_spend_event` is
 * append-only and is the audit trail the /autonomy page can read; a row is
 * written for the ESCALATE and DENY outcomes too, so "what did the policy
 * refuse today" is a query, not a log grep.
 *
 * ETH is priced into USD with a conservative fixed rate from env
 * (`SPEND_ETH_USD`, default 4000) — the envelope is about value at risk and
 * a stale-high price only makes it stricter, never looser.
 */
import { pool } from '@/lib/db'
import { isRealMoney } from '@/lib/onchain/real-money'
import {
  DEFAULT_ENVELOPE_REAL_MONEY,
  DEFAULT_ENVELOPE_TESTNET,
  gradeSpend,
  parseEnvelope,
  sumWindow,
  type SpendEnvelope,
  type SpendGrade,
  type SpendKind,
} from '@/lib/spend-envelope'

let ensured: Promise<void> | null = null
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS agent_spend_event (
           id bigserial PRIMARY KEY,
           agent_id text NOT NULL,
           kind text NOT NULL,
           amount_usd numeric(18,6) NOT NULL,
           destination text,
           verdict text NOT NULL,
           owner_approved boolean NOT NULL DEFAULT false,
           ref text,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      await pool.query(`CREATE INDEX IF NOT EXISTS agent_spend_event_agent_idx ON agent_spend_event (agent_id, created_at)`)
      await pool.query(
        `CREATE TABLE IF NOT EXISTS agent_spend_envelope (
           agent_id text PRIMARY KEY,
           envelope jsonb NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
    })().catch((e) => {
      ensured = null
      throw e
    })
  }
  return ensured
}

function envNumber(name: string): number | null {
  const v = process.env[name]
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Platform default, then env overrides, then the agent's own row. */
export async function envelopeFor(agentId: string): Promise<SpendEnvelope> {
  const base = isRealMoney() ? DEFAULT_ENVELOPE_REAL_MONEY : DEFAULT_ENVELOPE_TESTNET
  const fromEnv = parseEnvelope({
    perTxMaxUsd: envNumber('SPEND_PER_TX_MAX_USD') ?? base.perTxMaxUsd,
    dailyMaxUsd: envNumber('SPEND_DAILY_MAX_USD') ?? base.dailyMaxUsd,
    autoApproveMaxUsd: envNumber('SPEND_AUTO_APPROVE_MAX_USD') ?? base.autoApproveMaxUsd,
  })
  const platform = fromEnv ?? base
  try {
    await ensureTables()
    const { rows } = await pool.query<{ envelope: unknown }>(
      `SELECT envelope FROM agent_spend_envelope WHERE agent_id = $1`,
      [agentId],
    )
    const own = rows[0] ? parseEnvelope(rows[0].envelope) : null
    return own ?? platform
  } catch {
    return platform
  }
}

export async function setEnvelopeFor(agentId: string, envelope: SpendEnvelope): Promise<void> {
  await ensureTables()
  await pool.query(
    `INSERT INTO agent_spend_envelope (agent_id, envelope, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (agent_id) DO UPDATE SET envelope = EXCLUDED.envelope, updated_at = now()`,
    [agentId, JSON.stringify(envelope)],
  )
}

/** Sum of ALLOWED spends in the trailing 24h. Refusals do not count. */
export async function spentTodayUsd(agentId: string, now = new Date()): Promise<number> {
  await ensureTables()
  const { rows } = await pool.query<{ amount_usd: string; created_at: Date }>(
    `SELECT amount_usd, created_at FROM agent_spend_event
      WHERE agent_id = $1 AND verdict = 'ALLOW' AND created_at > now() - interval '24 hours'`,
    [agentId],
  )
  return sumWindow(
    rows.map((r) => ({ amountUsd: Number(r.amount_usd), at: new Date(r.created_at) })),
    now,
  )
}

export const ETH_USD_FOR_ENVELOPE = envNumber('SPEND_ETH_USD') ?? 4000

export function weiToUsdForEnvelope(wei: bigint): number {
  return (Number(wei) / 1e18) * ETH_USD_FOR_ENVELOPE
}

export type SpendCheck = { grade: SpendGrade; envelope: SpendEnvelope }

/**
 * Grade a spend and write the audit row for it. When the DB is unreachable
 * the envelope still applies with `spentToday = 0` — a ledger outage must
 * not silently lift the daily ceiling, but must not block the per-transfer
 * one either.
 */
export async function checkSpend(input: {
  agentId: string
  kind: SpendKind
  amountUsd: number
  destination?: string
  ownerApproved?: boolean
  ref?: string
}): Promise<SpendCheck> {
  const envelope = await envelopeFor(input.agentId)
  const spent = await spentTodayUsd(input.agentId).catch(() => 0)
  const grade = gradeSpend(envelope, {
    kind: input.kind,
    amountUsd: input.amountUsd,
    destination: input.destination,
    spentTodayUsd: spent,
    ownerApproved: input.ownerApproved,
  })
  if (grade.verdict !== 'ALLOW') {
    await recordSpend({ ...input, verdict: grade.verdict }).catch(() => undefined)
  }
  return { grade, envelope }
}

export async function recordSpend(input: {
  agentId: string
  kind: SpendKind
  amountUsd: number
  destination?: string
  ownerApproved?: boolean
  ref?: string
  verdict: SpendGrade['verdict']
}): Promise<void> {
  await ensureTables()
  await pool.query(
    `INSERT INTO agent_spend_event (agent_id, kind, amount_usd, destination, verdict, owner_approved, ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.agentId,
      input.kind,
      input.amountUsd.toFixed(6),
      input.destination?.toLowerCase() ?? null,
      input.verdict,
      input.ownerApproved === true,
      input.ref ?? null,
    ],
  )
}

/** The refusal sentence a tool or action returns, with the way past it. */
export function refusalText(check: SpendCheck, agentName: string): string {
  const { grade, envelope } = check
  if (grade.verdict === 'ESCALATE') {
    return (
      `${agentName}: this transfer is over the $${envelope.autoApproveMaxUsd} auto-approve line ` +
      `(per transfer $${envelope.perTxMaxUsd}, per day $${envelope.dailyMaxUsd}). ` +
      `Repeat the call with approve_over_limit set to true to confirm it as the owner.`
    )
  }
  if (grade.verdict === 'DENY') {
    return `${agentName}: refused by the spend envelope (${grade.code}) — ${grade.detail}. Raise the envelope with set_spend_envelope if this is intended.`
  }
  return ''
}
