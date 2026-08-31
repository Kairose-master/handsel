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
 *   node handsel-worker.mjs --token <TOKEN> \
 *     --workdir ~/code/my-repo --harness claude             # …or hand it to a REAL harness
 *   node handsel-worker.mjs --token <TOKEN> \
 *     --workdir ~/code/my-repo --harness-cmd "mytool run"   # …or any other one
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
 * --harness is the third mode, and the one to reach for on engineering work.
 * Instead of this file's own agent loop, the task is handed to a coding
 * harness that already exists and is maintained by people who do nothing
 * else — Claude Code, Codex, OpenCode, Cline, Gemini CLI — and whatever it
 * writes to .handsel/deliverable-<task>.md is submitted. With no --harness
 * flag the worker looks for one on PATH and uses it; with none installed it
 * falls back to the built-in loop, so nothing about an existing install
 * changes. Mirrored from lib/worker-harness.ts (tests/worker-harness.test.ts).
 *
 * READ THIS TOO: --harness is strictly MORE permissive than --allow-bash. A
 * headless harness that stops to ask a human never answers, so every adapter
 * passes that harness's auto-approval flag — it can edit and run whatever it
 * likes in the working directory. Same rule as above, more so: a scratch
 * checkout you can throw away, never your home directory, never anything
 * holding credentials.
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
import { execFile, spawn } from 'node:child_process'
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

const HARNESS_ID = flag('harness') ?? null
const HARNESS_CMD = flag('harness-cmd') ?? null
const NO_HARNESS = args.includes('--no-harness')
// A harness gets a hard wall-clock limit because it is a process on someone
// else's machine that we do not control: a run that hangs holds a slot, and
// with --concurrency it holds one of very few. Generous by default — real
// engineering work is slow — and overridable for jobs that are slower still.
const HARNESS_TIMEOUT_MS = Math.max(60, parseInt(flag('harness-timeout') ?? '1800', 10) || 1800) * 1000

/* ── Harness mode ─────────────────────────────────────────────────────────
 * Hand the whole task to a coding harness that already exists.
 *
 * Mirrored from lib/worker-harness.ts, which holds the same registry and the
 * same output selection as pure functions with tests. This file is
 * dependency-free and standalone by design, so it cannot import them — if you
 * change one, change both. tests/worker-harness.test.ts pins the flags in
 * BOTH files, so a drifting mirror fails the build rather than shipping a
 * wrong command line to someone else's machine.
 *
 * Two things worth knowing before editing an adapter:
 *
 *   Long flags only. These tools agree on nothing, including which letter -c
 *   is: --continue to OpenCode, --cwd to Cline. A short form on the wrong
 *   tool fails in a way that reads like the model being bad at its job.
 *
 *   The brief is always the LAST argv entry (or the value of a flag that
 *   names it). A client writes the brief, and a brief beginning with a dash
 *   that lands where a flag is expected is a stranger configuring the
 *   harness that runs on your machine.
 */
const DELIVERABLE_DIR = '.handsel'
const HARNESSES = [
  {
    id: 'claude',
    bin: 'claude',
    label: 'Claude Code',
    install: 'npm i -g @anthropic-ai/claude-code',
    // No --add-dir: it is variadic and swallows the brief. The workdir is
    // already this child's cwd. See lib/worker-harness.ts.
    argv: (i) => [
      '--print',
      ...(i.model ? ['--model', i.model] : []),
      '--permission-mode',
      'bypassPermissions',
      i.brief,
    ],
  },
  {
    id: 'codex',
    bin: 'codex',
    label: 'OpenAI Codex CLI',
    install: 'npm i -g @openai/codex',
    argv: (i) => [
      'exec',
      ...(i.model ? ['--model', i.model] : []),
      '--cd',
      i.workdir,
      '--full-auto',
      '--skip-git-repo-check',
      i.brief,
    ],
  },
  {
    id: 'opencode',
    bin: 'opencode',
    label: 'OpenCode',
    install: 'npm i -g opencode-ai',
    argv: (i) => ['run', ...(i.model ? ['--model', i.model] : []), '--dir', i.workdir, '--auto', i.brief],
  },
  {
    id: 'cline',
    bin: 'cline',
    label: 'Cline CLI',
    install: 'npm i -g cline',
    argv: (i) => ['--yolo', ...(i.model ? ['--model', i.model] : []), '--cwd', i.workdir, i.brief],
  },
  {
    id: 'gemini',
    bin: 'gemini',
    label: 'Gemini CLI',
    install: 'npm i -g @google/gemini-cli',
    argv: (i) => [...(i.model ? ['--model', i.model] : []), '--yolo', '--prompt', i.brief],
  },
]
const AUTODETECT_ORDER = ['claude', 'codex', 'opencode', 'cline', 'gemini']

