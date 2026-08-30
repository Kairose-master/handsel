/**
 * Attaching a real coding harness instead of growing another one in here.
 *
 * `public/handsel-worker.mjs` grew its own agent loop — a text grammar
 * (lib/worker-agent-protocol.ts), a step budget, path confinement, a
 * read/write/list/bash executor. It works, and it is the only thing that
 * works against a bare Ollama with no tool-calling. But as an ENGINEERING
 * agent it is a worse version of software that already exists and is
 * maintained by people who do nothing else: Claude Code, Codex, OpenCode,
 * Cline, Gemini CLI, DeepSeek's harness. Every one of them is installable,
 * headless, and BYO-model.
 *
 * So the worker gains a second mode. `--harness <id>` hands the whole task
 * to one of those and submits what it produced. Handsel's job stops being
 * "be a coding agent" and becomes what it actually is: find the work, hold
 * the escrow, grade the result, pay. The loop stays as the fallback for
 * installs that have no harness — deleting it would strand exactly the
 * local-model owners this worker was written for.
 *
 * ── Two design choices worth defending ────────────────────────────────────
 *
 * 1. THE DELIVERABLE COMES FROM A FILE, NOT FROM STDOUT.
 *
 *    Each of these tools has a `--json` mode, and each emits a different,
 *    unversioned event stream. Parsing five schemas — and re-parsing them
 *    every time one ships a release — is a maintenance burden with no upside
 *    and a silent failure mode: an event shape changes, the extractor finds
 *    nothing, and the worker submits an empty deliverable that fails grading
 *    for a reason nobody can see. So the brief instead tells the harness to
 *    write its finished work to a known path, and we read that file. It is
 *    the one interface all of them already share (they can all write files —
 *    that is what they are for), and it is stable by construction.
 *
 *    Stdout parsing survives only as a fallback, deliberately tolerant.
 *
 * 2. EVERY ADAPTER PASSES THE HARNESS'S AUTO-APPROVAL FLAG.
 *
 *    Not an oversight — a headless run that stops to ask a human never
 *    answers, and the job's deadline expires with the escrow still held. A
 *    harness that cannot act without approval cannot be a worker. Which
 *    makes `--harness` strictly MORE permissive than the built-in loop's
 *    `--allow-bash`, and it has to be documented as exactly that, not
 *    slipped in as a convenience.
 *
 * Pure: argv construction and output selection only. The spawning lives in
 * the worker, so the part that decides what command runs on someone's
 * machine is testable without running anything.
 */

export type HarnessId = 'claude' | 'codex' | 'opencode' | 'cline' | 'gemini' | 'dsh'

/** Where a harness is told to leave its finished work, relative to the
 *  workdir. Read back verbatim and submitted as the deliverable. */
export const DELIVERABLE_PATH = '.handsel/deliverable.md'

/**
 * The per-task deliverable path.
 *
 * One fixed filename would be two bugs at once. `--concurrency` runs several
 * tasks in the same workdir, so two harnesses would write over each other and
 * both clients would get one of the answers. And a leftover file from a
 * previous task is worse than none: the next task finds it, submits it, and
 * a paying client is handed somebody else's deliverable — which grades as
 * plausible work and settles.
 *
 * The id is sanitised because it names a file on the owner's disk; a task id
 * carrying `../` would otherwise choose where that file lands.
 */
export function deliverablePathFor(taskId: string): string {
  const safe = String(taskId).replace(/[^A-Za-z0-9_-]/g, '') || 'task'
  return `.handsel/deliverable-${safe.slice(0, 64)}.md`
}

export type HarnessInput = {
  brief: string
  /** The directory the harness works in — always the child process's cwd,
   *  so a harness with no directory flag still lands in the right place. */
  workdir: string
  /** Passed through to the harness's own model selector when set. Null means
   *  "whatever that harness is already configured to use", which is the
   *  common case: these tools carry their own auth and model config. */
  model?: string | null
}

export type HarnessSpec = {
  id: HarnessId
  /** The binary as it appears on PATH. */
  bin: string
  label: string
  /** How to get it, quoted in the error when it is missing. */
  install: string
  docs: string
  /** Everything after the binary. */
  argv: (input: HarnessInput) => string[]
}

/**
 * The adapters.
 *
 * Flags here were read off each tool's own CLI reference, not inferred from
 * the shape of a sibling — these five agree on nothing, including which
 * letter `-c` is. Long forms throughout, for that reason: `-c` is
 * `--continue` to OpenCode and `--cwd` to Cline, and a short form that ends
 * up on the wrong tool fails in a way that reads like the model being bad at
 * its job.
 */
