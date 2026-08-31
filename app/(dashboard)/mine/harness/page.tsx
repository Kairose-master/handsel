'use client'

/**
 * Define your own harness.
 *
 * The built-in adapters cover six tools whose flags were read off their own
 * CLI references. That list is useful and it is also a ceiling: an internal
 * wrapper, a fork, a tool released last week, and the only option was
 * `--harness-cmd`, which passed a fixed argv and always piped the brief on
 * stdin — so a harness wanting the brief as an argument, the way Claude Code
 * does, could not be expressed at all.
 *
 * The editor's real job is to move a failure earlier. A bad definition used
 * to surface four minutes into a paid job as an empty deliverable and a
 * failed grade with no cause on it. Here it surfaces as you type: the
 * preview runs the SAME compile the worker runs, on a sample brief, and
 * shows the argv the process will actually receive — one row per argument,
 * because the whole safety property of this thing is that a brief full of
 * shell characters stays exactly one of them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Check, Copy, Loader2, Plus, Terminal, Trash2 } from 'lucide-react'
import {
  getHarnesses,
  previewHarness,
  removeHarness,
  upsertHarness,
  type HarnessPreview,
} from '@/app/actions/harnesses'
import type { StoredHarness } from '@/lib/custom-harness-server'
import { Chip, PageHead, Panel, StatusDot } from '@/components/deck'

type Draft = {
  id: string
  label: string
  bin: string
  argsTemplate: string
  briefOnStdin: boolean
  deliverablePath: string
}

const BLANK: Draft = {
  id: '',
  label: '',
  bin: '',
  argsTemplate: '',
  briefOnStdin: false,
  deliverablePath: '.handsel/deliverable.md',
}

/** Real invocations, so the first thing someone sees is a shape that works. */
const EXAMPLES: { name: string; draft: Draft }[] = [
  {
    name: 'Brief as an argument',
    draft: {
      id: 'my-cli',
      label: 'My CLI',
      bin: 'my-cli',
      argsTemplate: 'run --yes --out {deliverable} {brief}',
      briefOnStdin: false,
      deliverablePath: '.handsel/deliverable.md',
    },
  },
  {
    name: 'Brief on stdin',
    draft: {
      id: 'pipe-tool',
      label: 'Pipe tool',
      bin: 'pipe-tool',
      argsTemplate: '--workdir {workdir} --write {deliverable}',
      briefOnStdin: true,
      deliverablePath: '.handsel/deliverable.md',
    },
  },
]

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </label>
  )
}

const INPUT =
  'mt-1 h-9 w-full rounded-[var(--radius-sm)] border border-border bg-background px-2.5 font-mono text-xs outline-none focus:border-primary'

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          /* clipboard blocked — the text is on screen and selectable anyway */
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-secondary"
    >
      {done ? <Check className="size-3 text-[var(--success)]" /> : <Copy className="size-3" />}
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

