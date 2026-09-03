/**
 * MCP tools — office sessions (lib/office-session.ts, docs/office-sessions.md).
 *
 * The same control room `/office/sessions` shows, from inside Claude or
 * ChatGPT: start a goal, read where it is, answer an approval, pause /
 * resume / cancel, and fire a trigger. Money moves through none of these
 * directly — an approval granted here is the owner's click, which the
 * loop settles through the one existing release site, and a trigger only
 * starts a session's next wave from its own budget.
 */
import { toolText, type McpToolContext } from '../rpc'
import { STATUS_META, sessionSentence, type SessionKind, type SessionState } from '@/lib/office-session'
import { parseTriggerList, httpTrigger } from '@/lib/session-triggers'
import { NOTIFIABLE_EVENTS, describeBinding } from '@/lib/session-tools'

const KINDS: SessionKind[] = ['one_shot', 'long_running', 'scheduled', 'event_driven', 'local_coding']

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

function money(n: number): string {
  return `$${n.toFixed(2)}`
}

function taskLines(state: SessionState): string {
  const tasks = Object.values(state.tasks).sort((a, b) => a.createdAt - b.createdAt)
  if (tasks.length === 0) return '  (no plan yet)'
  return tasks
    .map((t) => {
      const run = t.currentRunId ? state.runs[t.currentRunId] : null
      const tail = run ? ` · run ${run.status}${run.workerAgentId ? ` on ${run.workerAgentId}` : ''}` : ''
      return `  - [${t.status}] ${t.title} (${t.kind}, ${t.riskTier}, ${money(t.bountyUsd)}, attempt ${t.attempts}/${t.maxAttempts})${tail}${t.statusReason ? ` — ${t.statusReason}` : ''}`
    })
    .join('\n')
}

function approvalLines(state: SessionState): string {
  const open = Object.values(state.approvals).filter((a) => a.decidedAt === null && (a.policyOutcome === 'REQUIRE_OWNER' || a.policyOutcome === 'REQUIRE_REVIEWER'))
  if (open.length === 0) return ''
  return (
    '\nWaiting on you:\n' +
    open
      .map((a) => {
        const t = state.tasks[a.taskId]
        return `  - approval ${a.id} · "${t?.title ?? a.taskId}" · ${money(a.amountUsd)} · ${t?.riskTier ?? '?'} · ${a.policyOutcome}\n    ${a.reasons.join('; ')}`
      })
      .join('\n') +
    '\n  → decide_session_approval { session_id, approval_id, granted }'
  )
}

