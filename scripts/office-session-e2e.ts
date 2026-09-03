/**
 * End-to-end: a real office session, a real local worker, a real Claude
 * Code process editing a real git checkout — against a scratch Postgres
 * and the actual Next.js routes.
 *
 *   npx tsx scripts/office-session-e2e.ts <phase> [args]
 *
 * Phases (each is one process, because this container reaps background
 * processes between shell calls; the driver shell script sequences them):
 *
 *   setup <workdir> <verifyCmd>       create user, agent, workspace grant → prints the worker token
 *   start <workdir> <goal> [policy]   create a session and tick it twice → prints the session id
 *   tick <sessionId>                  one heartbeat, prints the status and notes
 *   status <sessionId>                prints the state summary and the integrity check
 *   approve <sessionId>               owner grants every undecided approval
 *   wait <sessionId> <seconds> <status,...>   tick until the session reaches one of the statuses
 *
 * Every write goes through lib/office-session-server.ts exactly as the
 * app's actions do; nothing is seeded — the user and agent rows are the
 * same rows sign-up would create. No chain is touched: the session's tasks
 * are internal (the office's own worker), so no escrow is posted and no
 * money can move.
 */
import { pool, db } from '@/lib/db'
import { agent, user } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'

const [phase, ...args] = process.argv.slice(2)
const USER_ID = process.env.E2E_USER_ID ?? 'e2e-user'
const AGENT_ID = process.env.E2E_AGENT_ID ?? 'e2e-agent'

async function ensureUserAndAgent(): Promise<void> {
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, USER_ID))
  if (!u) {
    await db.insert(user).values({ id: USER_ID, email: `e2e-${nanoid(6)}@example.invalid`, name: 'E2E owner' } as never)
  }
  const [a] = await db.select({ id: agent.id }).from(agent).where(eq(agent.id, AGENT_ID))
  if (!a) {
    await db.insert(agent).values({ id: AGENT_ID, userId: USER_ID, name: 'Claude Code (local)', runtimeType: 'local', walletAddress: `0x${'1'.repeat(40)}` } as never)
  }
}