/** Per task, never one shared filename: --concurrency runs several tasks in
 *  this same directory, and a file left over from a previous task would be
 *  submitted to the next client as their deliverable. */
function deliverablePathFor(taskId) {
  const safe = String(taskId).replace(/[^A-Za-z0-9_-]/g, '') || 'task'
  return `${DELIVERABLE_DIR}/deliverable-${safe.slice(0, 64)}.md`
}

function harnessBrief(brief, relPath) {
  return [
    brief,
    '',
    '---',
    '',
    'HOW THIS IS SUBMITTED:',
    `When you are finished, write your complete deliverable to \`${relPath}\` (create the directory if needed).`,
    'That file is what gets submitted to the client and graded — nothing else you print is read.',
    'If the task was to change code, the file should describe what you changed and why; the changed files themselves stay where you wrote them.',
    'Write it as the last thing you do, once the work is actually done.',
  ].join('\n')
}

/** Is `bin` runnable? Asked through the platform's own lookup tool rather
 *  than by starting the binary, because starting it to test it runs it. */
async function onPath(bin) {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [bin])
    return true
  } catch {
    return false
  }
}

/** Split --harness-cmd into a binary and arguments. Not a template, and no
 *  shell: the brief goes to the child on stdin precisely so a client's text
 *  never reaches a command line. */
function parseHarnessCommand(raw) {
  const parts = []
  let cur = ''
  let quote = null
  let any = false
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      any = true
      continue
    }
    if (/\s/.test(ch)) {
      if (cur || any) parts.push(cur)
      cur = ''
      any = false
      continue
    }
    cur += ch
  }
  if (cur || any) parts.push(cur)
  if (quote) return null
  const [bin, ...argv] = parts
  return bin ? { bin, argv } : null
}

/** Chosen once at startup, so a misconfiguration is a refusal to start
 *  rather than every task failing one at a time. */
let HARNESS = null

async function resolveHarnessAtStartup() {
  if (NO_HARNESS) return
  if (HARNESS_CMD) {
    const parsed = parseHarnessCommand(HARNESS_CMD)
    if (!parsed) {
      console.error('Could not read --harness-cmd (unbalanced quote, or empty).')
      process.exit(1)
    }
    if (!WORKDIR) {
      console.error('--harness-cmd needs --workdir: a coding harness with no directory to work in has nothing to do.')
      process.exit(1)
    }
    HARNESS = { id: 'custom', label: parsed.bin, bin: parsed.bin, argv: () => parsed.argv, briefOnStdin: true }
    return
  }
  if (HARNESS_ID) {
    const spec = HARNESSES.find((h) => h.id === HARNESS_ID)
    if (!spec) {
      console.error(
        `Unknown --harness "${HARNESS_ID}". Known: ${HARNESSES.map((h) => h.id).join(', ')}. ` +
          'Any other tool can be attached with --harness-cmd "<its headless command>" — the brief arrives on stdin.',
      )
      process.exit(1)
    }
    if (!WORKDIR) {
      console.error(`--harness ${spec.id} needs --workdir: a coding harness with no directory to work in has nothing to do.`)
      process.exit(1)
    }
    if (!(await onPath(spec.bin))) {
      console.error(`--harness ${spec.id} needs \`${spec.bin}\` on PATH. Install it with: ${spec.install}`)
      process.exit(1)
    }
    HARNESS = spec
    return
  }
  // Nothing asked for. Autodetect only makes sense with a workdir, and only
  // ever UPGRADES a run that was already going to use the built-in loop.
  if (!WORKDIR) return
  for (const id of AUTODETECT_ORDER) {
    const spec = HARNESSES.find((h) => h.id === id)
    if (spec && (await onPath(spec.bin))) {
      HARNESS = spec
      console.log(`[worker] found ${spec.label} on PATH — using it for tasks (--no-harness to use the built-in loop)`)
      return
    }
  }
}

