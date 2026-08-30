import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  HARNESSES,
  AUTODETECT_ORDER,
  DELIVERABLE_PATH,
  harnessById,
  harnessNeedsCommand,
  resolveHarness,
  harnessBrief,
  deliverableInstruction,
  extractHarnessText,
  chooseDeliverable,
  parseHarnessCommand,
  deliverablePathFor,
  VARIADIC_FLAGS,
} from '@/lib/worker-harness'

const input = { brief: 'Fix the failing test', workdir: '/home/me/scratch', model: null }

describe('the adapters', () => {
  it('puts the brief and the workdir into every verified command line', () => {
    for (const spec of HARNESSES) {
      if (harnessNeedsCommand(spec.id)) continue
      const argv = spec.argv(input)
      expect(argv, spec.id).toContain('Fix the failing test')
      // Either an explicit directory flag or the process cwd — but a harness
      // that takes a directory flag must actually be given one, or it works
      // on whatever directory the worker happened to start in.
      const hasDirFlag = argv.some((a) => ['--dir', '--cwd', '--cd', '--add-dir'].includes(a))
      if (hasDirFlag) expect(argv, spec.id).toContain('/home/me/scratch')
    }
  })

  it('passes an auto-approval flag on every verified harness', () => {
    // Not a convenience: a headless run that stops to ask a human never
    // answers, and the job's deadline expires with the escrow still held.
    const approvals = ['--permission-mode', '--full-auto', '--auto', '--yolo', '--dangerously-skip-permissions']
    for (const spec of HARNESSES) {
      if (harnessNeedsCommand(spec.id)) continue
      expect(spec.argv(input).some((a) => approvals.includes(a)), spec.id).toBe(true)
    }
  })

  it('only passes a model flag when one was asked for', () => {
    for (const spec of HARNESSES) {
      if (harnessNeedsCommand(spec.id)) continue
      const without = spec.argv(input)
      expect(without.some((a) => a === '--model' || a === '-m'), spec.id).toBe(false)
      const withModel = spec.argv({ ...input, model: 'some-model' })
      expect(withModel, spec.id).toContain('--model')
      expect(withModel, spec.id).toContain('some-model')
    }
  })

  it('uses long flags only', () => {
    // These five agree on nothing, including which letter -c is: it is
    // --continue to OpenCode and --cwd to Cline. A short form on the wrong
    // tool fails in a way that reads like the model being bad at its job.
    for (const spec of HARNESSES) {
      for (const a of spec.argv({ ...input, model: 'm' })) {
        if (a.startsWith('-') && !a.startsWith('--')) {
          throw new Error(`${spec.id} uses the short flag ${a}`)
        }
      }
    }
  })

  it('never lets the brief be read as a flag', () => {
    // A client writes the brief. If it begins with a dash and lands where a
    // flag is expected, the harness parses a stranger's text as its own
    // configuration.
    const hostile = { ...input, brief: '--dangerously-do-something' }
    for (const spec of HARNESSES) {
      if (harnessNeedsCommand(spec.id)) continue
      const argv = spec.argv(hostile)
      const at = argv.indexOf('--dangerously-do-something')
      expect(at, spec.id).toBeGreaterThanOrEqual(0)
      // It is either the final positional, or immediately after the flag
      // that names it as a value.
      const isLast = at === argv.length - 1
      const namedByFlag = at > 0 && ['--prompt', '--print', '--message'].includes(argv[at - 1])
      expect(isLast || namedByFlag, spec.id).toBe(true)
    }
  })
})

describe('resolveHarness', () => {
  it('uses what was asked for when it is installed', () => {
    const got = resolveHarness({ requested: 'codex', installed: ['codex', 'claude'] })
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.spec.bin).toBe('codex')
  })

  it('names the install command rather than silently picking another', () => {
    // Substituting a different harness for the one an owner named would
    // quietly change which vendor their machine talks to.
    const got = resolveHarness({ requested: 'codex', installed: ['claude'] })
    expect(got.ok).toBe(false)
    expect('fallback' in got).toBe(false)
    if (!got.ok) expect(got.reason).toContain('npm i -g @openai/codex')
  })

  it('refuses a harness whose headless flags were never verified', () => {
    // Guessing a command line ships a worker that fails on someone else's
    // machine, which the platform reads as the agent failing the job.
    const got = resolveHarness({ requested: 'dsh', installed: ['dsh'] })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('--harness-cmd')
  })

  it('lists what it knows when the name is not one of them', () => {
    const got = resolveHarness({ requested: 'aider', installed: [] })
    expect(got.ok).toBe(false)
    if (!got.ok) {
      expect(got.reason).toContain('claude')
      expect(got.reason).toContain('--harness-cmd')
    }
  })

  it('autodetects in the documented order', () => {
    const got = resolveHarness({ requested: null, installed: ['gemini', 'opencode', 'claude'] })
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.spec.id).toBe(AUTODETECT_ORDER.find((id) => ['gemini', 'opencode', 'claude'].includes(id)))
  })

  it('falls back to the built-in loop rather than failing the task', () => {
    // The local-model owners this worker was written for have none of these
    // installed, and must keep working.
    const got = resolveHarness({ requested: null, installed: [] })
    expect(got.ok).toBe(false)
    expect('fallback' in got && got.fallback).toBe(true)
  })

  it('never autodetects an unverified harness', () => {
    expect(AUTODETECT_ORDER).not.toContain('dsh')
  })
})

