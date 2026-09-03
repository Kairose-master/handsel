'use server'
/**
 * Office sessions — the owner's levers and the control room's reads.
 *
 * Every action authenticates, then delegates to lib/office-session-server.ts.
 * Nothing here decides anything about a session: the loop decides, the
 * policy decides, and the owner decides through `decideApproval`. What this
 * file adds is the one-click connect flow (`connectWorkspaceWorker`), which
 * is three existing acts in one — flip the agent to a local worker, record
 * its workspace grant, hand back the command — because the product promise
 * is "connect once", not "assemble a command line".
 */
import { getSession } from '@/lib/get-session'
import type { ApprovalPolicy } from '@/lib/approval-policy'
import type { OfficeSession, SessionEvent, SessionKind, SessionSchedule, SessionState, WorkspaceGrant } from '@/lib/office-session'
import type { RunLogLine, SessionListRow, WorkerGrantRow } from '@/lib/office-session-server'
import type { SessionLesson } from '@/lib/office-session-loop'
import type { BindingInput, SessionToolBinding } from '@/lib/session-tools'

async function requireUser() {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user
}

export type SessionOverview = {
  sessions: SessionListRow[]
  inbox: Array<{ sessionId: string; sessionGoal: string; taskId: string; taskTitle: string; approvalId: string; outcome: string; reasons: string[]; amountUsd: number; requestedAt: number; changedFiles: string[]; diff: string | null; evidence: Record<string, unknown> }>
  workers: Array<WorkerGrantRow & { name: string; alive: boolean; harnessId: string | null; lastPollAt: number | null }>
  policy: ApprovalPolicy
  policyText: string
  memory: SessionLesson[]
  tools: SessionToolBinding[]
  spentTodayUsd: number
  autoApprovedTodayUsd: number
  realMoney: boolean
  chainName: string
  slot: number
}

export async function officeSessionOverview(slot = 1): Promise<SessionOverview> {
  const user = await requireUser()
  const os = await import('@/lib/office-session-server')
  const { renderPolicy } = await import('@/lib/approval-policy')
  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const { classifyWorker } = await import('@/lib/worker-fleet')
  const { harnessesFor } = await import('@/lib/agent-harness-server')
  const { isRealMoney } = await import('@/lib/onchain/real-money')
  const { CHAIN } = await import('@/lib/onchain/config')

  const [sessions, inboxRaw, grants, policy, memory, tools] = await Promise.all([
    os.listOfficeSessions(user.id, slot),
    os.approvalInbox(user.id),
    os.workerGrantsFor(user.id, slot),
    os.getOfficePolicy(user.id, slot),
    os.getSessionMemory(user.id, slot),
    os.sessionToolBindings(user.id, slot).catch(() => [] as SessionToolBinding[]),
  ])
  const agents = await db
    .select({ id: agent.id, name: agent.name, runtimeType: agent.runtimeType, lastPollAt: agent.lastPollAt, webhookSecretEnc: agent.webhookSecretEnc, autoMine: agent.autoMine })
    .from(agent)
    .where(eq(agent.userId, user.id))
  const harness = await harnessesFor(agents.map((a) => a.id)).catch(() => new Map<string, string>())
  const now = new Date()
  const workers = grants.map((g) => {
    const a = agents.find((x) => x.id === g.agentId)
    const status = a
      ? classifyWorker({ runtimeType: a.runtimeType, lastPollAt: a.lastPollAt, provisioned: true, hasKey: Boolean(a.webhookSecretEnc), autoMine: a.autoMine }, now)
      : null
    return { ...g, name: a?.name ?? g.agentId, alive: status?.phase === 'Ready', harnessId: harness.get(g.agentId) ?? null, lastPollAt: a?.lastPollAt ? a.lastPollAt.getTime() : null }
  })
  const { pool } = await import('@/lib/db')
  const spent = await pool
    .query<{ total: string | null; auto: string | null }>(
      `SELECT COALESCE(SUM((e.payload->>'amountUsd')::numeric), 0)::text AS total,
              COALESCE(SUM(CASE WHEN a.payload->>'decidedBy' = 'policy' THEN (e.payload->>'amountUsd')::numeric ELSE 0 END), 0)::text AS auto
         FROM office_session_event e
         JOIN office_session s ON s.id = e.session_id
         LEFT JOIN office_session_event a ON a.session_id = e.session_id AND a.type = 'APPROVAL_GRANTED' AND a.payload->>'approvalId' = e.payload->>'approvalId'
        WHERE s.user_id = $1 AND s.slot = $2 AND e.type = 'PAYMENT_SETTLED' AND e.occurred_at > now() - interval '24 hours'`,
      [user.id, slot],
    )
    .then((r) => ({ total: Number(r.rows[0]?.total ?? 0) || 0, auto: Number(r.rows[0]?.auto ?? 0) || 0 }))
    .catch(() => ({ total: 0, auto: 0 }))
  return {
    tools,
    sessions,
    inbox: inboxRaw
      .filter((i) => i.session.officeSlot === slot)
      .map((i) => ({
        sessionId: i.session.id,
        sessionGoal: i.session.goal,
        taskId: i.task.id,
        taskTitle: i.task.title,
        approvalId: i.approval.id,
        outcome: i.approval.policyOutcome,
        reasons: i.approval.reasons,
        amountUsd: i.approval.amountUsd,
        requestedAt: i.approval.requestedAt,
        changedFiles: i.task.outcome?.changedFiles ?? [],
        diff: i.task.outcome?.diff ? i.task.outcome.diff.slice(0, 20_000) : null,
        evidence: i.approval.evidence,
      })),
    workers,
    policy,
    policyText: renderPolicy(policy),
    memory,
    spentTodayUsd: spent.total,
    autoApprovedTodayUsd: spent.auto,
    realMoney: isRealMoney(),
    chainName: CHAIN.name,
    slot,
  }
}

