/**
 * Sessions — storage, the turn poster, and the outcome refresh.
 *
 * `lib/session.ts` decides everything; this file reads the three places a
 * turn's truth lives (the spec's grade, the worker run, the chain) and
 * writes the two side tables. Both tables create themselves (invariant 20).
 *
 * A turn is an ordinary job. Nothing in settlement, grading, reservation or
 * proofs knows the word "session"; the thread exists only in `job_session_turn`
 * and in the brief each turn's job carries. That is deliberate: a session
 * that needed the money path to know about it would be a session that could
 * break the money path.
 */
import { nanoid } from 'nanoid'
import { db, pool } from '@/lib/db'
import { agent, agentTask, jobSpec } from '@/lib/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { untrustedNonce } from '@/lib/untrusted-input'
import {
  autoClose,
  canOpenSession,
  canSay,
  isOpenTurn,
  turnBrief,
  turnOutcomeFrom,
  DEFAULT_MAX_TURNS,
  DEFAULT_WALL_MS,
  type ClosedBy,
  type OpenRefusal,
  type SayRefusal,
  type Session,
  type Turn,
} from '@/lib/session'

let tableReady: Promise<void> | null = null
function ensureTables(): Promise<void> {
  tableReady ??= (async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS job_session (
         id text PRIMARY KEY,
         user_id text NOT NULL,
         requester_agent_id text NOT NULL,
         worker_agent_id text,
         title text NOT NULL,
         standing_criteria text NOT NULL,
         turn_price_usd numeric NOT NULL,
         max_turns integer NOT NULL,
         wall_deadline timestamptz NOT NULL,
         status text NOT NULL DEFAULT 'open',
         closed_by text,
         opened_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pool.query(`CREATE INDEX IF NOT EXISTS job_session_owner ON job_session (user_id, opened_at)`)
    await pool.query(
      `CREATE TABLE IF NOT EXISTS job_session_turn (
         session_id text NOT NULL,
         seq integer NOT NULL,
         spec_hash text NOT NULL,
         message text NOT NULL,
         posted_at timestamptz NOT NULL DEFAULT now(),
         outcome text NOT NULL DEFAULT 'posted',
         output text,
         onchain_job_id integer,
         PRIMARY KEY (session_id, seq)
       )`,
    )
  })()
  return tableReady
}

type SessionRow = {
  id: string
  user_id: string
  requester_agent_id: string
  worker_agent_id: string | null
  title: string
  standing_criteria: string
  turn_price_usd: string
  max_turns: number
  wall_deadline: Date
  status: 'open' | 'closed'
  closed_by: ClosedBy | null
  opened_at: Date
}
type TurnRow = {
  seq: number
  spec_hash: string
  message: string
  posted_at: Date
  outcome: Turn['outcome']
  output: string | null
  onchain_job_id: number | null
}

const toSession = (r: SessionRow): Session & { userId: string } => ({
  id: r.id,
  userId: r.user_id,
  title: r.title,
  standingCriteria: r.standing_criteria,
  turnPriceUsd: Number(r.turn_price_usd),
  maxTurns: r.max_turns,
  wallDeadline: new Date(r.wall_deadline).toISOString(),
  requesterAgentId: r.requester_agent_id,
  workerAgentId: r.worker_agent_id,
  status: r.status,
  closedBy: r.closed_by,
  openedAt: new Date(r.opened_at).toISOString(),
})
const toTurn = (r: TurnRow): Turn => ({
  seq: r.seq,
  specHash: r.spec_hash,
  message: r.message,
  postedAt: new Date(r.posted_at).toISOString(),
  outcome: r.outcome,
  output: r.output,
  onchainJobId: r.onchain_job_id,
})

export type OpenResult =
  | { ok: true; session: Session }
  | { ok: false; reason: OpenRefusal | 'no-agent'; message: string }

export async function openSession(input: {
  userId: string
  requesterAgentId?: string | null
  title: string
  standingCriteria: string
  turnPriceUsd: number
  maxTurns?: number
  wallMs?: number
}): Promise<OpenResult> {
  await ensureTables()
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS
  const wallMs = input.wallMs ?? DEFAULT_WALL_MS
  const verdict = canOpenSession({ title: input.title, standingCriteria: input.standingCriteria, turnPriceUsd: input.turnPriceUsd, maxTurns, wallMs })
  if (!verdict.ok) return verdict

  const mine = await db.select({ id: agent.id, address: agent.smartAccountAddress }).from(agent).where(eq(agent.userId, input.userId))
  const requester = input.requesterAgentId ? mine.find((a) => a.id === input.requesterAgentId) : mine.find((a) => a.address)
  if (!requester || !requester.address) {
    return { ok: false, reason: 'no-agent', message: 'No provisioned agent to pay from — list_my_agents shows them; create_worker_agent adds one.' }
  }

  const id = `ses-${nanoid(8)}`
  const { rows } = await pool.query<SessionRow>(
    `INSERT INTO job_session (id, user_id, requester_agent_id, title, standing_criteria, turn_price_usd, max_turns, wall_deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::bigint * interval '1 millisecond'))
     RETURNING *`,
    [id, input.userId, requester.id, input.title.trim(), input.standingCriteria.trim(), input.turnPriceUsd, maxTurns, wallMs],
  )
  return { ok: true, session: toSession(rows[0]) }
}

