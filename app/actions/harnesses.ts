'use server'

/**
 * Reading and writing a person's own harness definitions.
 *
 * `preview` deliberately runs the SAME compile the worker will run, against
 * a sample brief, and hands back either the argv or the error. A definition
 * you cannot see compiled is a definition you find out about four minutes
 * into a paid job — which is the failure this whole editor exists to move
 * earlier.
 */
import { getSession } from '@/lib/get-session'
import {
  CustomHarnessError,
  compileArgv,
  parseCustomHarness,
  workerCommand,
  type CustomHarness,
} from '@/lib/custom-harness'
import { deleteHarness, listHarnesses, saveHarness, type StoredHarness } from '@/lib/custom-harness-server'

/** A brief with the shapes that break naive quoting, so the preview shows
 *  what actually happens to them rather than what happens to "hello". */
const SAMPLE_BRIEF = 'Fix the deposit path; add a test for amount <= 0'

export type HarnessPreview = {
  ok: boolean
  /** The argv the worker will execute, binary first. */
  argv: string[]
  /** The pasteable worker invocation. */
  command: string
  error: string | null
}

async function userId(): Promise<string> {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function getHarnesses(): Promise<StoredHarness[]> {
  return listHarnesses(await userId())
}

/**
 * Compile a draft without storing it.
 *
 * Returns the failure as data rather than throwing: this runs on every
 * keystroke, and a half-typed definition is the normal state of the form,
 * not an exception.
 */
export async function previewHarness(draft: unknown, opts?: { workdir?: string; model?: string | null }): Promise<HarnessPreview> {
  await userId()
  let def: CustomHarness
  try {
    def = parseCustomHarness(draft)
  } catch (e) {
    return { ok: false, argv: [], command: '', error: e instanceof CustomHarnessError ? e.message : String(e) }
  }
  try {
    const argv = compileArgv(def, {
      brief: SAMPLE_BRIEF,
      workdir: opts?.workdir?.trim() || '~/code/scratch',
      deliverable: def.deliverablePath,
      model: opts?.model?.trim() || null,
    })
    return {
      ok: true,
      argv: [def.bin, ...argv],
      command: workerCommand(def, { workdir: opts?.workdir?.trim() || undefined, model: opts?.model?.trim() || null }),
      error: null,
    }
  } catch (e) {
    // Reached by a template that uses {model} with none configured — a real
    // definition error the person can fix, not a crash.
    return { ok: false, argv: [], command: '', error: e instanceof Error ? e.message : String(e) }
  }
}

export async function upsertHarness(draft: unknown): Promise<StoredHarness> {
  return saveHarness(await userId(), draft)
}

export async function removeHarness(id: string): Promise<void> {
  return deleteHarness(await userId(), id)
}
