/**
 * Bring your own harness.
 *
 * `lib/worker-harness.ts` ships adapters for six tools whose flags were read
 * off their own CLI references. That list is useful and it is also a
 * ceiling: the moment someone runs a harness that is not on it — an internal
 * wrapper, a fork, a tool released last week — their only option is
 * `--harness-cmd "mytool run"`, which hands over a fixed argv and always
 * pipes the brief on stdin. A harness that wants the brief as an ARGUMENT,
 * the way Claude Code does, cannot be expressed at all.
 *
 * So a harness becomes something a person defines: a binary, an argument
 * template with placeholders, and where the finished work will be found.
 *
 * **Placeholders substitute per ARGUMENT, never into a command line.** This
 * is the whole safety property and it is why there is no shell anywhere near
 * this. A brief is arbitrary text from a job a stranger posted; substituted
 * into a string that is later split on whitespace, a brief containing
 * `; rm -rf ~` becomes new arguments. Substituted into one element of an
 * argv array it stays one argument, whatever is in it, forever.
 *
 * The template is split into arguments FIRST, by
 * `parseHarnessCommand`'s quote-aware splitter, and only then are tokens
 * replaced inside each piece. Order matters and reversing it is the bug.
 */
import { HARNESSES, parseHarnessCommand } from '@/lib/worker-harness'

export class CustomHarnessError extends Error {}

export type CustomHarness = {
  /** Slug the owner refers to it by. */
  id: string
  label: string
  /** A bare command on PATH, or an absolute path. */
  bin: string
  /** Everything after the binary, before token substitution. */
  argsTemplate: string
  /** When true the brief is piped in rather than passed as an argument. */
  briefOnStdin: boolean
  /** Where the harness is told to write its finished work. */
  deliverablePath: string
}

export const DEFAULT_DELIVERABLE_PATH = '.handsel/deliverable.md'

/** Every placeholder a template may use. */
export const TOKENS = ['brief', 'workdir', 'deliverable', 'model'] as const
export type Token = (typeof TOKENS)[number]

export const MAX_ARGS = 40
export const MAX_ARG_LEN = 500

const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/
/** A bare command, or an absolute POSIX/Windows path. Nothing else: a value
 *  with a space or a shell metacharacter in it is somebody trying to smuggle
 *  a second command past an argv array. */
const BIN_RE = /^(?:[A-Za-z0-9._-]+|\/[A-Za-z0-9._\-/]+|[A-Za-z]:\\[A-Za-z0-9._\\ -]+)$/
const TOKEN_RE = /\{([a-z]+)\}/g

const BUILTIN_IDS = new Set(HARNESSES.map((h) => h.id))

export type TokenValues = {
  brief: string
  workdir: string
  deliverable: string
  model: string | null
}

function requireStr(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new CustomHarnessError(`${name} is required`)
  const s = v.trim()
  if (s.length > max) throw new CustomHarnessError(`${name} is longer than ${max} characters`)
  return s
}

/**
 * Where the harness writes its result.
 *
 * Confined to the working directory, because the whole point of a workdir is
 * that a job a stranger posted cannot reach outside it. `..` and absolute
 * paths are how that confinement is escaped, and this is a value that ends
 * up in a filesystem write.
 */
