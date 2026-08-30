/**
 * The action protocol a local worker's model speaks when it is allowed to
 * touch real source.
 *
 * `public/handsel-worker.mjs` used to be a single LLM call: poll a task,
 * send it to a chat endpoint, post the text back. An agent that can only
 * emit prose cannot open a file, run a test, or produce a diff — so every
 * "engineering" subtask an office ran was a description of work rather than
 * work. This is the grammar that closes that gap.
 *
 * Why a text protocol and not OpenAI function-calling: the worker targets
 * *any* OpenAI-compatible endpoint — Ollama, LM Studio, llama.cpp, vLLM,
 * Groq, OpenRouter — and tool-calling support across those is inconsistent
 * and differently shaped. A grammar the model writes as text works on every
 * one of them, including models with no tool support at all, which is the
 * population this worker exists to sell the labor of.
 *
 * Pure on purpose. Parsing and path confinement are where the security of
 * the whole feature lives, so they are separated from the I/O that acts on
 * them and tested directly.
 */

export type WorkerAction =
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'list'; path: string }
  | { kind: 'bash'; command: string }
  | { kind: 'done'; summary: string }

/** How many tool round-trips one task may take before the worker gives up
 *  and submits what it has. A model that loops forever must still cost a
 *  bounded amount of the owner's machine. */
export const MAX_AGENT_STEPS = 24

/** Per-read and per-command output cap, in characters. Feeding a 10MB file
 *  back into the context window fails the task in a way that looks like the
 *  model being stupid. */
export const MAX_TOOL_OUTPUT = 8000

const TAG = /<(read|write|list|bash|done)((?:\s+[a-z]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g

function attr(raw: string, name: string): string {
  const m = raw.match(new RegExp(`${name}="([^"]*)"`))
  return m ? m[1] : ''
}

/**
 * Every action in the model's reply, in order.
 *
 * Deliberately tolerant of prose around the tags — small models narrate,
 * and refusing a reply because it said "Sure! Let me look:" first would
 * make the protocol unusable by exactly the models this targets.
 */
export function parseActions(reply: string): WorkerAction[] {
  const out: WorkerAction[] = []
  TAG.lastIndex = 0
  for (const m of reply.matchAll(TAG)) {
    const [, kind, rawAttrs, body = ''] = m
    if (kind === 'read') out.push({ kind: 'read', path: attr(rawAttrs, 'path') })
    else if (kind === 'list') out.push({ kind: 'list', path: attr(rawAttrs, 'path') || '.' })
    else if (kind === 'write') out.push({ kind: 'write', path: attr(rawAttrs, 'path'), content: body })
    else if (kind === 'bash') out.push({ kind: 'bash', command: body.trim() })
    else if (kind === 'done') out.push({ kind: 'done', summary: body.trim() })
  }
  return out.filter((a) => ('path' in a ? a.path !== '' : true))
}

/**
 * Resolve `candidate` inside `root`, or reject it.
 *
 * This is the whole sandbox. The worker runs on the owner's own machine and
 * a task can arrive from a stranger who paid for a commission, so "which
 * paths may this task touch" is the security boundary of the feature, not a
 * convenience. Returns null for anything that escapes — absolute paths,
 * `..` traversal, and the symlink-shaped cases the caller must still check
 * with realpath, which is noted where it is called.
 */
export function confinePath(root: string, candidate: string): string | null {
  if (!candidate || candidate.includes('\0')) return null
  // Reject absolute paths outright rather than silently rebasing them: a
  // model asking for /etc/passwd should read as refused, not as a read of
  // <root>/etc/passwd, which would hide the attempt.
  if (candidate.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(candidate)) return null

  const rootParts = root.split('/').filter(Boolean)
  const parts = candidate.split(/[\\/]/)
  const stack: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') {
      if (stack.length === 0) return null // would climb out of root
      stack.pop()
      continue
    }
    stack.push(p)
  }
  return ['', ...rootParts, ...stack].join('/')
}

/** Truncate tool output to something a context window survives, and say so
 *  rather than silently handing back a prefix the model will treat as whole. */
export function clampOutput(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} more characters]`
}

/** The instructions that teach the grammar. Kept here beside the parser so
 *  the two cannot drift — a prompt describing a tag the parser does not
 *  accept is a silent capability loss. */
export function buildAgentSystemPrompt(opts: { bash: boolean; root: string }): string {
  return [
    'You are an autonomous worker agent on the Handsel labor market, working on real source code.',
    `You have a working directory. All paths are relative to it. You cannot read or write outside it.`,
    '',
    'Act by emitting these tags. You may emit several per reply; results come back before your next turn.',
    '  <list path="src"/>            — list a directory',
    '  <read path="src/a.ts"/>       — read a file',
    '  <write path="src/a.ts">FULL NEW CONTENTS</write>',
    ...(opts.bash ? ['  <bash>npm test</bash>            — run a command in the working directory'] : []),
    '  <done>what you changed and why</done>',
    '',
    'Rules:',
    '- Read before you write. Never write a file you have not read, unless you are creating it.',
    '- <write> replaces the ENTIRE file. Emit the complete new contents, not a diff or a fragment.',
    ...(opts.bash ? [] : ['- Running commands is disabled for this task. Do not emit <bash>.']),
    '- When the work is finished, emit <done> with a short summary. That summary is your submission.',
    `- You have at most ${MAX_AGENT_STEPS} turns. Spend them on the task, not on exploring.`,
  ].join('\n')
}