/* ── Repo jobs: the diff IS the deliverable ───────────────────────────────
 * Mirrored from lib/worker-deliverable.ts (tests/worker-deliverable.test.ts).
 *
 * The platform's repo-job brief has always said "submit ONE unified diff in a
 * ```diff fenced block", and the platform side of that is complete: it
 * extracts the diff, validates every path, opens a pull request, lets the
 * repository's own CI grade it, and releases the escrow on merge. Harness
 * mode broke exactly that by appending "write your deliverable to
 * .handsel/deliverable-<task>.md — nothing else you print is read" to EVERY
 * brief, which on a repo job overrides the only instruction that mattered.
 *
 * So a repo job takes a different path: clone into a per-task scratch
 * checkout, run the harness with that as its working directory, and take the
 * diff with git. Nothing in the loop is prose. */
const REPO_ROOT = '.handsel/repos'

function clonePathFor(taskId) {
  const safe = String(taskId).replace(/[^A-Za-z0-9_-]/g, '') || 'task'
  return `${REPO_ROOT}/${safe.slice(0, 64)}`
}

/** owner/repo, both segments starting alphanumeric, no `..`.
 *  This value reaches a git argv and a directory name, and git reads a
 *  leading dash as an OPTION — it has options that execute things, so no
 *  shell has to be involved for that to be code execution here. */
function validRepoName(s) {
  if (typeof s !== 'string' || s.length > 140 || s.includes('..')) return false
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s)
}

function validBranch(b) {
  if (typeof b !== 'string' || !b || b.length > 200 || b.includes('..')) return false
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(b)
}

function repoOf(task) {
  const r = task?.repo
  if (!r || !validRepoName(r.full_name)) return null
  // No branch means the repository's DEFAULT, which is not the same as
  // 'main': octocat/Hello-World defaults to master and a guessed --branch
  // fails the clone outright. --single-branch with no --branch takes the
  // real default, so the right answer needs no lookup.
  const branch = r.base_branch || null
  if (branch && !validBranch(branch)) return null
  return { fullName: r.full_name, baseBranch: branch }
}

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/**
 * Run a repo job end to end and return the submission.
 *
 * The harness runs with the CHECKOUT as its cwd, not the worker's --workdir,
 * so `git diff` at the end is about this job and nothing else — with
 * --concurrency two jobs share a workdir, and one clone between them would
 * put each one's changes in the other's submission.
 */
/* ────────────────────────────────────────────────────────────────────────
 * Run telemetry.
 *
 * This worker knew everything interesting about a run and threw all of it
 * away: which phase it was in, which files the harness touched, what the
 * harness printed, how hard this machine was working. The owner watching
 * from the dashboard got "running", then four minutes of nothing, then
 * "done" — and if the process was killed halfway, "running" forever.
 *
 * No new connection is needed for any of it. The poll loop already POSTs to
 * the platform every few seconds with this agent's secret; it just had
 * nothing to say. Everything below fills that message.
 *
 * Two rules, both mirrored on the server in lib/harness-run.ts:
 *   - A reading we could not take is NULL, never 0. "0% CPU" is a claim
 *     about an idle machine; "no reading" is the truth.
 *   - Nothing here may break a run. Telemetry rides along with paid work;
 *     if it throws, the work still has to finish.
 * ──────────────────────────────────────────────────────────────────────── */

/** taskId → what we have to say about that run on the next poll. */
const runs = new Map()

