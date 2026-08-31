'use server'

/**
 * What the harness console reads.
 *
 * Every field here comes from a row that already exists or from telemetry a
 * worker actually sent. Where there is no source, the field is `null` and
 * the console renders nothing rather than a plausible number — the reason
 * `app/actions/shell.ts` gives for the header, applied to a screen with a
 * lot more slots to fill.
 *
 * Three things the mockup this was built from asks for and this does NOT
 * return, because nothing measures them:
 *
 *   - **coverage** — no harness in the registry reports it and the platform
 *     never runs the tests itself.
 *   - **estimated cost / tokens** — only present when a worker reports a
 *     token count; the callback's long-standing `token_cost: 0` is a
 *     hardcoded literal, not a measurement, so it is not read here.
 *   - **ETA** — a run's remaining time is not predictable from anything on
 *     record, and a progress bar that lies about finishing is worse than no
 *     bar.
 */
import { getSession } from '@/lib/get-session'
import { db } from '@/lib/db'
import { agent as agentTable, agentTask } from '@/lib/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { runsForAgents } from '@/lib/harness-run-server'
import { diffStat, type DiffStat, type HarnessRun } from '@/lib/harness-run'
import { extractUnifiedDiff } from '@/lib/repo-jobs'

export type ConsoleRun = {
  run: HarnessRun
  /** First line of the task, which is what a person recognises it by. */
  title: string
  agentName: string
  /** `agent_tasks.status` — the platform's view, next to the worker's. */
  taskStatus: string | null
  /** Only for a repo job whose deliverable is a diff. Null otherwise. */
  diff: DiffStat | null
  /** Grading verdict, once a grader that is not the worker has returned one. */
  passed: boolean | null
  /** Seconds, as recorded by the callback. */
  executionTime: number | null
  /** The submitted deliverable itself — already ours (it is what got graded),
   *  so showing it costs no new trust. Clamped; null until submission. */
  output: string | null
}

function firstLine(task: string): string {
  const line = task.split('\n').find((l) => l.trim()) ?? 'Untitled task'
  return line.trim().replace(/^#+\s*/, '').slice(0, 120)
}

/**
 * The account's recent harness runs, newest first.
 *
 * Returns an empty list rather than throwing when telemetry is unavailable:
 * the console is worth showing with the task rows alone, and an error page
 * teaches nobody anything.
 */
export async function getHarnessRuns(limit = 12): Promise<ConsoleRun[]> {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')

  const mine = await db.select().from(agentTable).where(eq(agentTable.userId, session.user.id))
  if (mine.length === 0) return []
  const byId = new Map(mine.map((a) => [a.id, a]))

  const runs = await runsForAgents(
    mine.map((a) => a.id),
    limit,
  )
  if (runs.length === 0) return []

  const tasks = await db
    .select()
    .from(agentTask)
    .where(
      and(
        eq(agentTask.userId, session.user.id),
        inArray(
          agentTask.id,
          runs.map((r) => r.taskId),
        ),
      ),
    )
  const taskById = new Map(tasks.map((t) => [t.id, t]))

  return runs.map((run) => {
    const task = taskById.get(run.taskId)
    const result = (task?.result ?? null) as { executionTime?: unknown; evaluation?: { passed?: unknown } } | null
    // The diff is not stored as a diff — it is fenced inside the submitted
    // output, exactly as the repo-job path reads it. Reusing that extractor
    // rather than a second regex here is what keeps "what counts as the
    // deliverable" one rule instead of two that can disagree.
    const fenced = task?.output ? extractUnifiedDiff(task.output) : null
    return {
      run,
      title: task ? firstLine(task.task) : run.taskId,
      agentName: byId.get(run.agentId)?.name ?? 'Unknown agent',
      taskStatus: task?.status ?? null,
      diff: fenced ? diffStat(fenced) : null,
      passed: typeof result?.evaluation?.passed === 'boolean' ? result.evaluation.passed : null,
      executionTime: typeof result?.executionTime === 'number' ? result.executionTime : null,
      output: task?.output ? task.output.slice(0, 20_000) : null,
    }
  })
}

/**
 * The run happening on one agent right now, for the office.
 *
 * Selecting a desk in the diorama and reading "on a job — accepted" while a
 * separate page knew the harness was three minutes into `code` was the whole
 * complaint: two views of one moment that did not know about each other.
 * This is the read behind the desk panel, and it deliberately returns the
 * SAME `ConsoleRun` the console renders so both draw from one shape.
 *
 * Returns the newest run for the agent, live or not — a desk you just
 * watched finish should still show what it did rather than going blank.
 */
export async function getAgentRun(agentId: string): Promise<ConsoleRun | null> {
  const runs = await getHarnessRuns(24)
  return runs.find((r) => r.run.agentId === agentId) ?? null
}