describe('the deliverable handoff', () => {
  it('tells the harness where the submitted work goes', () => {
    const brief = harnessBrief('Do the thing')
    expect(brief).toContain('Do the thing')
    expect(brief).toContain(DELIVERABLE_PATH)
    expect(deliverableInstruction()).toMatch(/graded/)
  })

  it('prefers the file over stdout', () => {
    const got = chooseDeliverable({ file: '# Report\n\nDone.', stdout: 'lots of chatter' })
    expect(got).toEqual({ text: '# Report\n\nDone.', from: 'file' })
  })

  it('falls back to stdout when the harness wrote no file', () => {
    const got = chooseDeliverable({ file: null, stdout: 'the answer' })
    expect(got).toEqual({ text: 'the answer', from: 'stdout' })
  })

  it('treats a whitespace-only file as no file', () => {
    const got = chooseDeliverable({ file: '   \n\n', stdout: 'the answer' })
    expect(got?.from).toBe('stdout')
  })

  it('reports a run that produced nothing, instead of submitting empty', () => {
    expect(chooseDeliverable({ file: null, stdout: '   ' })).toBe(null)
  })
})

describe('extractHarnessText', () => {
  it('pulls assistant text out of a JSONL event stream', () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"first part"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"second part"}]}}',
      '{"type":"result","result":"first part\\nsecond part"}',
    ].join('\n')
    const got = extractHarnessText(stdout)
    expect(got).toContain('first part')
    expect(got).toContain('second part')
  })

  it('leaves out tool calls, errors and reasoning', () => {
    // Otherwise the submission is made of the agent's scratch work.
    const stdout = [
      '{"type":"tool_use","name":"bash","text":"rm -rf build"}',
      '{"type":"thinking","text":"maybe I should"}',
      '{"type":"error","text":"ENOENT"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"the real answer"}]}}',
    ].join('\n')
    const got = extractHarnessText(stdout)
    expect(got).toContain('the real answer')
    expect(got).not.toContain('rm -rf build')
    expect(got).not.toContain('maybe I should')
    expect(got).not.toContain('ENOENT')
  })

  it('hands back plain output unchanged', () => {
    expect(extractHarnessText('just prose\nover two lines')).toBe('just prose\nover two lines')
  })

  it('hands back the raw stream when the schema yields nothing', () => {
    // A silently-empty submission fails grading with no clue why; showing
    // the stream at least makes the cause readable in the task record.
    const stdout = '{"kind":"unknown","payload":{"weird":1}}'
    expect(extractHarnessText(stdout)).toBe(stdout)
  })

  it('survives a truncated line', () => {
    const stdout = '{"type":"assistant","message":{"content":[{"type":"text","text":"kept"}]}}\n{"type":"assist'
    expect(extractHarnessText(stdout)).toContain('kept')
  })
})

describe('parseHarnessCommand', () => {
  it('splits a plain command', () => {
    expect(parseHarnessCommand('mytool run --headless')).toEqual({ bin: 'mytool', argv: ['run', '--headless'] })
  })

  it('keeps quoted arguments together', () => {
    expect(parseHarnessCommand('mytool --flag "two words" x')).toEqual({
      bin: 'mytool',
      argv: ['--flag', 'two words', 'x'],
    })
  })

  it('keeps a deliberately empty argument', () => {
    expect(parseHarnessCommand('mytool --sep ""')).toEqual({ bin: 'mytool', argv: ['--sep', ''] })
  })

  it('refuses an unbalanced quote instead of mis-splitting it', () => {
    expect(parseHarnessCommand('mytool "oops')).toBe(null)
  })

  it('refuses an empty command', () => {
    expect(parseHarnessCommand('   ')).toBe(null)
  })

  it('never invokes a shell, so metacharacters stay literal', () => {
    // The brief goes on stdin precisely so a client's text never reaches a
    // command line; this pins that the command itself is not shell-expanded.
    const got = parseHarnessCommand('mytool "a; rm -rf /"')
    expect(got).toEqual({ bin: 'mytool', argv: ['a; rm -rf /'] })
  })
})

