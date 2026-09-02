/**
 * The Notion desk — storage, connect, and the tick.
 *
 * `lib/notion-desk.ts` decides; `lib/notion-api.ts` talks; this reads the
 * owner's database, posts rows as jobs or session turns through the shared
 * poster (`lib/job-post.ts`) or the session layer, and writes the outcome
 * back. One desk per account for now (the `notion_desk` table is keyed by
 * user), self-creating (invariant 20).
 *
 * The money discipline, stated once: a row's status is moved off `Ready`
 * BEFORE its bounty is escrowed. If that write fails there is no post. If
 * the post fails after it, the row is set back to `Ready` with a Note — the
 * owner sees why, and the next tick tries again only if they leave it there.
 */
import { db, pool } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { decryptSecret, encryptSecret } from '@/lib/crypto'
import {
  MAX_POSTS_PER_DAY,
  MAX_POSTS_PER_TICK,
  MAX_ROW_BOUNTY_USD_DEFAULT,
  STATUS,
  checkItem,
  inFlightFilter,
  missingProperties,
  parseDatabaseId,
  parsePage,
  presentOptional,
  readyFilter,
  renderDesk,
  resultBlocks,
  rowPatch,
  type NotionPage,
  type WorkItem,
} from '@/lib/notion-desk'
import { NotionError, appendBlocks, databaseTitle, getDatabase, queryDatabase, updatePage, type NotionDatabase } from '@/lib/notion-api'

let tableReady: Promise<void> | null = null
function ensureTables(): Promise<void> {
  tableReady ??= (async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS notion_desk (
         user_id text PRIMARY KEY,
         token_enc text NOT NULL,
         token_last4 text NOT NULL,
         database_id text NOT NULL,
         database_title text,
         requester_agent_id text NOT NULL,
         max_bounty_usd numeric NOT NULL DEFAULT ${MAX_ROW_BOUNTY_USD_DEFAULT},
         enabled boolean NOT NULL DEFAULT true,
         last_tick_at timestamptz,
         last_error text,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await pool.query(
      `CREATE TABLE IF NOT EXISTS notion_desk_row (
         user_id text NOT NULL,
         page_id text NOT NULL,
         spec_hash text,
         session_id text,
         onchain_job_id integer,
         state text NOT NULL,
         posted_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (user_id, page_id, posted_at)
       )`,
    )
    await pool.query(`CREATE INDEX IF NOT EXISTS notion_desk_row_state ON notion_desk_row (user_id, state)`)
  })()
  return tableReady
}

type DeskRow = {
  user_id: string
  token_enc: string
  token_last4: string
  database_id: string
  database_title: string | null
  requester_agent_id: string
  max_bounty_usd: string
  enabled: boolean
  last_tick_at: Date | null
  last_error: string | null
}

const errText = (e: unknown) => (e instanceof NotionError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)).slice(0, 300)

/* ── Connect / status ─────────────────────────────────────────────────── */

export type ConnectResult =
  | { ok: true; databaseTitle: string | null; missing: string[]; optional: string[]; requesterAgentName: string }
  | { ok: false; reason: 'bad-id' | 'no-agent' | 'notion'; message: string }

/**
 * Store the token (encrypted) and the database, after proving both with one
 * read. A database missing required columns still connects — status names
 * what to add and the tick posts nothing until it exists.
 */