async function loadSession(sessionId: string): Promise<(Session & { userId: string }) | null> {
  await ensureTables()
  const { rows } = await pool.query<SessionRow>(`SELECT * FROM job_session WHERE id = $1`, [sessionId])
  return rows[0] ? toSession(rows[0]) : null
}

async function loadTurns(sessionId: string): Promise<Turn[]> {
  const { rows } = await pool.query<TurnRow>(`SELECT * FROM job_session_turn WHERE session_id = $1 ORDER BY seq ASC`, [sessionId])
  return rows.map(toTurn)
}

/**
 * Bring every non-terminal turn up to date from the spec, the run and the
 * chain, bind the worker from the first claimed turn, and apply the
 * session's own auto-close. Persists what changed. Never throws on a chain
 * read failure — the turn stays where it was and the next look tries again.
 */
export async function refreshSession(sessionId: string, now = Date.now()): Promise<{ session: Session & { userId: string }; turns: Turn[] } | null> {
  const session = await loadSession(sessionId)
  if (!session) return null
  const turns = await loadTurns(sessionId)
  const open = turns.filter(isOpenTurn)

  if (open.length > 0) {
    const specs = await db.select().from(jobSpec).where(inArray(jobSpec.specHash, open.map((t) => t.specHash)))
    const byHash = new Map(specs.map((s) => [s.specHash, s]))
    const taskIds = specs.map((s) => s.agentTaskId).filter((x): x is string => Boolean(x))
    const tasks = taskIds.length
      ? await db.select({ id: agentTask.id, status: agentTask.status, output: agentTask.output }).from(agentTask).where(inArray(agentTask.id, taskIds))
      : []
    const taskById = new Map(tasks.map((t) => [t.id, t]))
    const { readJobs } = await import('@/lib/onchain/labor')
    const jobs = await readJobs().catch(() => null)

    for (const t of open) {
      const spec = byHash.get(t.specHash)
      const chain = jobs?.find((j) => j.specHash.toLowerCase() === t.specHash.toLowerCase()) ?? null
      const task = spec?.agentTaskId ? taskById.get(spec.agentTaskId) : undefined
      const outcome = turnOutcomeFrom({
        chainStatus: chain?.status ?? null,
        gradePassed: spec?.testResult?.passed,
        taskStatus: task?.status ?? null,
      })
      const output = outcome === 'passed' ? (task?.output ?? t.output) : t.output
      const onchainJobId = chain?.id ?? spec?.onchainJobId ?? t.onchainJobId
      if (outcome !== t.outcome || output !== t.output || onchainJobId !== t.onchainJobId) {
        await pool.query(`UPDATE job_session_turn SET outcome = $3, output = $4, onchain_job_id = $5 WHERE session_id = $1 AND seq = $2`, [
          sessionId,
          t.seq,
          outcome,
          output,
          onchainJobId,
        ])
        t.outcome = outcome
        t.output = output
        t.onchainJobId = onchainJobId
      }
      // The worker is whoever took the first turn that got taken. Bound once;
      // every later turn is reserved for it.
      if (!session.workerAgentId && spec?.workerAgentId) {
        await pool.query(`UPDATE job_session SET worker_agent_id = $2, updated_at = now() WHERE id = $1 AND worker_agent_id IS NULL`, [sessionId, spec.workerAgentId])
        session.workerAgentId = spec.workerAgentId
      }
    }
  }

  const closedBy = autoClose(session, turns, now)
  if (closedBy && session.status !== 'closed') {
    await pool.query(`UPDATE job_session SET status = 'closed', closed_by = $2, updated_at = now() WHERE id = $1 AND status = 'open'`, [sessionId, closedBy])
    session.status = 'closed'
    session.closedBy = closedBy
  }
  return { session, turns }
}

export type SayResult =
  | { ok: true; turn: Turn; txHash: string }
  | { ok: false; reason: SayRefusal | 'no-session' | 'not-owner' | 'post-failed'; message: string }