export const HARNESSES: readonly HarnessSpec[] = [
  {
    id: 'claude',
    bin: 'claude',
    label: 'Claude Code',
    install: 'npm i -g @anthropic-ai/claude-code',
    docs: 'https://code.claude.com/docs',
    // No --add-dir. It is VARIADIC (`--add-dir <directories...>`), so it
    // swallows every following positional — including the brief, which then
    // arrives as a second directory and the run dies with "Input must be
    // provided either through stdin or as a prompt argument". Found by
    // running the real binary, not by reading the flag list. The workdir is
    // already the child's cwd, which is the access grant that matters, so
    // the flag was redundant as well as harmful.
    argv: (i) => [
      '--print',
      ...(i.model ? ['--model', i.model] : []),
      // Headless runs cannot answer a permission prompt; see the header.
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
    docs: 'https://developers.openai.com/codex/cli/reference',
    argv: (i) => [
      'exec',
      ...(i.model ? ['--model', i.model] : []),
      '--cd',
      i.workdir,
      '--full-auto',
      // A scratch checkout handed to a worker is often not a git repo, and
      // refusing to start on that basis is not a safety property here.
      '--skip-git-repo-check',
      i.brief,
    ],
  },
  {
    id: 'opencode',
    bin: 'opencode',
    label: 'OpenCode',
    install: 'npm i -g opencode-ai',
    docs: 'https://opencode.ai/docs/cli/',
    argv: (i) => [
      'run',
      ...(i.model ? ['--model', i.model] : []),
      '--dir',
      i.workdir,
      '--auto',
      i.brief,
    ],
  },
  {
    id: 'cline',
    bin: 'cline',
    label: 'Cline CLI',
    install: 'npm i -g cline',
    docs: 'https://docs.cline.bot/cline-cli/three-core-flows',
    argv: (i) => [
      '--yolo',
      ...(i.model ? ['--model', i.model] : []),
      '--cwd',
      i.workdir,
      i.brief,
    ],
  },
  {
    id: 'gemini',
    bin: 'gemini',
    label: 'Gemini CLI',
    install: 'npm i -g @google/gemini-cli',
    docs: 'https://geminicli.com/docs/cli/headless/',
    argv: (i) => [
      ...(i.model ? ['--model', i.model] : []),
      '--yolo',
      '--prompt',
      i.brief,
    ],
  },
  {
    id: 'dsh',
    bin: 'dsh',
    label: 'DeepSeek Harness',
    install: 'npm i -g @deepseek-ai/dsh',
    docs: 'https://github.com/deepseek-ai/deepseek-harness',
    // dsh's published entry point is its web UI, and its headless flags are
    // not documented at the version pinned here. Rather than guess a command
    // line and ship a worker that fails on someone else's machine, this
    // adapter carries only what is certain — the brief on stdin, the workdir
    // as cwd — and `--harness-cmd` is the supported way to run it (or
    // anything else) until that reference exists. See harnessNeedsCommand.
    argv: () => [],
  },
]

/** Adapters whose flags this repo has NOT verified against a published CLI
 *  reference. Selecting one without `--harness-cmd` is refused rather than
 *  guessed at. */
export const UNVERIFIED: readonly HarnessId[] = ['dsh']

export function harnessNeedsCommand(id: HarnessId): boolean {
  return UNVERIFIED.includes(id)
}

/**
 * Flags that take a LIST, per tool.
 *
 * Found the hard way, by running the real binary: Claude Code's `--add-dir`
 * is `<directories...>`, so it swallowed the brief that followed it and the
 * run died with "Input must be provided either through stdin or as a prompt
 * argument". The flag list alone does not warn you — the arity is in the
 * angle brackets and it is easy to read past.
 *
 * Any adapter that ever needs one of these must place it so that a
 * positional brief cannot be eaten. Pinned by a test rather than a comment,
 * because the next person adding an adapter will not read this.
 */
export const VARIADIC_FLAGS: Readonly<Record<string, readonly string[]>> = {
  claude: ['--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--file', '--betas'],
  gemini: ['--include-directories'],
  opencode: ['--file'],
  codex: [],
  cline: [],
  dsh: [],
}

export function harnessById(id: string): HarnessSpec | null {
  return HARNESSES.find((h) => h.id === id) ?? null
}

/**
 * Which harness to use, given what the owner asked for and what is on PATH.
 *
 * Autodetect order is deliberate and is NOT a quality ranking: it puts the
 * tools whose headless contract is most explicitly specified first, because
 * a wrong pick here costs a real bounty.
 */
export const AUTODETECT_ORDER: readonly HarnessId[] = ['claude', 'codex', 'opencode', 'cline', 'gemini']

export type HarnessChoice =
  | { ok: true; spec: HarnessSpec }
  | { ok: false; reason: string }
  /** Nothing requested and nothing installed — run the built-in loop. */
  | { ok: false; fallback: true; reason: string }

export function resolveHarness(input: {
  requested: string | null
  installed: readonly string[]
}): HarnessChoice {
  const installed = new Set(input.installed)
  if (input.requested) {
    const spec = harnessById(input.requested)
    if (!spec) {
      return {
        ok: false,
        reason: `Unknown --harness "${input.requested}". Known: ${HARNESSES.map((h) => h.id).join(', ')}. Any other tool can be attached with --harness-cmd.`,
      }
    }
    if (harnessNeedsCommand(spec.id)) {
      return {
        ok: false,
        reason: `${spec.label}'s headless command line is not verified here, so this worker will not guess at it. Run it with --harness-cmd "<its own headless command>" instead — the brief arrives on stdin and the working directory is the process cwd. ${spec.docs}`,
      }
    }
    if (!installed.has(spec.bin)) {
      return {
        ok: false,
        reason: `--harness ${spec.id} needs \`${spec.bin}\` on PATH. Install it with: ${spec.install}`,
      }
    }
    return { ok: true, spec }
  }
  for (const id of AUTODETECT_ORDER) {
    const spec = harnessById(id)
    if (spec && installed.has(spec.bin)) return { ok: true, spec }
  }
  return {
    ok: false,
    fallback: true,
    reason: 'No coding harness found on PATH — using the built-in loop. Install one for real engineering work: ' + HARNESSES.filter((h) => !harnessNeedsCommand(h.id)).map((h) => h.install).join(' · '),
  }
}

/**
 * The instruction appended to every brief handed to a harness.
 *
 * The whole file-handoff contract lives in these words, so they say what
 * happens rather than merely asking: a harness that finishes its work and
 * writes nothing has produced nothing this platform can submit or grade.
 */
export function deliverableInstruction(path: string = DELIVERABLE_PATH): string {
  return [
    '',
    '---',
    '',
    'HOW THIS IS SUBMITTED:',
    `When you are finished, write your complete deliverable to \`${path}\` (create the directory if needed).`,
    'That file is what gets submitted to the client and graded — nothing else you print is read.',
    'If the task was to change code, the file should describe what you changed and why; the changed files themselves stay where you wrote them.',
    'Write it as the last thing you do, once the work is actually done.',
  ].join('\n')
}

export function harnessBrief(brief: string, path: string = DELIVERABLE_PATH): string {
  return `${brief}\n${deliverableInstruction(path)}`
}

/**
 * Pull something submittable out of a harness's stdout.
 *
 * Only ever a FALLBACK (see the header). Tolerant on purpose: these event
 * streams are unversioned, so this walks JSON lines collecting anything that
 * looks like assistant text, and gives up to the raw stream rather than
 * returning nothing. Being approximately right beats being empty — an empty
 * submission fails grading with no clue why.
 */
export function extractHarnessText(stdout: string): string {
  const collected: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    collect(obj, collected, 0)
  }
  const joined = collected.join('\n').trim()
  if (joined) return joined
  // Nothing extracted. Either it was a plain-text run, or the event schema
  // moved under us. Both cases hand back the raw stream: a human reading the
  // task record can see what actually happened, which an empty string hides.
  return stdout.trim()
}

