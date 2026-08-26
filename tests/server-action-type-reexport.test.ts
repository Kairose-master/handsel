/**
 * A 'use server' module must not re-export an imported type.
 *
 * `export type { OfficeSlot }` in app/actions/office.ts did not survive
 * Next's server-action transform: it left a runtime reference, so evaluating
 * the module threw "OfficeSlot is not defined" and EVERY action in it failed.
 * On the deployed site that read as the office tabs disappearing, the office
 * panel stuck on "Loading your agents…", and the hire dialog reporting no
 * agents for an account that had a funded, provisioned one.
 *
 * Locally-declared types are fine (`export type Foo = …`) — those compile
 * away cleanly. Only the re-export form breaks, and it breaks silently at
 * runtime, which is why it gets a test rather than a code comment.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
  })
}

describe("'use server' modules", () => {
  const files = walk(join(process.cwd(), 'app')).filter((f) =>
    readFileSync(f, 'utf8').trimStart().startsWith("'use server'"),
  )

  it('finds the server-action modules to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('never re-export an imported type (it becomes a runtime reference)', () => {
    const offenders = files
      .map((f) => ({ f, hits: readFileSync(f, 'utf8').match(/^export type \{[^}]*\}/gm) ?? [] }))
      .filter((r) => r.hits.length > 0)
      .map((r) => `${r.f.replace(process.cwd() + '/', '')} → ${r.hits.join(', ')}`)

    expect(
      offenders,
      'Declare the type in a plain module and import it from there instead.\n' + offenders.join('\n'),
    ).toEqual([])
  })
})
