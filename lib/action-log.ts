/**
 * Action log — the worker's own account of HOW a deliverable was produced,
 * submitted next to the deliverable and committed to by hash.
 *
 * Why. Output-only grading has a known blind spot: a submission that is
 * correct but was not produced by the process the job paid for (copied from
 * another worker, answered from memory when the brief demanded a source
 * check, "passed" tests that were never run). The Sep-2026 literature made
 * the case with numbers — process-validation catches every answer-only
 * free-rider that output voting misses — and the shape it converged on is
 * the one here: a structured, append-only record of tool calls, each entry
 * hashing its own input and output, the whole log hashed once and bound to
 * the deliverable's proof.
 *
 * What this file does NOT claim. The log is self-reported. Its hash proves
 * that THIS log accompanied THIS deliverable at submission time and was not
 * edited afterwards; it does not prove the calls happened. What turns it into
 * evidence is a predicate a grader or requester can run against it
 * (`requiresTool`, `noFailedTail`, a job-specific replay) — and a worker who
 * lies in the log has now made a signed, hash-committed false statement,
 * which is a different thing from having said nothing.
 *
 * Pure. Storage and the callback plumbing are in the MCP handler and
 * `lib/work-proof-store.ts`.
 */
import { keccak256 } from 'viem'
import { canonicalJson } from '@/lib/attestation'

export const ACTION_LOG_SCHEMA = 'handsel.action-log.v1'
export const ACTION_LOG_MAX_ENTRIES = 200
export const ACTION_LOG_EVENT_TYPE = 'ACTION_LOG'

export interface ActionLogEntry {
  /** 1-based, strictly increasing. */
  seq: number
  /** Tool or step name as the worker's runtime knows it. */
  tool: string
  /** keccak256 / sha256 hex of the call input, if the worker computed one. */
  inputHash?: string
  /** Same for the output. */
  outputHash?: string
  ok: boolean
  /** Wall-clock milliseconds, when known. */
  ms?: number
  /** One line the worker wants a reviewer to see. Capped. */
  note?: string
}

export interface ActionLog {
  schema: typeof ACTION_LOG_SCHEMA
  entries: ActionLogEntry[]
}

export type ParsedActionLog = { ok: true; log: ActionLog } | { ok: false; reason: string }

const HEX = /^(0x)?[0-9a-f]{64}$/i
const NOTE_MAX = 280
const TOOL_MAX = 80

/** Accept what a worker sent as `action_log`. Strict on shape, lenient on
 *  key casing (`input_hash` and `inputHash` both work) because three
 *  different runtimes will build this. */
export function parseActionLog(input: unknown): ParsedActionLog {
  if (input === undefined || input === null) return { ok: false, reason: 'no action log' }
  const raw = Array.isArray(input) ? input : (input as { entries?: unknown })?.entries
  if (!Array.isArray(raw)) return { ok: false, reason: 'action_log must be an array of entries' }
  if (raw.length === 0) return { ok: false, reason: 'action_log is empty' }
  if (raw.length > ACTION_LOG_MAX_ENTRIES) return { ok: false, reason: `action_log has ${raw.length} entries; the cap is ${ACTION_LOG_MAX_ENTRIES}` }

  const entries: ActionLogEntry[] = []
  let lastSeq = 0
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown>
    if (!e || typeof e !== 'object') return { ok: false, reason: `entry ${i} is not an object` }
    const seq = typeof e.seq === 'number' ? e.seq : i + 1
    if (!Number.isInteger(seq) || seq <= lastSeq) return { ok: false, reason: `entry ${i}: seq must be a strictly increasing integer` }
    const tool = typeof e.tool === 'string' ? e.tool.trim() : ''
    if (!tool) return { ok: false, reason: `entry ${i}: tool is required` }
    if (tool.length > TOOL_MAX) return { ok: false, reason: `entry ${i}: tool name over ${TOOL_MAX} chars` }
    if (typeof e.ok !== 'boolean') return { ok: false, reason: `entry ${i}: ok must be true or false` }
    const inputHash = pickHex(e.inputHash ?? e.input_hash)
    const outputHash = pickHex(e.outputHash ?? e.output_hash)
    if (inputHash === false || outputHash === false) return { ok: false, reason: `entry ${i}: hashes must be 32-byte hex` }
    const entry: ActionLogEntry = { seq, tool, ok: e.ok }
    if (inputHash) entry.inputHash = inputHash
    if (outputHash) entry.outputHash = outputHash
    if (typeof e.ms === 'number' && Number.isFinite(e.ms) && e.ms >= 0) entry.ms = Math.round(e.ms)
    if (typeof e.note === 'string' && e.note.trim()) entry.note = e.note.trim().slice(0, NOTE_MAX)
    entries.push(entry)
    lastSeq = seq
  }
  return { ok: true, log: { schema: ACTION_LOG_SCHEMA, entries } }
}

function pickHex(v: unknown): string | null | false {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !HEX.test(v)) return false
  return (v.startsWith('0x') ? v : `0x${v}`).toLowerCase()
}

/** keccak256 over the canonical JSON of the log — the same canonical form
 *  the evidence bundle uses, so one verifier can re-derive both. */
export function actionLogHash(log: ActionLog): `0x${string}` {
  return keccak256(Buffer.from(canonicalJson(log), 'utf8'))
}

/** Compact facts a reviewer or the credit engine wants without the log. */
export function actionLogSummary(log: ActionLog): { entries: number; tools: string[]; failed: number; totalMs: number } {
  const tools = [...new Set(log.entries.map((e) => e.tool))]
  const failed = log.entries.filter((e) => !e.ok).length
  const totalMs = log.entries.reduce((s, e) => s + (e.ms ?? 0), 0)
  return { entries: log.entries.length, tools, failed, totalMs }
}

/** A predicate a requester can attach to a job, or a grader can run: what
 *  must be true of the process for the output to count. Pure and local. */
export type ActionLogPredicate = (log: ActionLog) => { passed: boolean; reason: string }

/** The brief demanded a tool (a source search, a test run) — was it called
 *  at least once and did that call succeed? */
export function requiresTool(tool: string, opts: { minCalls?: number } = {}): ActionLogPredicate {
  const min = opts.minCalls ?? 1
  return (log) => {
    const okCalls = log.entries.filter((e) => e.tool === tool && e.ok).length
    return okCalls >= min
      ? { passed: true, reason: `${tool} called successfully ${okCalls}×` }
      : { passed: false, reason: `${tool} needed ${min}× successfully, saw ${okCalls}` }
  }
}

/** The last thing the worker did must have succeeded — a log that ends in a
 *  failed step and then a deliverable is a deliverable produced by something
 *  the log does not show. */
export const noFailedTail: ActionLogPredicate = (log) => {
  const last = log.entries.at(-1)
  if (!last) return { passed: false, reason: 'empty log' }
  return last.ok ? { passed: true, reason: 'final step succeeded' } : { passed: false, reason: `final step ${last.tool} failed` }
}

export function runPredicates(log: ActionLog, predicates: readonly ActionLogPredicate[]): { passed: boolean; results: { passed: boolean; reason: string }[] } {
  const results = predicates.map((p) => p(log))
  return { passed: results.every((r) => r.passed), results }
}