const TEXT_KEYS = new Set(['text', 'result', 'content', 'message', 'response', 'output'])

function collect(node: unknown, out: string[], depth: number): void {
  if (depth > 6 || node === null || node === undefined) return
  if (typeof node === 'string') {
    const s = node.trim()
    if (s) out.push(s)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  // A tool-call or error event is not the deliverable, and pulling its text
  // in produces a submission made of the agent's scratch work.
  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type && /tool|error|usage|thinking|reasoning/i.test(type)) return
  for (const key of Object.keys(obj)) {
    if (TEXT_KEYS.has(key)) collect(obj[key], out, depth + 1)
  }
}

export type DeliverableSource = 'file' | 'stdout'

/** What to submit, and where it came from. Null when the harness produced
 *  neither a file nor any output — a failed run, reported as one. */
export function chooseDeliverable(input: {
  file: string | null
  stdout: string
}): { text: string; from: DeliverableSource } | null {
  const file = (input.file ?? '').trim()
  if (file) return { text: file, from: 'file' }
  const stdout = extractHarnessText(input.stdout).trim()
  if (stdout) return { text: stdout, from: 'stdout' }
  return null
}

/**
 * Split a `--harness-cmd` string into a binary and its arguments.
 *
 * The escape hatch for every tool with no adapter here — including DeepSeek
 * Harness until its headless reference exists. Deliberately NOT a template:
 * substituting a stranger's task text into a command string is a shell
 * injection with extra steps. The brief goes to the child on STDIN and the
 * workdir is its cwd, so nothing the client wrote ever reaches a command
 * line.
 *
 * Quotes group; everything else splits on whitespace. No shell is involved.
 */
export function parseHarnessCommand(raw: string): { bin: string; argv: string[] } | null {
  const parts: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
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
  if (quote) return null // unbalanced quote — refuse rather than mis-split
  const [bin, ...argv] = parts
  if (!bin) return null
  return { bin, argv }
}