function beginRun(taskId) {
  runs.set(taskId, { phase: 'plan', events: [], finished: false, ok: null })
}

/** Record one thing that happened. Never throws — see the rule above. */
function note(taskId, text, opts = {}) {
  try {
    const run = runs.get(taskId)
    if (!run || !text) return
    if (opts.phase) run.phase = opts.phase
    // Bounded here as well as on the server: a harness that prints a
    // megabyte a second must not grow this process's memory between polls.
    if (run.events.length > 200) run.events.splice(0, run.events.length - 200)
    run.events.push({
      at: Date.now(),
      phase: opts.phase ?? run.phase,
      text: String(text).slice(0, 300),
      path: opts.path ?? null,
      level: opts.level ?? 'info',
    })
  } catch {
    /* telemetry must never take down a run */
  }
}

function endRun(taskId, ok) {
  const run = runs.get(taskId)
  if (run) {
    run.finished = true
    run.ok = ok
  }
}

/**
 * CPU load since the previous call, from os.cpus() cumulative tick counters.
 *
 * Returns null rather than 0 when there is no interval to measure across —
 * the first call after startup has nothing to diff against, and reporting
 * that as an idle machine would be inventing a measurement.
 */
let lastCpuTimes = os.cpus().map((c) => c.times)
function cpuPercent() {
  try {
    const now = os.cpus().map((c) => c.times)
    let idle = 0
    let total = 0
    for (let i = 0; i < now.length; i += 1) {
      const a = lastCpuTimes[i]
      const b = now[i]
      if (!a) continue
      idle += b.idle - a.idle
      for (const k of Object.keys(b)) total += b[k] - a[k]
    }
    lastCpuTimes = now
    if (total <= 0) return null
    return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)))
  } catch {
    return null
  }
}

function resourceSample() {
  try {
    const totalMb = Math.round(os.totalmem() / 1048576)
    return {
      cpuPct: cpuPercent(),
      memUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
      memTotalMb: totalMb,
    }
  } catch {
    return { cpuPct: null, memUsedMb: null, memTotalMb: null }
  }
}

/**
 * Everything worth saying since the last poll, and reset.
 *
 * Events are cleared once handed over so a slow poll cannot re-send them,
 * and a finished run is dropped after its final report — the platform keeps
 * the history, this process does not need to.
 */
function drainRuns() {
  const out = []
  const sample = resourceSample()
  for (const [taskId, run] of runs) {
    out.push({
      taskId,
      harnessId: HARNESS ? HARNESS.id : null,
      model: flag('harness-model') ?? MODEL ?? null,
      phase: run.phase,
      events: run.events.splice(0, 40),
      sample,
      finished: run.finished,
      ok: run.ok,
    })
    if (run.finished && run.events.length === 0) runs.delete(taskId)
  }
  return out
}

/**
 * Which files the harness has actually changed, straight from git.
 *
 * Reading the checkout beats scanning the harness's own chatter for
 * filenames: `git status` is the ground truth about what is on disk, it
 * needs no per-harness output format, and it cannot be fooled by a model
 * that says it wrote a file it never wrote.
 */
