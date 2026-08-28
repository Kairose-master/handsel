'use client'

import { useEffect, useRef, useState } from 'react'
import { Brain, Wrench, CheckCircle2, XCircle, Rocket, Loader2 } from 'lucide-react'
import { getTaskProgress } from '@/app/actions/task-progress'

type ProgressEvent = {
  id: string
  eventType: string
  detail: Record<string, unknown>
  createdAt: string | Date
}

const EVENT_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  TASK_STARTED: Rocket,
  PLAN_CREATED: Brain,
  TOOL_EXECUTED: Wrench,
  TASK_COMPLETED: CheckCircle2,
  TASK_FAILED: XCircle,
}

function describe(event: ProgressEvent): string {
  switch (event.eventType) {
    case 'TASK_STARTED':
      return 'Started'
    case 'PLAN_CREATED': {
      const plan = String(event.detail?.plan ?? '')
      return `Planned: ${plan.split('\n')[0].slice(0, 80)}`
    }
    case 'TOOL_EXECUTED':
      return `Called ${String(event.detail?.tool ?? 'a tool')}`
    case 'TASK_COMPLETED':
      return 'Completed'
    case 'TASK_FAILED':
      return 'Failed'
    default:
      return event.eventType
  }
}

/** Live, polling feed of what an agent is doing right now (see task_progress
 *  in lib/db/schema.ts — cosmetic, not the credit-scoring source of truth).
 *  Pass `active=false` once the task reaches a terminal status to stop polling. */
export function LiveTaskProgress({ taskId, active }: { taskId: string | null; active: boolean }) {
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setEvents([])
    if (!taskId) return

    let cancelled = false
    const tick = async () => {
      try {
        const rows = await getTaskProgress(taskId)
        if (!cancelled) setEvents(rows as ProgressEvent[])
      } catch {
        // cosmetic feed — a poll failure just means we try again next tick
      }
    }
    tick()
    if (active) {
      pollRef.current = setInterval(tick, 2000)
    }
    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [taskId, active])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [events])

  if (!taskId || events.length === 0) return null

  return (
    <div
      ref={listRef}
      className="mt-3 max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border bg-secondary/30 p-3"
    >
      {events.map((event) => {
        const Icon = EVENT_ICON[event.eventType] ?? Loader2
        const failed = event.eventType === 'TASK_FAILED'
        return (
          <div
            key={event.id}
            className={`flex items-center gap-2 text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{describe(event)}</span>
          </div>
        )
      })}
      {active && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span>Working…</span>
        </div>
      )}
    </div>
  )
}