async function main(): Promise<void> {
  const os = await import('@/lib/office-session-server')
  if (phase === 'setup') {
    const [workdir, verify] = args
    await ensureUserAndAgent()
    const { connectLocalWorker } = await import('@/lib/local-worker-connect')
    const conn = await connectLocalWorker(USER_ID, AGENT_ID)
    if (!conn) throw new Error('connect failed')
    const { DEFAULT_WORKSPACE_GRANT } = await import('@/lib/office-session')
    await os.setWorkerGrant(USER_ID, AGENT_ID, 1, { workdir, ...DEFAULT_WORKSPACE_GRANT }, verify || null)
    console.log(`TOKEN=${conn.token}`)
    return
  }
  if (phase === 'start') {
    const [workdir, goal, policyName] = args
    if (policyName === 'lenient') {
      const { DEFAULT_APPROVAL_POLICY } = await import('@/lib/approval-policy')
      const r = await os.setOfficePolicy(USER_ID, 1, { ...DEFAULT_APPROVAL_POLICY, id: 'office', requireReviewer: [], autoApprove: DEFAULT_APPROVAL_POLICY.autoApprove.filter((c) => c.field !== 'reviewerVerdict') })
      if (!r.ok) throw new Error(r.error)
    } else if (policyName === 'default') {
      const { DEFAULT_APPROVAL_POLICY } = await import('@/lib/approval-policy')
      const r = await os.setOfficePolicy(USER_ID, 1, { ...DEFAULT_APPROVAL_POLICY, id: 'office' })
      if (!r.ok) throw new Error(r.error)
    }
    const grant = await os.getWorkerGrant(AGENT_ID)
    const session = await os.createOfficeSession({
      userId: USER_ID,
      slot: 1,
      kind: 'local_coding',
      goal,
      budgetLimitUsd: 5,
      workerAgentId: AGENT_ID,
      workspace: grant?.grant ?? null,
      verifyCommand: grant?.verifyCommand ?? null,
    })
    const t1 = await os.tickOfficeSession(session.id)
    const t2 = await os.tickOfficeSession(session.id)
    console.log(`SESSION=${session.id}`)
    console.log(`tick1: ${t1.status} ${t1.notes.join(' | ')}`)
    console.log(`tick2: ${t2.status} ${t2.notes.join(' | ')}`)
    void workdir
    return
  }
  if (phase === 'remote-setup') {
    // A webhook-runtime agent on the same account: the platform POSTs the
    // brief to <url> and the server there calls back with the output. The
    // secret is printed so the stand-in server can authenticate its callback.
    const [url] = args
    await ensureUserAndAgent()
    const { generateWebhookSecret, encryptWebhookSecret } = await import('@/lib/webhook')
    const secret = generateWebhookSecret()
    const [a] = await db.select({ id: agent.id }).from(agent).where(eq(agent.id, 'e2e-hook'))
    if (!a) await db.insert(agent).values({ id: 'e2e-hook', userId: USER_ID, name: 'Hook worker (webhook)', runtimeType: 'webhook', walletAddress: `0x${'2'.repeat(40)}` } as never)
    await db.update(agent).set({ runtimeType: 'webhook', webhookUrl: url, webhookSecretEnc: encryptWebhookSecret(secret), updatedAt: new Date() }).where(eq(agent.id, 'e2e-hook'))
    console.log(`SECRET=${secret}`)
    return
  }
  if (phase === 'start-remote') {
    // No workspace, no bound worker: the loop must pick the remote agent
    // (or the local one if it is online and better).
    const [goal, kindArg, policyName, triggersArg] = args
    if (policyName === 'lenient') {
      const { DEFAULT_APPROVAL_POLICY } = await import('@/lib/approval-policy')
      const r = await os.setOfficePolicy(USER_ID, 1, { ...DEFAULT_APPROVAL_POLICY, id: 'office', requireReviewer: [], autoApprove: DEFAULT_APPROVAL_POLICY.autoApprove.filter((c) => c.field !== 'reviewerVerdict') })
      if (!r.ok) throw new Error(r.error)
    }
    const { parseTriggerList } = await import('@/lib/session-triggers')
    const session = await os.createOfficeSession({
      userId: USER_ID,
      slot: 1,
      kind: (kindArg as 'long_running') || 'long_running',
      goal,
      budgetLimitUsd: 5,
      workerAgentId: null,
      workspace: null,
      triggers: parseTriggerList(triggersArg ?? ''),
    })
    const t1 = await os.tickOfficeSession(session.id)
    const t2 = await os.tickOfficeSession(session.id)
    console.log(`SESSION=${session.id}`)
    console.log(`tick1: ${t1.status} ${t1.notes.join(' | ')}`)
    console.log(`tick2: ${t2.status} ${t2.notes.join(' | ')}`)
    return
  }
  if (phase === 'pause' || phase === 'resume') {
    const st = phase === 'pause' ? await os.pauseOfficeSession(USER_ID, args[0], 'e2e pause') : await os.resumeOfficeSession(USER_ID, args[0])
    const { rows } = await pool.query<{ run_id: string; status: string; paused: boolean }>(`SELECT run_id, status, paused FROM office_session_dispatch WHERE session_id = $1`, [args[0]])
    console.log(`${phase}d: ${st.session.status}; dispatch rows: ${rows.map((r) => `${r.run_id}=${r.status}${r.paused ? '(paused)' : ''}`).join(', ')}`)
    return
  }
  if (phase === 'tick') {
    const r = await os.tickOfficeSession(args[0])
    console.log(`${r.status}: ${r.notes.join(' | ')}${r.skipped ? ` (${r.skipped})` : ''}`)
    return
  }
  if (phase === 'approve') {
    const state = await os.loadSessionState(args[0])
    for (const a of Object.values(state.approvals)) {
      if (a.decidedAt === null) {
        await os.decideApproval(USER_ID, args[0], a.id, true, 'e2e owner approval')
        console.log(`approved ${a.id} (${a.policyOutcome}: ${a.reasons.join('; ')})`)
      }
    }
    return
  }
  if (phase === 'wait') {
    const [id, secs, statuses] = args
    const want = new Set(statuses.split(','))
    const until = Date.now() + Number(secs) * 1000
    while (Date.now() < until) {
      const r = await os.tickOfficeSession(id)
      if (want.has(r.status)) {
        console.log(`reached ${r.status}`)
        return
      }
      await new Promise((res) => setTimeout(res, 4000))
    }
    const state = await os.loadSessionState(id)
    console.log(`TIMEOUT in ${state.session.status}: ${state.session.statusReason ?? ''}`)
    process.exitCode = 2
    return
  }
  if (phase === 'status') {
    const state = await os.loadSessionState(args[0])
    const integrity = await os.verifySessionIntegrity(args[0])
    const s = state.session
    console.log(`session ${s.id}: ${s.status}${s.statusReason ? ` — ${s.statusReason}` : ''} (wave ${s.wave}, spent $${s.spentUsd}, checkpoint ${s.checkpointId ?? '-'})`)
    for (const t of Object.values(state.tasks)) {
      console.log(`  task ${t.id}: ${t.status} attempts=${t.attempts} files=${t.outcome?.changedFiles.length ?? 0} tests=${t.outcome?.tests ? (t.outcome.tests.passed ? 'pass' : `fail(${t.outcome.tests.exitCode})`) : '-'} review=${t.outcome?.review ? String(t.outcome.review.approve) : '-'} hash=${t.outcome?.contentHash?.slice(0, 12) ?? '-'}`)
    }
    for (const r of Object.values(state.runs)) {
      console.log(`  run ${r.id}: ${r.status} worker=${r.workerAgentId} attempt=${r.attempt} resumedFrom=${r.resumedFromCheckpointId ?? '-'} checkpoint=${r.checkpointId ?? '-'} files=${r.changedFiles.length} cost=${r.costUsd ?? '-'} exit=${r.exitCode ?? '-'}`)
    }
    for (const a of Object.values(state.approvals)) {
      console.log(`  approval ${a.id}: ${a.policyOutcome} decidedBy=${a.decidedBy ?? '-'} granted=${a.granted} moved=${a.moved ? a.moved.amountUsd : 'nothing'} reasons=${a.reasons.join('; ')}`)
    }
    for (const c of Object.values(state.checkpoints)) console.log(`  checkpoint ${c.id}: seq=${c.seq} files=${c.filesChanged.length} patch=${c.patch ? c.patch.length : 0}B`)
    for (const a of Object.values(state.artifacts)) console.log(`  artifact ${a.kind} ${a.name} ${a.bytes}B sha256=${a.sha256.slice(0, 12)}`)
    const { rows } = await pool.query<{ type: string; n: string }>(`SELECT type, COUNT(*)::text AS n FROM office_session_event WHERE session_id = $1 GROUP BY type ORDER BY MIN(seq)`, [args[0]])
    console.log(`  events: ${rows.map((r) => `${r.type}×${r.n}`).join(', ')}`)
    console.log(`  integrity: ${integrity.ok ? 'replay matches materialized state' : `MISMATCH ${JSON.stringify(integrity)}`}`)
    if (!integrity.ok) process.exitCode = 3
    return
  }
  throw new Error(`unknown phase ${phase}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => pool.end().catch(() => undefined))