function watchRepoFiles(taskId, cwd) {
  const seen = new Set()
  const tick = async () => {
    try {
      const out = await git(['status', '--porcelain'], cwd)
      for (const line of out.split('\n')) {
        const file = line.slice(3).trim()
        if (!file || seen.has(file)) continue
        seen.add(file)
        note(taskId, `Wrote ${file}`, { phase: 'code', path: file })
      }
    } catch {
      /* the checkout may be mid-write; try again on the next tick */
    }
  }
  const timer = setInterval(tick, 5000)
  return () => {
    clearInterval(timer)
    return tick()
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Media jobs.
 *
 * The worker's contribution here is a machine with ffmpeg on it, and
 * deliberately nothing else. It does not read the job description, does not
 * ask a model what to do, and does not build a command: the platform
 * compiled the argv from a validated recipe (lib/media-recipe.ts) and sent
 * it, and this substitutes two path placeholders and runs the binary.
 *
 * One implementation of "what does this job mean" instead of two that drift
 * until the same job renders differently depending on who claimed it. And no
 * shell anywhere — `execFile`, an argv array, a binary named ffmpeg.
 * ──────────────────────────────────────────────────────────────────────── */

/** 512 MB. A source larger than this is a job for a rendering service, not
 *  for somebody's laptop, and streaming it to disk before finding that out
 *  is how a worker fills a home partition. */
const MEDIA_MAX_SOURCE_BYTES = 512 * 1024 * 1024
/** The callback carries artifacts inline as base64. Past this the render has
 *  to go to blob storage, and saying so beats a 413 from a POST. */
const MEDIA_MAX_INLINE_BYTES = 2 * 1024 * 1024

/** Is ffmpeg actually on this machine? Reported so a media job is matched to
 *  a worker that can do it rather than to one that merely claims 'video'. */
async function detectFfmpeg() {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: 10_000 })
    const line = String(stdout).split('\n')[0].trim()
    return { present: true, version: line.slice(0, 120) }
  } catch {
    return { present: false, version: null }
  }
}

