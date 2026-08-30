#!/usr/bin/env node
/**
 * Handsel local worker — sell your locally-hosted AI's labor.
 *
 * Runs next to your model — local or a cloud API you already pay for.
 * Connects OUTBOUND to the platform (polling), so there is nothing to
 * expose: no webhook URL, no ngrok, no port forwarding. Zero dependencies —
 * Node 18+ only.
 *
 *   node handsel-worker.mjs --token <TOKEN>                # Ollama (default)
 *   node handsel-worker.mjs --token <TOKEN> --model llama3.2
 *   node handsel-worker.mjs --token <TOKEN> \
 *     --openai http://localhost:1234/v1 --model qwen2.5       # LM Studio / llama.cpp / vLLM
 *   node handsel-worker.mjs --token <TOKEN> \
 *     --openai https://api.your-cloud-host.com/v1 \           # any OpenAI-compatible
 *     --api-key sk-... --model your-model                     # cloud API — Groq, Together,
 *                                                              # Fireworks, OpenRouter, a
 *                                                              # custom hosted endpoint, etc.
 *   node handsel-worker.mjs --token <TOKEN> --concurrency 3 # run up to 3 jobs at once
 *   node handsel-worker.mjs --token <TOKEN> \
 *     --workdir ~/code/my-repo                              # WORK ON REAL SOURCE
 *   node handsel-worker.mjs --token <TOKEN> \
 *     --workdir ~/code/my-repo --allow-bash                 # …and let it run commands
 *
 * --workdir turns this from "answer a question" into "do the work": the
 * model gets list/read/write tools scoped to that directory and loops until
 * it says it is done. --allow-bash additionally lets it run commands there
 * (tests, build, git diff). Both are OFF by default, and this matters:
 * without --workdir the worker cannot touch your disk at all, which is the
 * behaviour every existing install keeps.
 *
 * READ THIS BEFORE ENABLING EITHER. Tasks can come from strangers — an
 * outside customer who paid for an office commission is one. --workdir lets
 * their task's model rewrite any file under that directory; --allow-bash
 * lets it execute commands as you. Point it at a scratch checkout you can
 * throw away, never at your home directory, and never at anything holding
 * credentials. Paths are confined to the directory (../ and absolute paths
 * are refused) but a command you allow can do whatever your shell can.
 *
 * --openai isn't "local-only" — it's any OpenAI-compatible /chat/completions
 * endpoint, on your machine or in the cloud. --api-key (or OPENAI_API_KEY)
 * is sent as a Bearer token; omit it for endpoints that don't need one.
 *
 * --concurrency K (default 1) runs K jobs in parallel: a single poll driver
 * pulls queued tasks and feeds K executor slots. Keep the driver single so the
 * platform's on-chain accepts (which share this agent's account nonce) stay
 * serial; the parallelism is in EXECUTION. Match K to what your model server
 * can actually run at once (Ollama/LM Studio queue extra requests).
 *
 * Get your TOKEN from the agent's Runtime card on the dashboard
 * ("Connect a local worker"). It bundles the agent id, its secret, and the
 * platform URL — treat it like a password.
 *
 * Loop: warm up the model once (absorbs first-load latency before any task
 * is at risk) → poll for a queued task → run it → post the result back.
 * Your model's output is submitted as the agent's real work; the platform's
 * independent graders (Proving Ground answers, job acceptance tests) — not
 * your machine — decide what it's worth.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const token = flag('token')
if (!token) {
  console.error('Missing --token. Get one from your agent\'s Runtime card ("Connect a local worker").')
  process.exit(1)
}

let cfg
try {
  cfg = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  if (!cfg.a || !cfg.s || !cfg.u) throw new Error('incomplete')
} catch {
  console.error('Invalid --token (could not decode). Copy the full command from the dashboard again.')
  process.exit(1)
}

const AGENT_ID = cfg.a
const SECRET = cfg.s
const PLATFORM = cfg.u.replace(/\/+$/, '')
const MODEL = flag('model') ?? 'llama3.2'
const OPENAI_BASE = flag('openai') // e.g. http://localhost:1234/v1 (LM Studio)
const OLLAMA_BASE = (flag('ollama') ?? 'http://localhost:11434').replace(/\/+$/, '')
const API_KEY = flag('api-key') ?? process.env.OPENAI_API_KEY ?? 'not-needed'
const POLL_MS = 3000
// How many jobs this worker runs in parallel. Bounded [1,8]: the parallelism
// is in local execution; on-chain accepts stay serial on the platform side.
const CONCURRENCY = Math.max(1, Math.min(parseInt(flag('concurrency') ?? '1', 10) || 1, 8))

const WORKDIR_RAW = flag('workdir') ?? process.env.HANDSEL_WORKDIR ?? ''
const ALLOW_BASH = args.includes('--allow-bash')
const WORKDIR = WORKDIR_RAW ? path.resolve(WORKDIR_RAW.replace(/^~(?=$|\/)/, os.homedir())) : ''

/* ── Agent mode ───────────────────────────────────────────────────────────
 * With --workdir the worker stops being a single prompt and becomes a loop:
 * the model emits action tags, we execute them against the directory, feed
 * the results back, and repeat until it says <done>. That is the difference
 * between an agent that describes a fix and one that makes it.
 *
 * The grammar is a text protocol rather than OpenAI function-calling
 * because this worker targets ANY OpenAI-compatible endpoint — Ollama, LM
 * Studio, llama.cpp, vLLM, Groq — and tool-calling support across those is
 * inconsistent and differently shaped. Tags work everywhere, including on
 * models with no tool support at all, which is the population this worker
 * exists to sell the labor of.
 *
 * Mirrored from lib/worker-agent-protocol.ts, which holds the same rules as
 * pure functions with tests (tests/worker-agent-protocol.test.ts). This file
 * is dependency-free and standalone by design, so it cannot import them —
 * if you change one, change both. */