export function validateDeliverablePath(raw: unknown): string {
  const p = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_DELIVERABLE_PATH
  if (p.length > 200) throw new CustomHarnessError('deliverablePath is too long')
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new CustomHarnessError('deliverablePath must be relative to the working directory')
  if (p.split(/[\\/]/).some((seg) => seg === '..')) throw new CustomHarnessError('deliverablePath must not contain ".."')
  if (/[<>|:*?"]/.test(p)) throw new CustomHarnessError('deliverablePath contains characters a filesystem will refuse')
  return p
}

/** Split a template into arguments and check every token in it is real. */
export function templateArgs(template: string): string[] {
  // Quote-aware, no shell — the same splitter the worker already uses for
  // `--harness-cmd`, so a template behaves identically on both sides.
  const parsed = parseHarnessCommand(`x ${template}`)
  if (!parsed) throw new CustomHarnessError('Unbalanced quote in the arguments')
  const args = parsed.argv
  if (args.length > MAX_ARGS) throw new CustomHarnessError(`At most ${MAX_ARGS} arguments, got ${args.length}`)
  for (const a of args) {
    if (a.length > MAX_ARG_LEN) throw new CustomHarnessError(`One argument is longer than ${MAX_ARG_LEN} characters`)
    for (const m of a.matchAll(TOKEN_RE)) {
      if (!(TOKENS as readonly string[]).includes(m[1])) {
        throw new CustomHarnessError(`{${m[1]}} is not a placeholder — use ${TOKENS.map((t) => `{${t}}`).join(', ')}`)
      }
    }
  }
  return args
}

export function parseCustomHarness(raw: unknown): CustomHarness {
  if (!raw || typeof raw !== 'object') throw new CustomHarnessError('A harness definition must be an object')
  const r = raw as Record<string, unknown>

  const id = requireStr(r.id, 'id', 32).toLowerCase()
  if (!ID_RE.test(id)) throw new CustomHarnessError('id must be 2-31 lowercase letters, digits or hyphens')
  if (BUILTIN_IDS.has(id as never)) {
    throw new CustomHarnessError(`"${id}" is a built-in harness — pick another id so the two cannot be confused`)
  }

  const bin = requireStr(r.bin, 'bin', 200)
  if (!BIN_RE.test(bin)) {
    throw new CustomHarnessError('bin must be a bare command or an absolute path — no spaces, no shell characters')
  }

  const argsTemplate = typeof r.argsTemplate === 'string' ? r.argsTemplate.trim() : ''
  const args = templateArgs(argsTemplate)
  const briefOnStdin = Boolean(r.briefOnStdin)
  const usesBrief = args.some((a) => a.includes('{brief}'))

  // Only BOTH is a mistake. A template with no {brief} means stdin, which is
  // what `--harness-cmd` has always done — the first version of this treated
  // "neither" as an error and that was wrong twice over: it rejected a
  // perfectly good definition, and the matching worker check broke every
  // existing --harness-cmd on upgrade, the one `connect_local_worker` hands
  // out included.
  if (briefOnStdin && usesBrief) {
    throw new CustomHarnessError('The brief would be sent twice — use {brief} in the arguments OR stdin, not both')
  }

  return {
    id,
    label: requireStr(r.label ?? bin, 'label', 60),
    bin,
    argsTemplate,
    // Derived, not just echoed: a definition that reaches a worker must say
    // unambiguously how the brief arrives, and "neither flag nor token" is
    // stdin. Storing the derived value is what makes workerCommand emit an
    // explicit --harness-stdin rather than relying on the same default
    // holding on the other side.
    briefOnStdin: briefOnStdin || !usesBrief,
    deliverablePath: validateDeliverablePath(r.deliverablePath),
  }
}

/**
 * The argv this harness runs with, for one task.
 *
 * Substitution happens INSIDE each already-split argument, so a brief
 * containing quotes, newlines or semicolons can never become a second
 * argument. `{model}` with no model configured is an error rather than an
 * empty string: `--model ""` is not what anybody meant, and a silently
 * dropped flag makes a run use the wrong model without saying so.
 */
export function compileArgv(def: CustomHarness, values: TokenValues): string[] {
  const map: Record<Token, string | null> = {
    brief: values.brief,
    workdir: values.workdir,
    deliverable: values.deliverable,
    model: values.model,
  }
  return templateArgs(def.argsTemplate).map((arg) =>
    arg.replace(TOKEN_RE, (_whole, name: string) => {
      const v = map[name as Token]
      if (v === null || v === undefined) {
        throw new CustomHarnessError(`This harness uses {${name}}, but no ${name} was given — start the worker with --harness-model`)
      }
      return v
    }),
  )
}

/**
 * The command line that runs this harness, ready to paste.
 *
 * The definition is only worth anything if it can leave the page. Rather
 * than a new fetch-a-binary-name-from-the-server path — which is the worker
 * being told what to execute by something on the network — the page hands
 * back the exact invocation, and the owner runs it on their own machine
 * having read it.
 *
 * No token placeholder, because there is nothing to paste any more:
 * `--login` takes an email and password and writes the token to
 * `~/.handsel/worker-token` itself. It is also safe to leave in the command
 * permanently — the worker resolves `--token`, then `--login`, then the
 * saved file, and running `--login` a second time logs back in rather than
 * standing up a duplicate agent. So this stays one line that works on the
 * first run and every run after it, instead of two the reader has to
 * choose between.
 */
export function workerCommand(def: CustomHarness, opts: { workdir?: string; model?: string | null }): string {
  const q = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)
  const cmd = [def.bin, def.argsTemplate].filter(Boolean).join(' ')
  const parts = [
    'npx handsel-worker --login',
    `--workdir ${q(opts.workdir ?? '~/code/scratch')}`,
    `--harness-cmd ${q(cmd)}`,
    `--harness-deliverable ${q(def.deliverablePath)}`,
  ]
  if (opts.model) parts.push(`--harness-model ${q(opts.model)}`)
  if (def.briefOnStdin) parts.push('--harness-stdin')
  return parts.join(' \\\n  ')
}