/** Stream the source to disk, refusing anything oversized or non-https. */
async function fetchSource(url, dest, taskId) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error(`source must be https, got ${parsed.protocol}`)
  note(taskId, `Downloading ${parsed.hostname}${parsed.pathname}`, { phase: 'plan' })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`source fetch failed: HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > MEDIA_MAX_SOURCE_BYTES) {
    throw new Error(`source is ${(declared / 1048576).toFixed(0)}MB, over the ${MEDIA_MAX_SOURCE_BYTES / 1048576}MB limit`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  // Checked again after the fact: content-length is a claim, not a promise,
  // and a chunked response does not send one at all.
  if (buf.length > MEDIA_MAX_SOURCE_BYTES) {
    throw new Error(`source turned out to be ${(buf.length / 1048576).toFixed(0)}MB, over the limit`)
  }
  await fs.writeFile(dest, buf)
  note(taskId, `Downloaded ${(buf.length / 1048576).toFixed(1)}MB`, { phase: 'plan', level: 'good' })
  return buf.length
}

async function runMediaTask(task, media) {
  const dir = path.join(os.tmpdir(), `handsel-media-${task.task_id}`)
  await fs.mkdir(dir, { recursive: true })
  const inPath = path.join(dir, 'source')
  const outPath = path.join(dir, 'render.mp4')
  try {
    await fetchSource(media.source_url, inPath, task.task_id)

    const args = media.args.map((a) =>
      a === media.input_token ? inPath : a === media.output_token ? outPath : a,
    )
    // Belt and braces on a value that arrived over the network and is going
    // to a process: the platform built it, but "the other side checks it" is
    // not a property this side gets to assume.
    for (const a of args) {
      if (/[;&|`$\n><]/.test(a)) throw new Error(`refusing an ffmpeg argument containing shell metacharacters: ${a.slice(0, 40)}`)
    }
    note(task.task_id, `ffmpeg ${args.filter((a) => a !== inPath && a !== outPath).join(' ')}`, { phase: 'code' })

    const started = Date.now()
    await execFileAsync('ffmpeg', args, { timeout: HARNESS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
    const bytes = await fs.readFile(outPath)
    note(
      task.task_id,
      `Rendered ${(bytes.length / 1048576).toFixed(2)}MB in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      { phase: 'review', level: 'good', path: 'render.mp4' },
    )

    if (bytes.length > MEDIA_MAX_INLINE_BYTES) {
      throw new Error(
        `render is ${(bytes.length / 1048576).toFixed(1)}MB, over the ${MEDIA_MAX_INLINE_BYTES / 1048576}MB inline limit — ` +
          'ask a smaller output size, a shorter trim, or enable blob storage on the deployment',
      )
    }
    return {
      output: `Rendered with ffmpeg from the job's media recipe. ${bytes.length} bytes.`,
      artifacts: [{ name: 'render.mp4', mime: 'video/mp4', data_base64: bytes.toString('base64') }],
    }
  } finally {
    // The source can be hundreds of megabytes. Leaving it behind fills a
    // disk one job at a time, and the failure shows up on an unrelated run.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function runRepoTask(task, repo) {
  const rel = clonePathFor(task.task_id)
  const dest = path.resolve(WORKDIR, rel)
  await fs.rm(dest, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(path.dirname(dest), { recursive: true })

  console.log(`\n[worker] cloning ${repo.fullName}${repo.baseBranch ? `@${repo.baseBranch}` : ' (default branch)'} → ${rel}`)
  note(task.task_id, `Cloning ${repo.fullName}`, { phase: 'plan' })
  await git(
    [
      'clone',
      '--depth',
      '1',
      '--single-branch',
      ...(repo.baseBranch ? ['--branch', repo.baseBranch] : []),
      '--',
      `https://github.com/${repo.fullName}.git`,
      dest,
    ],
    WORKDIR,
  )
  const baseSha = (await git(['rev-parse', 'HEAD'], dest)).trim()
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dest)).trim()

  const brief = [
    task.task.trim(),
    '',
    '---',
    '',
    'HOW THIS RUN IS SET UP:',
    `${repo.fullName} is already cloned for you at \`${rel}\` on branch \`${branch}\`, and that is your working directory.`,
    'Make the change there, in the files. Do not print a diff and do not write a summary file —',
    'the diff is taken from the checkout with git once you are done, so what is on disk IS the deliverable.',
  ].join('\n')

  note(task.task_id, `Checked out ${branch} at ${baseSha.slice(0, 7)}`, { phase: 'plan', level: 'good' })

  const stopWatching = watchRepoFiles(task.task_id, dest)
  let stdout
  try {
    ;({ stdout } = await spawnHarness(brief, dest, task.task_id))
  } finally {
    // Always drain the watcher, including on a throw: the last tick is the
    // one that sees the files written just before the harness died, which is
    // exactly what someone reading a failed run needs.
    await stopWatching()
  }

  // Stage first: a diff that silently omits CREATED files is the most common
  // way a repo-job submission fails review, and it reads as the worker having
  // forgotten to write them.
  await git(['add', '-A'], dest)
  // Against the recorded base rather than HEAD, so this works whether or not
  // the harness committed its own work — several of them do.
  const diff = await git(['diff', '--cached', '--no-color', '--no-ext-diff', baseSha], dest)

  const hasPatch = diff
    .trim()
    .split('\n')
    .some((l) => l.startsWith('diff --git ') || l.startsWith('--- '))
  if (!hasPatch) {
    throw new Error(
      `${HARNESS.label} changed nothing in ${repo.fullName} — no diff to submit. ` +
        'Submitting a description of work that did not happen is worse than failing the job.',
    )
  }

  const summary = extractHarnessText(stdout).trim().slice(0, 1500)
  console.log(`\n[worker] diff: ${diff.split('\n').length} lines from ${rel}`)
  note(task.task_id, `Diff ready — ${diff.split('\n').length} lines`, { phase: 'review', level: 'good' })
  return [summary, summary ? '' : null, '```diff', diff.trimEnd(), '```'].filter((l) => l !== null).join('\n')
}

/**
 * Run one task through the harness.
 *
 * stdout and stderr are streamed to the console rather than buffered
 * silently: this is somebody's own machine, the run takes minutes, and a
 * progress-free wait is indistinguishable from a hang.
 */
/**
 * Run the harness once and hand back what it said.
 *
 * Split out of runHarnessTask so a repo job can point it at a scratch
 * checkout instead of the worker's own --workdir: with --concurrency two jobs
 * share a workdir, and one clone between them would put each job's changes in
 * the other's submission.
 */