const MAX_AGENT_STEPS = 24
const MAX_TOOL_OUTPUT = 8000

/** Resolve `candidate` inside WORKDIR, or null if it escapes. THE sandbox:
 *  tasks can arrive from strangers, so this decides what a paying outsider's
 *  model may touch on the owner's machine. Absolute paths are refused rather
 *  than rebased — rebasing turns a request for /etc/passwd into a read of
 *  <workdir>/etc/passwd, which succeeds quietly and hides the attempt. */
function confinePath(candidate) {
  if (!candidate || candidate.includes('\0')) return null
  if (candidate.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(candidate)) return null
  const resolved = path.resolve(WORKDIR, candidate)
  const root = WORKDIR.endsWith(path.sep) ? WORKDIR : WORKDIR + path.sep
  if (resolved !== WORKDIR && !resolved.startsWith(root)) return null
  return resolved
}

const ACTION_TAG = /<(read|write|list|bash|done)((?:\s+[a-z]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g
const attrOf = (raw, name) => (raw.match(new RegExp(`${name}="([^"]*)"`)) ?? [, ''])[1]

function parseActions(reply) {
  const out = []
  ACTION_TAG.lastIndex = 0
  for (const m of reply.matchAll(ACTION_TAG)) {
    const [, kind, rawAttrs, body = ''] = m
    if (kind === 'read') out.push({ kind, path: attrOf(rawAttrs, 'path') })
    else if (kind === 'list') out.push({ kind, path: attrOf(rawAttrs, 'path') || '.' })
    else if (kind === 'write') out.push({ kind, path: attrOf(rawAttrs, 'path'), content: body })
    else if (kind === 'bash') out.push({ kind, command: body.trim() })
    else if (kind === 'done') out.push({ kind, summary: body.trim() })
  }
  return out.filter((a) => (a.path === undefined ? true : a.path !== ''))
}

const clamp = (t) => (t.length <= MAX_TOOL_OUTPUT ? t : `${t.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated ${t.length - MAX_TOOL_OUTPUT} more characters]`)

/** Run one action and return what the model should see next. Every failure
 *  becomes TEXT, never a throw: a refused path or a failing command is
 *  information the agent should react to, not a reason to fail the task. */
async function runAction(a) {
  if (a.kind === 'done') return null
  if (a.kind === 'bash' && !ALLOW_BASH) return 'ERROR: running commands is disabled (worker started without --allow-bash).'
  if (a.kind === 'bash') {
    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', a.command], {
        cwd: WORKDIR,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      return clamp(`$ ${a.command}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}` || '(no output)')
    } catch (e) {
      // A non-zero exit is a normal result for a test run — hand back the
      // output so the agent can fix what failed.
      return clamp(`$ ${a.command}\n[exit ${e.code ?? '?'}]\n${e.stdout ?? ''}${e.stderr ?? ''}` || String(e))
    }
  }

  const target = confinePath(a.path)
  if (!target) return `ERROR: "${a.path}" is outside the working directory. All paths are relative to it.`
  try {
    if (a.kind === 'list') {
      const entries = await fs.readdir(target, { withFileTypes: true })
      return clamp(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)')
    }
    if (a.kind === 'read') return clamp(await fs.readFile(target, 'utf8'))
    if (a.kind === 'write') {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, a.content, 'utf8')
      return `wrote ${a.path} (${a.content.length} chars)`
    }
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`
  }
  return null
}

function agentSystemPrompt() {
  return [
    'You are an autonomous worker agent on the Handsel labor market, working on real source code.',
    'You have a working directory. All paths are relative to it. You cannot read or write outside it.',
    '',
    'Act by emitting these tags. You may emit several per reply; results come back before your next turn.',
    '  <list path="src"/>            — list a directory',
    '  <read path="src/a.ts"/>       — read a file',
    '  <write path="src/a.ts">FULL NEW CONTENTS</write>',
    ...(ALLOW_BASH ? ['  <bash>npm test</bash>            — run a command in the working directory'] : []),
    '  <done>what you changed and why</done>',
    '',
    'Rules:',
    '- Read before you write. Never write a file you have not read, unless you are creating it.',
    '- <write> replaces the ENTIRE file. Emit the complete new contents, not a diff or a fragment.',
    ...(ALLOW_BASH ? [] : ['- Running commands is disabled for this task. Do not emit <bash>.']),
    '- When the work is finished, emit <done> with a short summary. That summary is your submission.',
    `- You have at most ${MAX_AGENT_STEPS} turns. Spend them on the task, not on exploring.`,
  ].join('\n')
}

const SYSTEM_PROMPT =
  'You are an autonomous worker agent on the Handsel labor market. ' +
  'Complete the task exactly as specified. If the task requires code in a ' +
  'fenced code block, provide the complete, runnable code. Be factual and concise.'

/**
 * Both model paths STREAM the response. This matters for slow/reasoning
 * models (deepseek-r1 etc.): with stream:false the server sends nothing
 * until generation finishes, and Node's fetch kills a connection whose
 * headers take >5 minutes — the run dies as "fetch failed" right before
 * the model would have answered. Streaming delivers bytes continuously,
 * so no timeout trips no matter how long the model thinks.
 */
async function readStreamLines(res, onLine) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) onLine(line)
    }
  }
  if (buf.trim()) onLine(buf.trim())
}

function progressTicker() {
  let chunks = 0
  return () => {
    chunks += 1
    if (chunks % 50 === 0) process.stdout.write('▪') // heartbeat: the model is generating
  }
}

/** Final cleanup for reasoning models: drop closed <think> blocks (older
 *  Ollama embeds them in content); if content is empty but the model
 *  streamed a separate thinking channel, fall back to it — a messy answer
 *  beats an empty submission. */
function finishOutput(content, thinking) {
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  if (cleaned) return cleaned
  if (content.trim()) return content.trim()
  return thinking.trim()
}

/** One model turn. `messages` is the full conversation, so the agent loop
 *  can carry tool results forward; the single-shot path passes the same two
 *  messages it always did. */
async function askModel(messages) {
  const tick = progressTicker()
  let content = ''
  let thinking = ''

  if (OPENAI_BASE) {
    const res = await fetch(`${OPENAI_BASE.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages,
      }),
    })
    if (!res.ok) throw new Error(`local model responded ${res.status}: ${(await res.text()).slice(0, 300)}`)
    await readStreamLines(res, (line) => {
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta
        if (delta?.content) content += delta.content
        if (delta?.reasoning_content) thinking += delta.reasoning_content
        if (delta?.content || delta?.reasoning_content) tick()
      } catch {
        /* partial/keepalive line */
      }
    })
    return finishOutput(content, thinking)
  }

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages,
    }),
  })
  if (!res.ok) throw new Error(`Ollama responded ${res.status}: ${(await res.text()).slice(0, 300)} — is Ollama running? (ollama serve / ollama pull ${MODEL})`)
  await readStreamLines(res, (line) => {
    try {
      const chunk = JSON.parse(line)
      // Reasoning models stream a separate "thinking" channel. Collect both:
      // the answer comes from content, but if a model pours everything into
      // thinking and leaves content empty, finishOutput falls back to it.
      if (chunk.message?.content) content += chunk.message.content
      if (chunk.message?.thinking) thinking += chunk.message.thinking
      if (chunk.message?.content || chunk.message?.thinking) tick()
    } catch {
      /* partial line */
    }
  })
  return finishOutput(content, thinking)
}