export async function connectNotionDesk(input: {
  userId: string
  token: string
  database: string
  requesterAgentId?: string | null
  maxBountyUsd?: number
}): Promise<ConnectResult> {
  await ensureTables()
  const databaseId = parseDatabaseId(input.database)
  if (!databaseId) return { ok: false, reason: 'bad-id', message: 'That is not a Notion database id or URL.' }
  const token = input.token.trim()
  if (token.length < 20) return { ok: false, reason: 'notion', message: 'That does not look like a Notion integration token.' }

  const mine = await db.select({ id: agent.id, name: agent.name, address: agent.smartAccountAddress }).from(agent).where(eq(agent.userId, input.userId))
  const payer = input.requesterAgentId ? mine.find((a) => a.id === input.requesterAgentId) : mine.find((a) => a.address)
  if (!payer?.address) return { ok: false, reason: 'no-agent', message: 'No provisioned agent to pay from — create_worker_agent adds one.' }

  let dbMeta: NotionDatabase
  try {
    dbMeta = await getDatabase(token, databaseId)
  } catch (e) {
    return { ok: false, reason: 'notion', message: `Notion refused the read (${errText(e)}). Share the database with the integration and check the token.` }
  }
  const cap = Number.isFinite(input.maxBountyUsd) && (input.maxBountyUsd as number) > 0 ? (input.maxBountyUsd as number) : MAX_ROW_BOUNTY_USD_DEFAULT
  await pool.query(
    `INSERT INTO notion_desk (user_id, token_enc, token_last4, database_id, database_title, requester_agent_id, max_bounty_usd, enabled, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, NULL)
     ON CONFLICT (user_id) DO UPDATE SET token_enc = EXCLUDED.token_enc, token_last4 = EXCLUDED.token_last4, database_id = EXCLUDED.database_id,
       database_title = EXCLUDED.database_title, requester_agent_id = EXCLUDED.requester_agent_id, max_bounty_usd = EXCLUDED.max_bounty_usd,
       enabled = true, last_error = NULL, updated_at = now()`,
    [input.userId, encryptSecret(token), token.slice(-4), databaseId, databaseTitle(dbMeta), payer.id, cap],
  )
  return { ok: true, databaseTitle: databaseTitle(dbMeta), missing: missingProperties(dbMeta.properties), optional: presentOptional(dbMeta.properties), requesterAgentName: payer.name }
}

export async function setNotionDeskEnabled(userId: string, enabled: boolean): Promise<boolean> {
  await ensureTables()
  const r = await pool.query(`UPDATE notion_desk SET enabled = $2, updated_at = now() WHERE user_id = $1`, [userId, enabled])
  return (r.rowCount ?? 0) > 0
}

export async function disconnectNotionDesk(userId: string): Promise<boolean> {
  await ensureTables()
  const r = await pool.query(`DELETE FROM notion_desk WHERE user_id = $1`, [userId])
  return (r.rowCount ?? 0) > 0
}