export type SessionDetail = { state: SessionState; events: SessionEvent[]; runLog: RunLogLine[]; integrity: { ok: boolean; violations: string[] } | null }

export async function officeSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const user = await requireUser()
  const os = await import('@/lib/office-session-server')
  const read = await os.readOfficeSession(user.id, sessionId)
  if (!read) return null
  const integrity = await os.verifySessionIntegrity(sessionId).then((r) => ({ ok: r.ok, violations: r.violations })).catch(() => null)
  return { ...read, integrity }
}

export type StartSessionInput = {
  slot: number
  kind: SessionKind
  goal: string
  budgetLimitUsd: number
  workerAgentId: string | null
  payerAgentId?: string | null
  verifyCommand?: string | null
  deadlineHours?: number | null
  schedule?: SessionSchedule | null
  triggers?: string[]
}

/** Create and immediately tick: the first heartbeat plans, the second dispatches. */
import { parseTriggerList } from '@/lib/session-triggers'

export async function startOfficeSession(input: StartSessionInput): Promise<{ ok: true; session: OfficeSession } | { ok: false; error: string }> {
  const user = await requireUser()
  const goal = String(input.goal ?? '').trim()
  if (goal.length < 10) return { ok: false, error: 'Say what the office should achieve (at least 10 characters).' }
  if (goal.length > 8000) return { ok: false, error: 'Keep the goal under 8,000 characters.' }
  const budget = Number(input.budgetLimitUsd)
  if (!Number.isFinite(budget) || budget < 0 || budget > 1000) return { ok: false, error: 'Budget must be between $0 and $1,000.' }
  const os = await import('@/lib/office-session-server')
  let workspace: WorkspaceGrant | null = null
  if (input.workerAgentId) {
    const grant = await os.getWorkerGrant(input.workerAgentId)
    if (!grant || grant.userId !== user.id) return { ok: false, error: 'That worker has no workspace grant. Connect it first.' }
    workspace = grant.grant
  }
  if (input.kind === 'local_coding' && !workspace) return { ok: false, error: 'A local coding session needs a connected worker with a workspace.' }
  if (input.kind === 'event_driven' && parseTriggerList((input.triggers ?? []).join(',')).length === 0) {
    return { ok: false, error: 'An event-driven session needs at least one trigger, e.g. github:owner/repo:issues.opened or http:nightly.' }
  }
  const session = await os.createOfficeSession({
    userId: user.id,
    slot: input.slot,
    kind: input.kind,
    goal,
    budgetLimitUsd: budget,
    deadlineAt: input.deadlineHours ? Date.now() + input.deadlineHours * 3_600_000 : null,
    schedule: input.schedule ?? null,
    triggers: parseTriggerList((input.triggers ?? []).join(',')),
    workerAgentId: input.workerAgentId ?? null,
    payerAgentId: input.payerAgentId ?? null,
    workspace,
    verifyCommand: input.verifyCommand ?? null,
  })
  // Two ticks: plan, then dispatch. Errors here are reported, not thrown —
  // the cron picks the session up either way.
  await os.tickOfficeSession(session.id).catch((e) => console.error('[office-session] first tick failed:', e))
  await os.tickOfficeSession(session.id).catch((e) => console.error('[office-session] second tick failed:', e))
  return { ok: true, session }
}

/**
 * Bind an external MCP server to this office — a `consult` tool asked before
 * each task, or a `notify` tool told when a chosen event happens. The
 * validation lives in `lib/session-tools.ts`; this is the owner check.
 */