export async function handleOfficeSessions(ctx: McpToolContext, name: string, args: Record<string, unknown>): Promise<Response | null> {
  const { id, auth } = ctx
  switch (name) {
    case 'start_office_session': {
      const kind = String(args.kind ?? 'long_running') as SessionKind
      if (!KINDS.includes(kind)) return toolText(id, `kind must be one of ${KINDS.join(', ')}`, true)
      const goal = String(args.goal ?? '').trim()
      if (goal.length < 10) return toolText(id, 'Say what the office should achieve (at least 10 characters).', true)
      if (goal.length > 8000) return toolText(id, 'Keep the goal under 8,000 characters.', true)
      const budget = num(args.budget_usd, NaN)
      if (!Number.isFinite(budget) || budget < 0 || budget > 1000) return toolText(id, 'budget_usd must be between 0 and 1000.', true)
      const slot = Math.max(1, Math.min(3, Math.floor(num(args.office, 1))))
      const os = await import('@/lib/office-session-server')
      const workerAgentId = typeof args.worker_agent_id === 'string' && args.worker_agent_id ? args.worker_agent_id : null
      let workspace = null
      if (workerAgentId) {
        const grant = await os.getWorkerGrant(workerAgentId)
        if (!grant || grant.userId !== auth.userId) return toolText(id, 'That worker has no workspace grant on this account. connect_local_worker with a workdir first, or connect it on /office/sessions.', true)
        workspace = grant.grant
      }
      if (kind === 'local_coding' && !workspace) return toolText(id, 'A local coding session needs worker_agent_id — a connected local worker with a workspace grant.', true)
      const triggers = parseTriggerList(Array.isArray(args.triggers) ? args.triggers.map(String).join(',') : String(args.triggers ?? ''))
      if (kind === 'event_driven' && triggers.length === 0) {
        return toolText(id, 'An event-driven session needs triggers, e.g. ["github:owner/repo:issues.opened", "http:nightly"].', true)
      }
      const everyMin = num(args.every_minutes, 0)
      if (kind === 'scheduled' && everyMin < 1) return toolText(id, 'A scheduled session needs every_minutes (≥ 1).', true)
      const deadlineHours = num(args.deadline_hours, 0)
      const session = await os.createOfficeSession({
        userId: auth.userId,
        slot,
        kind,
        goal,
        budgetLimitUsd: budget,
        deadlineAt: deadlineHours > 0 ? Date.now() + deadlineHours * 3_600_000 : null,
        schedule: kind === 'scheduled' ? { kind: 'interval', everyMs: everyMin * 60_000 } : null,
        triggers,
        workerAgentId,
        workspace,
        verifyCommand: typeof args.verify_command === 'string' && args.verify_command ? args.verify_command.slice(0, 300) : null,
      })
      await os.tickOfficeSession(session.id).catch((e) => console.error('[mcp/office-session] first tick failed:', e))
      const after = await os.tickOfficeSession(session.id).catch((e) => {
        console.error('[mcp/office-session] second tick failed:', e)
        return null
      })
      const state = await os.loadSessionState(session.id)
      return toolText(
        id,
        `🏢 Office session ${session.id} started (${kind}, office ${slot}, budget ${money(budget)}).\n` +
          `Now: ${sessionSentence(state.session)}\n` +
          (after?.notes.length ? `Loop: ${after.notes.join('; ')}\n` : '') +
          `Plan:\n${taskLines(state)}` +
          approvalLines(state) +
          `\n\nWatch it with office_session_status { session_id: "${session.id}" } or on /office/sessions/${session.id}.` +
          (kind === 'event_driven' ? `\nIt wakes on: ${triggers.join(', ')}.` : ''),
      )
    }

    case 'office_session_status': {
      const os = await import('@/lib/office-session-server')
      const sessionId = typeof args.session_id === 'string' ? args.session_id : ''
      if (!sessionId) {
        const slot = args.office === undefined ? undefined : Math.max(1, Math.min(3, Math.floor(num(args.office, 1))))
        const rows = await os.listOfficeSessions(auth.userId, slot, 30)
        const inbox = await os.approvalInbox(auth.userId)
        if (rows.length === 0) return toolText(id, 'No office sessions yet. start_office_session gives the office a goal to pursue.')
        const lines = rows.map(
          (r) =>
            `- ${r.id} · ${r.kind} · ${r.status}${r.statusReason ? ` (${r.statusReason})` : ''} · ${money(r.spentUsd)} of ${money(r.budgetLimitUsd)} · ` +
            `${r.tasksDone}/${r.tasksTotal} tasks${r.openApprovals ? ` · ${r.openApprovals} awaiting you` : ''}${r.liveRuns ? ` · ${r.liveRuns} live` : ''}\n  ${r.goal.slice(0, 140)}`,
        )
        return toolText(
          id,
          `Office sessions (${rows.length}):\n${lines.join('\n')}` +
            (inbox.length
              ? `\n\nApproval inbox (${inbox.length}):\n` +
                inbox.map((i) => `- ${i.session.id} / ${i.approval.id} · "${i.task.title}" · ${money(i.approval.amountUsd)} · ${i.task.riskTier}\n  ${i.approval.reasons.join('; ')}`).join('\n') +
                '\n→ decide_session_approval { session_id, approval_id, granted }'
              : ''),
        )
      }
      const detail = await os.readOfficeSession(auth.userId, sessionId)
      if (!detail) return toolText(id, `No session ${sessionId} on this account.`, true)
      const { state, events, runLog } = detail
      const s = state.session
      const meta = STATUS_META[s.status]
      const recent = events.slice(-12).map((e) => `  ${new Date(e.occurredAt).toISOString().slice(11, 19)} ${e.type}${e.type === 'SESSION_WAITING' || e.type === 'SESSION_ESCALATED' ? ` — ${String(e.payload.reason ?? '')}` : ''}`)
      const live = runLog.slice(-8).map((l) => `  ${l.kind}: ${l.text.slice(0, 160)}`)
      const artifacts = Object.values(state.artifacts).slice(-10).map((a) => `  - ${a.kind} ${a.name} sha256:${a.sha256.slice(0, 12)}…${a.ref ? ` ${a.ref}` : ''}`)
      return toolText(
        id,
        `${s.id} · ${s.kind} · ${s.status}${s.statusReason ? ` (${s.statusReason})` : ''}\n` +
          `${sessionSentence(s)}\n` +
          `Goal: ${s.goal.slice(0, 600)}\n` +
          `Budget: ${money(s.spentUsd)} spent of ${money(s.budgetLimitUsd)} · wave ${s.wave}` +
          (s.nextWakeAt ? ` · next check ${new Date(s.nextWakeAt).toISOString()}` : '') +
          (s.triggers.length ? ` · wakes on ${s.triggers.join(', ')}` : '') +
          `\nMoney may move: ${meta.moneyMayMove ? 'yes' : 'no'} · automatable: ${meta.automatable ? 'yes' : 'no'} · next heartbeat: ${meta.onHeartbeat}\n` +
          `Tasks:\n${taskLines(state)}` +
          approvalLines(state) +
          (artifacts.length ? `\nArtifacts:\n${artifacts.join('\n')}` : '') +
          (live.length ? `\nLive run (last lines):\n${live.join('\n')}` : '') +
          `\nTimeline (last ${recent.length} of ${events.length}):\n${recent.join('\n')}`,
      )
    }

    case 'decide_session_approval': {
      const os = await import('@/lib/office-session-server')
      const sessionId = String(args.session_id ?? '')
      const approvalId = String(args.approval_id ?? '')
      if (!sessionId || !approvalId) return toolText(id, 'session_id and approval_id are required.', true)
      const granted = args.granted === true
      try {
        const state = await os.decideApproval(auth.userId, sessionId, approvalId, granted, typeof args.reason === 'string' ? args.reason.slice(0, 500) : undefined)
        const a = state.approvals[approvalId]
        return toolText(
          id,
          `${granted ? '✅ Approved' : '⛔ Denied'} ${approvalId} on ${sessionId}${a ? ` — "${state.tasks[a.taskId]?.title ?? a.taskId}" (${money(a.amountUsd)}, ${state.tasks[a.taskId]?.riskTier ?? '?'})` : ''}.\n` +
            `Now: ${sessionSentence(state.session)}` +
            (granted && a && state.tasks[a.taskId]?.settlement === 'escrow' ? '\nThe escrow releases through the market\'s own release path on the next heartbeat; PAYMENT_SETTLED appears on the timeline when it has.' : ''),
        )
      } catch (e) {
        return toolText(id, `Decision refused: ${e instanceof Error ? e.message : String(e)}`, true)
      }
    }

    case 'control_office_session': {
      const os = await import('@/lib/office-session-server')
      const sessionId = String(args.session_id ?? '')
      const action = String(args.action ?? '')
      if (!sessionId) return toolText(id, 'session_id is required.', true)
      try {
        switch (action) {
          case 'pause': {
            const st = await os.pauseOfficeSession(auth.userId, sessionId, typeof args.reason === 'string' ? args.reason.slice(0, 300) : 'paused via MCP')
            return toolText(id, `⏸ ${sessionId} paused. A live harness process is stopped on the worker at its next poll; nothing new is dispatched.\nNow: ${sessionSentence(st.session)}`)
          }
          case 'resume': {
            const st = await os.resumeOfficeSession(auth.userId, sessionId)
            return toolText(id, `▶ ${sessionId} resumed.\nNow: ${sessionSentence(st.session)}`)
          }
          case 'cancel': {
            const st = await os.cancelOfficeSession(auth.userId, sessionId, typeof args.reason === 'string' ? args.reason.slice(0, 300) : 'cancelled via MCP')
            return toolText(id, `⏹ ${sessionId} cancelled. Live runs are told to stop on their next poll.\nNow: ${sessionSentence(st.session)}`)
          }
          case 'raise_budget': {
            const budget = num(args.budget_usd, NaN)
            if (!Number.isFinite(budget) || budget <= 0 || budget > 1000) return toolText(id, 'budget_usd must be between 0 and 1000.', true)
            const st = await os.raiseSessionBudget(auth.userId, sessionId, budget)
            return toolText(id, `💵 ${sessionId} budget is now ${money(st.session.budgetLimitUsd)}.\nNow: ${sessionSentence(st.session)}`)
          }
          case 'tick': {
            const r = await os.tickOfficeSession(sessionId)
            return toolText(id, `Heartbeat on ${sessionId}: ${r.status}${r.skipped ? ` (skipped: ${r.skipped})` : ''} · ${r.events} events · ${r.commands} commands\n${r.notes.map((n) => `- ${n}`).join('\n')}`)
          }
          case 'trigger': {
            const trigger = typeof args.trigger === 'string' ? httpTrigger(args.trigger) : null
            if (!trigger) return toolText(id, 'trigger must be a short name (letters, digits, . _ - /).', true)
            const woke = await os.fireSessionTriggers([trigger], auth.userId)
            return toolText(id, `Fired ${trigger}: ${woke} event-driven session(s) woke.${woke === 0 ? ' A session wakes only if it listed this name (or a matching prefix:*).' : ''}`)
          }
          default:
            return toolText(id, 'action must be one of pause, resume, cancel, raise_budget, tick, trigger.', true)
        }
      } catch (e) {
        return toolText(id, `${action} refused: ${e instanceof Error ? e.message : String(e)}`, true)
      }
    }

    case 'start_repo_care': {
      const os = await import('@/lib/office-session-server')
      const { DEFAULT_REPO_CARE } = await import('@/lib/repo-care')
      const repo = String(args.repo ?? '').trim()
      const workerAgentId = String(args.worker_agent_id ?? '').trim()
      if (!repo.includes('/')) return toolText(id, 'repo must be owner/name.', true)
      if (!workerAgentId) return toolText(id, 'worker_agent_id is required — Repo Care works in a checkout on your machine, so it needs a connected local worker.', true)
      const r = await os.startRepoCareSession({
        userId: auth.userId,
        slot: Math.max(1, Math.min(3, Math.floor(num(args.office, 1)))),
        workerAgentId,
        budgetLimitUsd: num(args.budget_usd, 5),
        everyMinutes: num(args.every_minutes, 720),
        care: {
          ...DEFAULT_REPO_CARE,
          repoFullName: repo,
          labels: Array.isArray(args.labels) ? args.labels.map(String).slice(0, 10) : [],
          maxPerWave: num(args.per_run, 3),
          verifyCommand: typeof args.verify_command === 'string' && args.verify_command ? args.verify_command.slice(0, 300) : null,
          openPrs: args.open_prs !== false,
        },
      })
      if (!r.ok) return toolText(id, `Repo Care not started: ${r.error}`, true)
      const state = await os.loadSessionState(r.session.id)
      return toolText(
        id,
        `🌙 Repo Care on ${repo} — session ${r.session.id}\n${sessionSentence(state.session)}\n\n` +
          `Tonight's plan:\n${taskLines(state)}\n\n` +
          `Read it back with office_session_status { session_id: "${r.session.id}" }. Issues that look production-, secret- or dependency-shaped are left for you with the reason, on the timeline as "left for a person".`,
      )
    }

    case 'session_tools': {
      const os = await import('@/lib/office-session-server')
      const slot = Math.max(1, Math.min(3, Math.floor(num(args.office, 1))))
      const action = String(args.action ?? 'list')
      if (action === 'list') {
        const bindings = await os.sessionToolBindings(auth.userId, slot)
        if (bindings.length === 0) {
          return toolText(
            id,
            `Office ${slot} talks to nothing outside itself yet.\n` +
              `attach one with session_tools { action: "attach", purpose: "consult" | "notify", label, server_url, tool_name${'\n'}  , events: [...] for notify }.\n` +
              `A consult tool is asked once before each task and its answer joins the worker's brief as fenced reference material — never as evidence that anything passed.\n` +
              `A notify tool is told, in one line, when one of these happens: ${NOTIFIABLE_EVENTS.join(', ')}.`,
          )
        }
        return toolText(id, `Office ${slot} talks to:\n${bindings.map((b) => `- ${b.id} · ${describeBinding(b)}`).join('\n')}`)
      }
      if (action === 'attach') {
        const r = await os.attachSessionTool(auth.userId, {
          officeSlot: slot,
          sessionId: typeof args.session_id === 'string' ? args.session_id : null,
          label: typeof args.label === 'string' ? args.label : '',
          serverUrl: typeof args.server_url === 'string' ? args.server_url : '',
          toolName: typeof args.tool_name === 'string' ? args.tool_name : '',
          purpose: typeof args.purpose === 'string' ? args.purpose : '',
          events: Array.isArray(args.events) ? args.events.map(String) : [],
          authHeader: typeof args.auth_header === 'string' && args.auth_header ? args.auth_header : null,
        })
        if (!r.ok) return toolText(id, `Not attached: ${r.error}`, true)
        return toolText(
          id,
          `🔌 ${describeBinding(r.binding)}\n(id ${r.binding.id})\n` +
            (r.binding.purpose === 'consult'
              ? 'Every task of this office now opens with one call to that tool, and the answer reaches the worker fenced as reference material.'
              : 'The office will call that tool with one line of text when those events happen. It never sends a deliverable, a diff or a credential — see lib/session-tools.ts notifyText for exactly what it may say.'),
        )
      }
      if (action === 'detach') {
        const toolId = String(args.tool_id ?? '')
        if (!toolId) return toolText(id, 'tool_id is required to detach.', true)
        return toolText(id, (await os.detachSessionTool(auth.userId, toolId)) ? `Detached ${toolId}.` : `No tool ${toolId} on this account.`, !(await Promise.resolve(true)) ? true : false)
      }
      return toolText(id, 'action must be list, attach or detach.', true)
    }

    default:
      return null
  }
}