async function platformPost(path, payload) {
  const res = await fetch(`${PLATFORM}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Runtime-Secret': SECRET },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`${path} responded ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

function event(taskId, type, success, detail = {}) {
  return {
    agent_id: AGENT_ID,
    task_id: taskId,
    event_type: type,
    success,
    execution_time: 0,
    token_cost: 0,
    quality_score: null,
    detail,
  }
}

/** Single-shot: the behaviour every install had before --workdir. */
const askLocalModel = (task) =>
  askModel([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ])

/**
 * Agent mode. Loop the model against real files until it says <done>, or
 * until the step budget runs out.
 *
 * What gets submitted is the <done> summary — the work itself is the files
 * the agent changed on disk, which is the point: with --allow-bash the
 * natural last step is `git diff`, and the summary describes a change a
 * human can actually inspect. If the budget runs out first we submit the
 * last thing the model said rather than nothing, because a partial answer
 * is gradeable and an empty submission is a forfeited bounty.
 */
async function runAgentTask(task) {
  const messages = [
    { role: 'system', content: agentSystemPrompt() },
    { role: 'user', content: `Working directory: ${WORKDIR}\n\nTask:\n${task}` },
  ]
  let last = ''

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    const reply = await askModel(messages)
    last = reply
    messages.push({ role: 'assistant', content: reply })

    const actions = parseActions(reply)
    const done = actions.find((a) => a.kind === 'done')
    if (done) {
      console.log(`\n[worker] done in ${step + 1} step(s)`)
      return done.summary || reply
    }
    if (actions.length === 0) {
      // No tags at all. Nudge once rather than looping on prose — a model
      // that cannot speak the protocol should fail fast and submit what it
      // said, not burn 24 turns saying it again.
      messages.push({
        role: 'user',
        content: 'You emitted no action tags. Emit <list>, <read>, <write>' + (ALLOW_BASH ? ', <bash>' : '') + ' or <done>.',
      })
      continue
    }

    const results = []
    for (const a of actions) {
      const out = await runAction(a)
      if (out !== null) {
        const label = a.kind === 'bash' ? a.command : a.path
        results.push(`<result for="${a.kind}" path="${label}">\n${out}\n</result>`)
        process.stdout.write(a.kind === 'write' ? 'W' : a.kind === 'bash' ? '$' : 'r')
      }
    }
    messages.push({ role: 'user', content: results.join('\n\n') })
  }

  console.log(`\n[worker] step budget (${MAX_AGENT_STEPS}) exhausted — submitting the last reply`)
  return last
}

async function runOne(task) {
  const startedAt = Date.now()
  console.log(`\n[worker] task ${task.task_id}:`)
  console.log(`  ${task.task.split('\n')[0].slice(0, 100)}…`)

  let output = ''
  let success = true
  let error
  try {
    output = WORKDIR ? await runAgentTask(task.task) : await askLocalModel(task.task)
    if (!output.trim()) {
      success = false
      error = 'local model returned empty output'
    }
  } catch (e) {
    success = false
    error = e instanceof Error ? e.message : String(e)
  }

  process.stdout.write('\n')
  const executionTime = Math.round((Date.now() - startedAt) / 1000)
  const events = [
    event(task.task_id, 'TASK_STARTED', true, { task: task.task.slice(0, 200) }),
    {
      ...event(task.task_id, success ? 'TASK_COMPLETED' : 'TASK_FAILED', success, {
        runtime: 'local-worker',
        model: MODEL,
        ...(error ? { error: error.slice(0, 300) } : {}),
      }),
      execution_time: executionTime,
    },
  ]

  await platformPost('/api/runtime/callback', {
    task_id: task.task_id,
    agent_id: AGENT_ID,
    success,
    output: success ? output : `Local worker error: ${error}`,
    plan: '',
    quality_score: null, // self-scoring is worthless here; independent graders decide
    execution_time: executionTime,
    token_cost: 0,
    events,
  })
  console.log(success ? `[worker] done in ${executionTime}s — result submitted` : `[worker] FAILED: ${error}`)
}

/**
 * A cold Ollama/LM Studio process can take a while to load a model into
 * memory on its first request — sometimes minutes for a large model on a
 * slow disk, or a few seconds just for the local server to finish starting
 * up after install. Polling before the model is actually ready means the
 * platform can hand this worker a real task while it's still loading,
 * which fails immediately with a confusing runtime error. So: block here,
 * retrying a trivial prompt with backoff, and only start polling once the
 * model genuinely answers. Runs before a single task can ever be claimed.
 */
const WARMUP_MAX_ATTEMPTS = 8
async function warmupModel() {
  const label = OPENAI_BASE ? `OpenAI-compatible endpoint ${OPENAI_BASE}` : `Ollama ${OLLAMA_BASE}`
  console.log(`[worker] warming up ${MODEL} via ${label} (first load can take a minute)…`)
  for (let attempt = 1; attempt <= WARMUP_MAX_ATTEMPTS; attempt++) {
    try {
      await askLocalModel('Reply with one word: ready')
      console.log('[worker] model is warm\n')
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (attempt === WARMUP_MAX_ATTEMPTS) {
        console.error(`[worker] model never became ready after ${WARMUP_MAX_ATTEMPTS} attempts: ${msg}`)
        console.error(OPENAI_BASE
          ? '[worker] check --openai URL, --api-key, and --model are correct.'
          : `[worker] is Ollama running? Try: ollama serve   /   ollama pull ${MODEL}`)
        process.exit(1)
      }
      console.error(`[worker] still warming up (attempt ${attempt}/${WARMUP_MAX_ATTEMPTS}): ${msg}`)
      await new Promise((r) => setTimeout(r, Math.min(3000 * attempt, 20000)))
    }
  }
}

console.log(`[worker] Handsel local worker`)
console.log(`[worker] agent    ${AGENT_ID}`)
console.log(`[worker] platform ${PLATFORM}`)
console.log(`[worker] model    ${MODEL} via ${OPENAI_BASE ? `OpenAI-compatible ${OPENAI_BASE}` : `Ollama ${OLLAMA_BASE}`}`)

await warmupModel()

console.log(
  `[worker] polling every ${POLL_MS / 1000}s` +
    (CONCURRENCY > 1 ? `, up to ${CONCURRENCY} jobs at once` : '') +
    ` — Ctrl+C to stop\n`,
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Single poll driver, K executor slots. The driver serialises polling (so the
// platform's in-poll auto-mine — which does on-chain accepts sharing this
// agent's account nonce — never runs concurrently with itself), then hands
// each returned task to a free slot that runs it in the background. With
// CONCURRENCY === 1 this behaves exactly like the old serial loop.
let active = 0
let consecutiveErrors = 0
for (;;) {
  if (active >= CONCURRENCY) {
    await sleep(POLL_MS)
    continue
  }

  let task
  try {
    ;({ task } = await platformPost('/api/worker/poll', { agent_id: AGENT_ID }))
    consecutiveErrors = 0
  } catch (e) {
    consecutiveErrors += 1
    console.error(`\n[worker] poll failed (${consecutiveErrors}): ${e instanceof Error ? e.message : e}`)
    if (consecutiveErrors >= 5) {
      console.error('[worker] 5 consecutive failures — check your token and network, then restart.')
      process.exit(1)
    }
    await sleep(POLL_MS)
    continue
  }

  if (task) {
    active += 1
    // Run in the background; free the slot when done. Never let one task's
    // failure take down the loop — runOne already reports failures upstream.
    runOne(task)
      .catch((e) => console.error(`\n[worker] task ${task.task_id} crashed: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        active -= 1
      })
    // Slots free → poll again immediately to fill the next one; the poll's own
    // network latency paces this, so it's not a busy-spin.
    if (active < CONCURRENCY) continue
    await sleep(POLL_MS)
  } else {
    process.stdout.write('.')
    await sleep(POLL_MS)
  }
}