async function postedToday(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM notion_desk_row WHERE user_id = $1 AND posted_at > now() - interval '24 hours'`,
    [userId],
  )
  return Number(rows[0]?.n ?? 0)
}

/** The desk as its owner reads it; null when none is connected. */
export async function notionDeskStatus(userId: string): Promise<string | null> {
  await ensureTables()
  const { rows } = await pool.query<DeskRow>(`SELECT * FROM notion_desk WHERE user_id = $1`, [userId])
  const desk = rows[0]
  if (!desk) return null
  const [payer] = await db.select({ name: agent.name }).from(agent).where(eq(agent.id, desk.requester_agent_id))
  let missing: string[] = []
  let optional: string[] = []
  let title = desk.database_title
  try {
    const meta = await getDatabase(decryptSecret(desk.token_enc), desk.database_id)
    missing = missingProperties(meta.properties)
    optional = presentOptional(meta.properties)
    title = databaseTitle(meta)
  } catch (e) {
    missing = [`(could not read the database: ${errText(e)})`]
  }
  return renderDesk({
    databaseId: desk.database_id,
    databaseTitle: title,
    tokenLast4: desk.token_last4,
    requesterAgentName: payer?.name ?? desk.requester_agent_id,
    enabled: desk.enabled,
    maxBountyUsd: Number(desk.max_bounty_usd),
    postedToday: await postedToday(userId),
    lastTickAt: desk.last_tick_at ? new Date(desk.last_tick_at).toISOString() : null,
    lastError: desk.last_error,
    missing,
    optional,
  })
}

/* ── The tick ─────────────────────────────────────────────────────────── */

async function statusKey(schema: Record<string, { type: string }>): Promise<string> {
  return Object.keys(schema).find((k) => k.toLowerCase() === 'status') ?? 'Status'
}

/** Resolve `Agent` (a name) to one of the owner's agents, or null. */
async function agentByName(userId: string, name: string | null): Promise<{ id: string; name: string } | null> {
  if (!name) return null
  const mine = await db.select({ id: agent.id, name: agent.name }).from(agent).where(eq(agent.userId, userId))
  return mine.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null
}

async function postRow(desk: DeskRow, token: string, schema: Record<string, { type: string }>, item: WorkItem): Promise<'posted' | 'refused' | 'failed'> {
  const verdict = checkItem(item, Number(desk.max_bounty_usd))
  if (!verdict.ok) {
    await updatePage(token, item.pageId, rowPatch({ status: STATUS.failed, note: verdict.message }, schema)).catch(() => {})
    return 'refused'
  }
  const reserved = await agentByName(desk.user_id, item.agentName)
  if (item.agentName && !reserved) {
    await updatePage(token, item.pageId, rowPatch({ status: STATUS.failed, note: `No agent of yours is named "${item.agentName}". list_my_agents shows the names.` }, schema)).catch(() => {})
    return 'refused'
  }

  // Off `Ready` before any money moves. A failed write here is a no-op post.
  await updatePage(token, item.pageId, rowPatch({ status: STATUS.posted, note: '' }, schema))

  try {
    if (item.mode === 'session') {
      const { openSession, say } = await import('@/lib/session-server')
      let sessionId = item.sessionId
      let message = item.brief
      if (!sessionId) {
        const opened = await openSession({
          userId: desk.user_id,
          requesterAgentId: desk.requester_agent_id,
          title: item.name,
          standingCriteria: item.criteria,
          turnPriceUsd: item.bountyUsd,
        })
        if (!opened.ok) throw new Error(opened.message)
        sessionId = opened.session.id
      } else {
        message = item.next ?? ''
      }
      const turn = await say({ userId: desk.user_id, sessionId, message })
      if (!turn.ok) throw new Error(turn.message)
      await pool.query(`INSERT INTO notion_desk_row (user_id, page_id, spec_hash, session_id, onchain_job_id, state) VALUES ($1, $2, $3, $4, $5, 'posted')`, [
        desk.user_id,
        item.pageId,
        turn.turn.specHash,
        sessionId,
        turn.turn.onchainJobId,
      ])
      await updatePage(token, item.pageId, rowPatch({ sessionId, jobNumber: turn.turn.onchainJobId, note: '' }, schema)).catch(() => {})
      return 'posted'
    }

    const { postSpecJob } = await import('@/lib/job-post')
    const posted = await postSpecJob({
      payerAgentId: desk.requester_agent_id,
      title: item.name,
      description: item.brief,
      acceptanceCriteria: item.criteria,
      bountyUsd: item.bountyUsd,
      reserveForAgentId: reserved?.id ?? null,
    })
    await pool.query(`INSERT INTO notion_desk_row (user_id, page_id, spec_hash, onchain_job_id, state) VALUES ($1, $2, $3, $4, 'posted')`, [
      desk.user_id,
      item.pageId,
      posted.specHash,
      posted.onchainJobId,
    ])
    await updatePage(token, item.pageId, rowPatch({ jobNumber: posted.onchainJobId, note: '' }, schema)).catch(() => {})
    return 'posted'
  } catch (e) {
    // Back to Ready with the reason: the owner decides whether to try again.
    await updatePage(token, item.pageId, rowPatch({ status: STATUS.ready, note: `Post failed: ${errText(e)}` }, schema)).catch(() => {})
    return 'failed'
  }
}

type TrackedRow = { page_id: string; spec_hash: string | null; session_id: string | null; onchain_job_id: number | null; posted_at: Date }

/** Follow one posted row to its outcome; returns the new state or null when unchanged. */
async function followRow(desk: DeskRow, token: string, schema: Record<string, { type: string }>, row: TrackedRow): Promise<string | null> {
  if (!row.spec_hash) return null
  const { jobSpec, agentTask } = await import('@/lib/db/schema')
  const [spec] = await db.select().from(jobSpec).where(eq(jobSpec.specHash, row.spec_hash))
  if (!spec) return null
  const { readJobs } = await import('@/lib/onchain/labor')
  const jobs = await readJobs().catch(() => null)
  const chain = jobs?.find((j) => j.specHash.toLowerCase() === row.spec_hash!.toLowerCase()) ?? null
  const task = spec.agentTaskId ? (await db.select({ status: agentTask.status, output: agentTask.output }).from(agentTask).where(eq(agentTask.id, spec.agentTaskId)))[0] : undefined
  const { turnOutcomeFrom } = await import('@/lib/session')
  const outcome = turnOutcomeFrom({ chainStatus: chain?.status ?? null, gradePassed: spec.testResult?.passed, taskStatus: task?.status ?? null })
  const jobNumber = chain?.id ?? spec.onchainJobId ?? row.onchain_job_id

  if (outcome === 'working') {
    await updatePage(token, row.page_id, rowPatch({ status: STATUS.working, jobNumber }, schema))
    return 'working'
  }
  if (outcome === 'passed') {
    const result = task?.output ?? ''
    let proofUrl: string | null = null
    if (jobNumber !== null) {
      const { getLatestProofForJob } = await import('@/lib/work-proof-store')
      const proof = await getLatestProofForJob(`#${jobNumber}`)
      if (proof) {
        const { absoluteUrl } = await import('@/lib/origin')
        proofUrl = absoluteUrl(`/proof/${proof.id}`)
      }
    }
    await updatePage(token, row.page_id, rowPatch({ status: STATUS.delivered, jobNumber, result, proofUrl, note: '' }, schema))
    if (result) await appendBlocks(token, row.page_id, resultBlocks(result, row.session_id ? `Delivered — turn (job #${jobNumber ?? '?'})` : 'Delivered')).catch(() => {})
    return 'delivered'
  }
  if (outcome === 'failed' || outcome === 'expired') {
    const why = outcome === 'expired' ? 'The delivery window passed with no accepted deliverable; escrow returned on the job\'s terms.' : `Grading failed: ${(spec.testResult?.output ?? '').slice(0, 600)}`
    await updatePage(token, row.page_id, rowPatch({ status: STATUS.failed, jobNumber, note: why }, schema))
    return 'failed'
  }
  return null
}