/** One turn: the requester's message becomes an escrowed job carrying the thread. */
export async function say(input: { userId: string; sessionId: string; message: string; now?: number }): Promise<SayResult> {
  const now = input.now ?? Date.now()
  const state = await refreshSession(input.sessionId, now)
  if (!state) return { ok: false, reason: 'no-session', message: 'No such session.' }
  const { session, turns } = state
  if (session.userId !== input.userId) return { ok: false, reason: 'not-owner', message: 'Only the account that opened this session can speak in it.' }

  const verdict = canSay({ session, turns, now, message: input.message })
  if (!verdict.ok) return verdict

  const brief = turnBrief({ session, seq: verdict.seq, message: verdict.message, thread: turns, nonce: untrustedNonce() })
  const last = turns.length ? turns[turns.length - 1] : null
  const { postSpecJob } = await import('@/lib/job-post')
  let posted: Awaited<ReturnType<typeof postSpecJob>>
  try {
    posted = await postSpecJob({
      payerAgentId: session.requesterAgentId,
      title: brief.title,
      description: brief.description,
      acceptanceCriteria: brief.acceptanceCriteria,
      bountyUsd: session.turnPriceUsd,
      deliveryWindowSec: verdict.windowSec,
      reserveForAgentId: session.workerAgentId,
      parentSpecHash: last?.specHash ?? null,
    })
  } catch (e) {
    return { ok: false, reason: 'post-failed', message: e instanceof Error ? e.message : String(e) }
  }

  const { rows } = await pool.query<TurnRow>(
    `INSERT INTO job_session_turn (session_id, seq, spec_hash, message, onchain_job_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [session.id, verdict.seq, posted.specHash, verdict.message, posted.onchainJobId],
  )
  await pool.query(`UPDATE job_session SET updated_at = now() WHERE id = $1`, [session.id])
  return { ok: true, turn: toTurn(rows[0]), txHash: posted.txHash }
}

export type CloseResult =
  | { ok: true; session: Session; openTurn: Turn | null }
  | { ok: false; reason: 'no-session' | 'not-party' | 'already-closed'; message: string }

/**
 * Close a session: no more turns. Either party may — the requester (owner
 * of the session) or the worker (owner of the bound worker agent). A turn
 * already in flight is untouched: it is its own job and settles on its own.
 */
export async function closeSession(input: { userId: string; sessionId: string }): Promise<CloseResult> {
  const state = await refreshSession(input.sessionId)
  if (!state) return { ok: false, reason: 'no-session', message: 'No such session.' }
  const { session, turns } = state
  let by: ClosedBy | null = session.userId === input.userId ? 'requester' : null
  if (!by && session.workerAgentId) {
    const [w] = await db.select({ userId: agent.userId }).from(agent).where(eq(agent.id, session.workerAgentId))
    if (w?.userId === input.userId) by = 'worker'
  }
  if (!by) return { ok: false, reason: 'not-party', message: 'Only the requester or the bound worker can close a session.' }
  if (session.status === 'closed') return { ok: false, reason: 'already-closed', message: `Already closed (${session.closedBy}).` }
  await pool.query(`UPDATE job_session SET status = 'closed', closed_by = $2, updated_at = now() WHERE id = $1 AND status = 'open'`, [session.id, by])
  session.status = 'closed'
  session.closedBy = by
  return { ok: true, session, openTurn: turns.find(isOpenTurn) ?? null }
}

/** The caller's sessions, newest first, with turn counts. */
export async function listSessions(userId: string, limit = 20): Promise<(Session & { turns: number })[]> {
  await ensureTables()
  const { rows } = await pool.query<SessionRow & { turns: string }>(
    `SELECT s.*, (SELECT count(*) FROM job_session_turn t WHERE t.session_id = s.id) AS turns
       FROM job_session s WHERE s.user_id = $1 ORDER BY s.opened_at DESC LIMIT $2`,
    [userId, limit],
  )
  return rows.map((r) => ({ ...toSession(r), turns: Number(r.turns) }))
}

/** Read-only view for a party (requester or bound worker's owner). */
export async function sessionView(input: { userId: string; sessionId: string }): Promise<{ session: Session; turns: Turn[] } | null> {
  const state = await refreshSession(input.sessionId)
  if (!state) return null
  const { session, turns } = state
  if (session.userId === input.userId) return { session, turns }
  if (session.workerAgentId) {
    const [w] = await db.select({ userId: agent.userId }).from(agent).where(eq(agent.id, session.workerAgentId))
    if (w?.userId === input.userId) return { session, turns }
  }
  return null
}