export async function attachOfficeTool(input: BindingInput & { authHeader?: string | null }): Promise<{ ok: true; binding: SessionToolBinding } | { ok: false; error: string }> {
  const user = await requireUser()
  const os = await import('@/lib/office-session-server')
  return os.attachSessionTool(user.id, input)
}

export async function detachOfficeTool(id: string): Promise<{ ok: boolean }> {
  const user = await requireUser()
  const os = await import('@/lib/office-session-server')
  return { ok: await os.detachSessionTool(user.id, id) }
}

export async function decideSessionApproval(sessionId: string, approvalId: string, granted: boolean, reason?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser()
  const os = await import('@/lib/office-session-server')
  try {
    await os.decideApproval(user.id, sessionId, approvalId, granted, reason)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function pauseSession(sessionId: string): Promise<void> {
  const user = await requireUser()
  await (await import('@/lib/office-session-server')).pauseOfficeSession(user.id, sessionId)
}
export async function resumeSession(sessionId: string): Promise<void> {
  const user = await requireUser()
  await (await import('@/lib/office-session-server')).resumeOfficeSession(user.id, sessionId)
}
export async function cancelSession(sessionId: string): Promise<void> {
  const user = await requireUser()
  await (await import('@/lib/office-session-server')).cancelOfficeSession(user.id, sessionId)
}
export async function raiseBudget(sessionId: string, budgetLimitUsd: number): Promise<void> {
  const user = await requireUser()
  await (await import('@/lib/office-session-server')).raiseSessionBudget(user.id, sessionId, Number(budgetLimitUsd))
}
export async function tickSessionNow(sessionId: string): Promise<{ status: string; notes: string[] }> {
  const user = await requireUser()
  const os = await import('@/lib/office-session-server')
  const state = await os.loadSessionState(sessionId)
  if (state.session.userId !== user.id) throw new Error('Unauthorized')
  const r = await os.tickOfficeSession(sessionId)
  return { status: r.status, notes: r.notes }
}

export async function saveOfficePolicy(slot: number, raw: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const user = await requireUser()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'The policy must be valid JSON.' }
  }
  const os = await import('@/lib/office-session-server')
  const res = await os.setOfficePolicy(user.id, slot, parsed)
  if (!res.ok) return res
  const { renderPolicy } = await import('@/lib/approval-policy')
  return { ok: true, text: renderPolicy(res.policy) }
}

export type ConnectWorkspaceInput = {
  agentId: string
  slot: number
  workdir: string
  grant: Omit<WorkspaceGrant, 'workdir'>
  verifyCommand: string | null
}

/**
 * The one-click connect: flip the agent to a local worker (rotating its
 * secret, like every connect), store the workspace grant the owner chose,
 * and return the exact command to run. The grant is what a session run
 * will be allowed to do; the command is the only thing the owner types.
 */
export async function connectWorkspaceWorker(input: ConnectWorkspaceInput): Promise<{ ok: true; command: string; token: string; grant: WorkspaceGrant } | { ok: false; error: string }> {
  const user = await requireUser()
  const workdir = String(input.workdir ?? '').trim()
  if (!workdir || workdir.length > 400 || /[\n\r]/.test(workdir)) return { ok: false, error: 'Give the working directory as one absolute path.' }
  const g = input.grant
  const grant: WorkspaceGrant = {
    workdir,
    write: g.write !== false,
    shell: Boolean(g.shell),
    network: Boolean(g.network),
    install: Boolean(g.install),
    secrets: false, // never grantable from this surface
    gitPush: Boolean(g.gitPush),
    externalPayments: false,
    perTaskLimitUsd: Math.max(0, Math.min(100, Number(g.perTaskLimitUsd) || 0)),
    dailyLimitUsd: Math.max(0, Math.min(1000, Number(g.dailyLimitUsd) || 0)),
  }
  const verifyCommand = input.verifyCommand && input.verifyCommand.trim() ? input.verifyCommand.trim().slice(0, 300) : null
  const { connectLocalWorker } = await import('@/lib/local-worker-connect')
  const conn = await connectLocalWorker(user.id, input.agentId)
  if (!conn) return { ok: false, error: 'Not your agent.' }
  const os = await import('@/lib/office-session-server')
  await os.setWorkerGrant(user.id, input.agentId, input.slot, grant, verifyCommand)
  const command = `npx handsel-worker --token ${conn.token} --workdir ${shellQuote(workdir)} --harness claude`
  return { ok: true, command, token: conn.token, grant }
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./~]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export async function myLocalAgents(): Promise<Array<{ id: string; name: string; runtimeType: string | null }>> {
  const user = await requireUser()
  const { db } = await import('@/lib/db')
  const { agent } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const rows = await db.select({ id: agent.id, name: agent.name, runtimeType: agent.runtimeType }).from(agent).where(eq(agent.userId, user.id))
  return rows
}