export default function HarnessEditorPage() {
  const [saved, setSaved] = useState<StoredHarness[] | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [workdir, setWorkdir] = useState('~/code/scratch')
  const [model, setModel] = useState('')
  const [preview, setPreview] = useState<HarnessPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setSaved(await getHarnesses())
    } catch {
      setSaved([])
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Compiled on the server by the same code the worker runs, debounced so a
  // form that validates as you type does not mean a request per keystroke.
  const key = useMemo(() => JSON.stringify([draft, workdir, model]), [draft, workdir, model])
  useEffect(() => {
    if (!draft.bin && !draft.argsTemplate) {
      setPreview(null)
      return
    }
    let dead = false
    const t = setTimeout(async () => {
      try {
        const p = await previewHarness(draft, { workdir, model })
        if (!dead) setPreview(p)
      } catch {
        /* signed out mid-edit; the save will say so */
      }
    }, 250)
    return () => {
      dead = true
      clearTimeout(t)
    }
  }, [key, draft, workdir, model])

  const save = async () => {
    setBusy(true)
    setSaveError(null)
    try {
      await upsertHarness(draft)
      await load()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHead
        title="Your own harness"
        subtitle="Point the worker at any tool you have installed. The preview compiles the definition with the same code the worker runs, so a mistake shows up here instead of four minutes into a paid job."
        actions={
          <Link
            href="/mine/runs"
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-secondary"
          >
            <Terminal className="size-3" /> Console
          </Link>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <Panel
          title="Definition"
          actions={
            <div className="flex items-center gap-1">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.name}
                  onClick={() => setDraft(ex.draft)}
                  className="rounded-[var(--radius-sm)] border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider hover:bg-secondary"
                >
                  {ex.name}
                </button>
              ))}
            </div>
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Id" hint="Lowercase slug. Cannot shadow a built-in.">
                <input className={INPUT} value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} placeholder="my-cli" />
              </Field>
              <Field label="Name">
                <input className={INPUT} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="My CLI" />
              </Field>
            </div>

            <Field label="Binary" hint="A bare command on PATH, or an absolute path. No arguments here — no spaces.">
              <input className={INPUT} value={draft.bin} onChange={(e) => setDraft({ ...draft, bin: e.target.value })} placeholder="my-cli" />
            </Field>

            <Field
              label="Arguments"
              hint="Placeholders: {brief} {workdir} {deliverable} {model}. Quotes group. Each placeholder fills ONE argument — a brief with semicolons or newlines in it can never become a second one."
            >
              <textarea
                className={`${INPUT} h-auto py-2`}
                rows={3}
                value={draft.argsTemplate}
                onChange={(e) => setDraft({ ...draft, argsTemplate: e.target.value })}
                placeholder="run --yes --out {deliverable} {brief}"
              />
            </Field>

            <Field label="Deliverable path" hint="Where the harness is told to write its finished work. Relative to the working directory.">
              <input
                className={INPUT}
                value={draft.deliverablePath}
                onChange={(e) => setDraft({ ...draft, deliverablePath: e.target.value })}
              />
            </Field>

            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.briefOnStdin}
                onChange={(e) => setDraft({ ...draft, briefOnStdin: e.target.checked })}
              />
              Pipe the brief on stdin instead of passing <code>{'{brief}'}</code>
            </label>

            <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
              <Field label="Workdir" hint="Only used to render the command below.">
                <input className={INPUT} value={workdir} onChange={(e) => setWorkdir(e.target.value)} />
              </Field>
              <Field label="Model" hint="Required only if you use {model}.">
                <input className={INPUT} value={model} onChange={(e) => setModel(e.target.value)} placeholder="(none)" />
              </Field>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={save}
                disabled={busy || !preview?.ok}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Save
              </button>
              {saveError && <span className="text-xs text-[var(--destructive)]">{saveError}</span>}
            </div>
          </div>
        </Panel>

        <div className="min-w-0 space-y-4">
          <Panel
            title="What the process receives"
            actions={
              preview ? (
                <StatusDot tone={preview.ok ? 'ok' : 'bad'} label={preview.ok ? 'Valid' : 'Invalid'} />
              ) : (
                <StatusDot tone="idle" label="Empty" />
              )
            }
            bodyClassName="p-0"
          >
            {!preview ? (
              <p className="p-3 text-xs text-muted-foreground">Fill in a binary and some arguments.</p>
            ) : preview.ok ? (
              <>
                {/* One row per argument, on purpose. The safety property of
                    this whole feature is that substitution cannot create a
                    new argument, and a single joined line would hide exactly
                    that. */}
                <ol className="divide-y divide-border">
                  {preview.argv.map((a, i) => (
                    <li key={i} className="flex gap-3 px-3 py-1.5">
                      <span className="w-6 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                        {i === 0 ? 'bin' : i}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px]">{a}</span>
                    </li>
                  ))}
                </ol>
                <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                  {preview.argv.length - 1} argument{preview.argv.length === 2 ? '' : 's'} after the binary, rendered with a
                  sample brief. No shell is involved at any point.
                </p>
              </>
            ) : (
              <p className="px-3 py-2 text-xs text-[var(--destructive)]">{preview.error}</p>
            )}
          </Panel>

          {preview?.ok && (
            <Panel title="Run it" actions={<CopyButton text={preview.command} />}>
              <pre className="overflow-x-auto whitespace-pre rounded-[var(--radius-sm)] bg-secondary/50 p-3 font-mono text-[11px] leading-relaxed">
                {preview.command}
              </pre>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Read it before you run it. Handsel never sends a binary name to your worker — this is a command you paste on
                your own machine, and the worker executes the binary directly with an argv array, never through a shell.
              </p>
            </Panel>
          )}

          <Panel title="Saved" bodyClassName="p-0">
            {saved === null ? (
              <p className="p-3 text-xs text-muted-foreground">Loading…</p>
            ) : saved.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                None yet. The six built-in adapters (claude, codex, opencode, cline, gemini, dsh) need no definition —
                these are for everything else.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {saved.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{h.label}</span>
                        <Chip tone="accent">{h.id}</Chip>
                        {h.briefOnStdin && <Chip>stdin</Chip>}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                        {h.bin} {h.argsTemplate}
                      </span>
                    </span>
                    <button
                      onClick={() => setDraft({ ...h })}
                      className="shrink-0 rounded-[var(--radius-sm)] border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider hover:bg-secondary"
                    >
                      Edit
                    </button>
                    <button
                      onClick={async () => {
                        await removeHarness(h.id)
                        await load()
                      }}
                      aria-label={`Delete ${h.label}`}
                      className="shrink-0 rounded-[var(--radius-sm)] border border-border p-1 text-muted-foreground hover:text-[var(--destructive)]"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