describe('the worker ships the same command lines', () => {
  // The worker is a standalone zero-dependency file, so the registry is
  // mirrored there rather than imported. A mirror that drifts silently
  // ships a wrong command line to someone else's machine, so pin the part
  // that matters: the flags themselves.
  const worker = readFileSync('public/handsel-worker.mjs', 'utf8')

  it('carries every verified adapter, with its flags', () => {
    for (const spec of HARNESSES) {
      if (harnessNeedsCommand(spec.id)) continue
      expect(worker, spec.id).toContain(`'${spec.id}'`)
      for (const flag of spec.argv({ ...input, model: 'm' })) {
        if (flag.startsWith('--')) expect(worker, `${spec.id} ${flag}`).toContain(flag)
      }
    }
  })

  it('computes the same deliverable path as this module', () => {
    // Not a substring check: if the two disagree the worker submits a file
    // nothing wrote, or reads one belonging to another task. Run the
    // worker's own copy and compare it.
    const src = worker.match(/function deliverablePathFor\(taskId\) \{[\s\S]*?\n\}/)
    expect(src, 'deliverablePathFor missing from the worker').not.toBe(null)
    const theirs = new Function(
      `const DELIVERABLE_DIR = '.handsel'; ${src![0]}; return deliverablePathFor`,
    )() as (id: string) => string
    for (const id of ['abc', 'a-b_c', '../../etc/passwd', '', '...', 'x'.repeat(200)]) {
      expect(theirs(id), id).toBe(deliverablePathFor(id))
    }
    expect(DELIVERABLE_PATH.startsWith('.handsel/')).toBe(true)
  })

  it('actually spawns the harness and reads that file back', () => {
    expect(worker).toMatch(/spawn\(/)
    expect(worker).toMatch(/--harness-cmd/)
  })
})

describe('harnessById', () => {
  it('is null for anything not in the registry', () => {
    expect(harnessById('nope')).toBe(null)
    expect(harnessById('claude')?.label).toBe('Claude Code')
  })
})

describe('deliverablePathFor', () => {
  it('gives each task its own file', () => {
    // --concurrency runs several tasks in one workdir; a shared filename
    // would have two harnesses overwrite each other, and would let a
    // leftover file from a previous task be submitted to the next client.
    expect(deliverablePathFor('abc')).not.toBe(deliverablePathFor('def'))
    expect(deliverablePathFor('abc')).toBe('.handsel/deliverable-abc.md')
  })

  it('cannot be steered out of the directory by a task id', () => {
    // The id names a file on the owner's disk.
    expect(deliverablePathFor('../../etc/passwd')).toBe('.handsel/deliverable-etcpasswd.md')
    expect(deliverablePathFor('a/b')).toBe('.handsel/deliverable-ab.md')
    expect(deliverablePathFor('')).toBe('.handsel/deliverable-task.md')
    expect(deliverablePathFor('...')).toBe('.handsel/deliverable-task.md')
  })
})

describe('list-taking flags never eat the brief', () => {
  // The defect this pins, found by running the real binary: Claude Code's
  // `--add-dir <directories...>` is variadic, so `--add-dir DIR <brief>`
  // parses the brief as a second directory and the run dies with "Input must
  // be provided either through stdin or as a prompt argument". Reading the
  // flag list does not warn you — the arity hides in the angle brackets.
  it('places no variadic flag where a positional can be swallowed', () => {
    for (const spec of HARNESSES) {
      if (harnessNeedsCommand(spec.id)) continue
      const variadic = VARIADIC_FLAGS[spec.id] ?? []
      const argv = spec.argv({ ...input, model: 'm' })
      for (const flag of variadic) {
        const at = argv.indexOf(flag)
        if (at === -1) continue
        // A variadic flag may only be followed by its own values and then
        // another flag — never by the trailing brief.
        const rest = argv.slice(at + 1)
        const nextFlag = rest.findIndex((a) => a.startsWith('--'))
        const swallowed = nextFlag === -1 ? rest : rest.slice(0, nextFlag)
        expect(swallowed, `${spec.id} ${flag} swallows`).not.toContain(input.brief)
      }
    }
  })

  it('knows the arity of every registered harness', () => {
    for (const spec of HARNESSES) {
      expect(Object.keys(VARIADIC_FLAGS), spec.id).toContain(spec.id)
    }
  })
})