/** Every enabled desk, once. Bounded per desk per tick; never throws. */
export async function tickNotionDesks(): Promise<string | Record<string, unknown>> {
  await ensureTables()
  const { rows: desks } = await pool.query<DeskRow>(`SELECT * FROM notion_desk WHERE enabled = true ORDER BY created_at ASC LIMIT 50`)
  if (desks.length === 0) return 'no desks'
  const report: Record<string, unknown> = {}
  for (const desk of desks) {
    const r: Record<string, number | string> = { posted: 0, refused: 0, failed: 0, followed: 0 }
    try {
      const token = decryptSecret(desk.token_enc)
      const meta = await getDatabase(token, desk.database_id)
      const schema = meta.properties
      const missing = missingProperties(schema)
      if (missing.length > 0) {
        r.skipped = `missing columns: ${missing.join(', ')}`
      } else {
        const status = await statusKey(schema)
        // Follow first, so a Delivered row is written before new spending.
        const { rows: tracked } = await pool.query<TrackedRow>(
          `SELECT DISTINCT ON (page_id) page_id, spec_hash, session_id, onchain_job_id, posted_at FROM notion_desk_row
            WHERE user_id = $1 AND state IN ('posted', 'working') ORDER BY page_id, posted_at DESC LIMIT 50`,
          [desk.user_id],
        )
        for (const row of tracked) {
          const next = await followRow(desk, token, schema, row).catch((e) => `error: ${errText(e)}`)
          if (next && !next.startsWith('error')) {
            await pool.query(`UPDATE notion_desk_row SET state = $4, updated_at = now() WHERE user_id = $1 AND page_id = $2 AND posted_at = $3`, [desk.user_id, row.page_id, row.posted_at, next])
            r.followed = Number(r.followed) + 1
          }
        }
        // Then post, under the caps.
        const today = await postedToday(desk.user_id)
        const budget = Math.min(MAX_POSTS_PER_TICK, Math.max(0, MAX_POSTS_PER_DAY - today))
        if (budget > 0) {
          const pages = await queryDatabase<NotionPage>(token, desk.database_id, readyFilter(status), budget)
          for (const page of pages) {
            const item = parsePage(page)
            // A tracked row still in flight is never posted twice, whatever its status says.
            if (tracked.some((t) => t.page_id === item.pageId)) continue
            const outcome = await postRow(desk, token, schema, item)
            r[outcome] = Number(r[outcome]) + 1
          }
        } else {
          r.skipped = `daily cap reached (${today}/${MAX_POSTS_PER_DAY})`
        }
        void inFlightFilter // the desk tracks in-flight rows itself; the filter is for readers who want Notion's view
      }
      await pool.query(`UPDATE notion_desk SET last_tick_at = now(), last_error = NULL, database_title = $2 WHERE user_id = $1`, [desk.user_id, databaseTitle(meta)])
    } catch (e) {
      r.error = errText(e)
      await pool.query(`UPDATE notion_desk SET last_tick_at = now(), last_error = $2 WHERE user_id = $1`, [desk.user_id, errText(e)]).catch(() => {})
    }
    report[desk.user_id.slice(0, 8)] = r
  }
  return report
}