async function spawnHarness(brief, cwd, taskId = null) {
  const argv = HARNESS.argv({ brief, workdir: cwd, model: flag('harness-model') ?? null })
  note(taskId, `${HARNESS.label} started`, { phase: 'code' })
  const { out, code, errTail } = await new Promise((resolve, reject) => {
    const child = spawn(HARNESS.bin, argv, {
      // The CALLER's directory, not WORKDIR: a repo job runs the harness
      // inside its own scratch checkout, and using WORKDIR here silently put
      // every edit one level up, where `git diff` in the checkout could not
      // see it. Found by running it, not by a test.
      cwd,
      stdio: [HARNESS.briefOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let out = ''
    // Kept so a failure explains itself in the TASK RECORD, not only on a
    // console nobody is watching. "produced neither a file nor any output"
    // is a symptom; the harness's own last words are the cause.
    let errTail = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${HARNESS.label} exceeded --harness-timeout (${Math.round(HARNESS_TIMEOUT_MS / 1000)}s)`))
    }, HARNESS_TIMEOUT_MS)
    if (HARNESS.briefOnStdin) child.stdin.end(brief)
    // The same bytes go to two places now: the owner's console, as before,
    // and the run log, so somebody watching from the dashboard sees the same
    // progress the person sitting at the machine does. Line-buffered, since
    // a chunk boundary is not a log entry.
    let pending = ''
    child.stdout.on('data', (d) => {
      out += d
      process.stdout.write(d)
      pending += d
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) note(taskId, line, { phase: 'code' })
    })
    child.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-2000)
      process.stderr.write(d)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`could not run ${HARNESS.bin}: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // A non-zero exit is not automatically a failed task: several of these
      // exit non-zero on a turn limit having already written a usable
      // deliverable. The file decides; the code only colours the log.
      if (code !== 0) console.log(`\n[worker] ${HARNESS.label} exited ${code}`)
      note(taskId, `${HARNESS.label} exited ${code}`, { phase: 'code', level: code === 0 ? 'good' : 'bad' })
      resolve({ out, code, errTail })
    })
  })
  return { stdout: out, code, errTail }
}

async function runHarnessTask(task) {
  const rel = deliverablePathFor(task.task_id)
  const abs = path.resolve(WORKDIR, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  // Never inherit a previous run's file: an interrupted task that left one
  // behind would otherwise be submitted as this task's work.
  await fs.unlink(abs).catch(() => {})

  const brief = harnessBrief(`Working directory: ${WORKDIR}\n\nTask:\n${task.task}`, rel)
  const { stdout, code, errTail } = await spawnHarness(brief, WORKDIR, task.task_id)

  let file = null
  try {
    file = await fs.readFile(abs, 'utf8')
  } catch {
    /* the harness wrote nothing — fall back to what it said */
  }
  if (file && file.trim()) {
    console.log(`\n[worker] deliverable from ${rel} (${file.trim().length} chars)`)
    return file.trim()
  }
  const salvaged = extractHarnessText(stdout).trim()
  if (!salvaged) {
    throw new Error(
      `${HARNESS.label} exited ${code} and produced neither ${rel} nor any output` +
        (errTail.trim() ? `: ${errTail.trim().slice(-600)}` : ''),
    )
  }
  console.log(`\n[worker] ${HARNESS.label} wrote no ${rel} — submitting its output instead`)
  return salvaged
}

/** Fallback only. These event streams are unversioned, so this is tolerant
 *  by design: approximately right beats empty, because an empty submission
 *  fails grading with no clue why. */
function extractHarnessText(stdout) {
  const out = []
  const TEXT_KEYS = new Set(['text', 'result', 'content', 'message', 'response', 'output'])
  const walk = (node, depth) => {
    if (depth > 6 || node === null || node === undefined) return
    if (typeof node === 'string') {
      const t = node.trim()
      if (t) out.push(t)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const type = typeof node.type === 'string' ? node.type : ''
    if (type && /tool|error|usage|thinking|reasoning/i.test(type)) return
    for (const key of Object.keys(node)) if (TEXT_KEYS.has(key)) walk(node[key], depth + 1)
  }
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      walk(JSON.parse(t), 0)
    } catch {
      /* truncated or not an event — skip the line, keep the run */
    }
  }
  const joined = out.join('\n').trim()
  return joined || stdout.trim()
}

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
  beginRun(task.task_id)
  note(task.task_id, `Claimed: ${task.task.split('\n')[0].slice(0, 120)}`, { phase: 'plan' })

  let output = ''
  let artifacts = []
  let success = true
  let error
  try {
    // A media job is decided before anything else looks at the brief: the
    // platform already compiled the recipe, so there is nothing for a model
    // to interpret and handing it one would only invite it to improvise.
    if (task.media) {
      if (!FFMPEG.present) throw new Error('this job needs ffmpeg and it is not on this machine')
      const rendered = await runMediaTask(task, task.media)
      output = rendered.output
      artifacts = rendered.artifacts
    } else {
    // A repo job's deliverable is a diff, not prose — and only a harness with
    // a real checkout can produce one. The built-in loop keeps its own path:
    // it has no git and its brief already tells the model to paste a diff.
    const repo = HARNESS && WORKDIR ? repoOf(task) : null
    output = repo
      ? await runRepoTask(task, repo)
      : HARNESS
        ? await runHarnessTask(task)
        : WORKDIR
          ? await runAgentTask(task.task)
          : await askLocalModel(task.task)
    }
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
  note(
    task.task_id,
    success ? `Submitted after ${executionTime}s` : `Failed: ${String(error).slice(0, 200)}`,
    { phase: 'review', level: success ? 'good' : 'bad' },
  )
  // Marked finished BEFORE the callback, so the very next poll carries the
  // final report even if the callback itself is what fails. A run that ends
  // without one sits on the console as "Running" until it goes stale, which
  // is a worse answer than "failed".
  endRun(task.task_id, success)
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
    // The rendered file itself. Grading reads THESE BYTES (lib/mp4-probe.ts)
    // rather than any claim made about them, which is the only version of a
    // media job where "it rendered correctly" is somebody else's finding.
    ...(artifacts.length > 0 ? { artifacts } : {}),
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
await resolveHarnessAtStartup()
// Only print the model line when that model is what actually runs the work.
// A harness carries its own model and auth, and announcing an Ollama the
// harness never calls is how someone spends an afternoon debugging Ollama.
if (!HARNESS) {
  console.log(`[worker] model    ${MODEL} via ${OPENAI_BASE ? `OpenAI-compatible ${OPENAI_BASE}` : `Ollama ${OLLAMA_BASE}`}`)
}
if (HARNESS) {
  console.log(`[worker] harness  ${HARNESS.label} in ${WORKDIR}`)
  console.log(
    `[worker] NOTE: the harness runs with its approvals off — it can edit and run anything in that directory,\n` +
      `[worker]       and tasks can come from strangers. Point it at a checkout you can throw away.`,
  )
} else if (WORKDIR) {
  console.log(`[worker] workdir  ${WORKDIR}${ALLOW_BASH ? ' (commands allowed)' : ''} — built-in agent loop`)
}

// The built-in loop is what a warm model is for; a harness brings its own.
if (!HARNESS) await warmupModel()

// Probed once at startup, not assumed from a flag: a worker that DECLARES
// video and cannot render is matched to media jobs it will fail, and a
// failed job costs the agent its own credit score.
const FFMPEG = await detectFfmpeg()
console.log(FFMPEG.present ? `[worker] ffmpeg    ${FFMPEG.version}` : '[worker] ffmpeg    not found — media jobs will not be offered')

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
    // The harness is reported on every poll, not once at startup: a worker
    // gets restarted with a different --harness all the time, and a value
    // stored once would go on describing the tool that used to be here.
    ;({ task } = await platformPost('/api/worker/poll', {
      agent_id: AGENT_ID,
      harness: HARNESS ? HARNESS.id : null,
      // Declared from a probe, so the match is on a machine that has the
      // tool rather than on a promise that it does.
      capabilities: FFMPEG.present ? ['text', 'video'] : ['text'],
      ffmpeg: FFMPEG.version,
      // Whatever the running jobs have to say since the last poll. Drained
      // here rather than pushed on a timer of its own: the poll is already
      // an authenticated round trip on a few-second cadence, and a second
      // channel would be a second thing to get wrong.
      runs: drainRuns(),
    }))
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
