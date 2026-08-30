/**
 * A regression pin for a defect that lived in the build, not in production:
 * CI was red on every commit for weeks while `npm run gates` was green on
 * every commit, and neither result was wrong.
 *
 * `three` is a direct dependency; `@types/three` was not declared at all.
 * npm hoists transitive dependencies flat, so locally `@types/three` sat in
 * `node_modules/` anyway (pulled in by `@react-three/drei`, `maath`,
 * `postprocessing`) and `tsc` resolved it. CI installs with pnpm's strict
 * symlinked layout, where a package can only see what it declares, and the
 * same `tsc` failed with six TS7016 errors. Because CI's steps are
 * fail-fast, that failure also meant `pnpm test:coverage` had never once
 * run — a second, larger unknown hiding behind the first.
 *
 * This test closes the *neighbouring* gap, and it is worth being exact
 * about which: it walks the same files `tsc` typechecks and asserts every
 * package they **import by name** is declared. That catches the more
 * dangerous phantom — an undeclared runtime import, which breaks the
 * deployed app and not merely the typecheck — under npm's hoisted tree
 * exactly as it would under pnpm's strict one.
 *
 * It would *not* have caught `@types/three`, because nothing imports that
 * name: TypeScript resolves it implicitly from `import ... from 'three'`.
 * Only running `tsc` against a strict layout finds that class, which is
 * what CI does. So this is a guard against one class and an honest
 * non-guard against the other; the fix for the second is that CI's steps
 * no longer stop at the first failure (.github/workflows/ci.yml), plus the
 * explicit pin at the bottom of this file.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { importedPackages, undeclaredPackages } from '@/lib/dependency-scan'

/**
 * Mirrors tsconfig.json: everything, minus its `exclude` (node_modules,
 * solana) and minus generated trees that aren't ours to declare for.
 */
const SKIP_DIRS = new Set(['node_modules', 'solana', '.git', '.next', 'coverage', 'desktop', 'minecraft'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]

describe('every package our source imports is declared in package.json', () => {
  const files = sourceFiles('.')

  it('finds the source tree it is meant to be checking', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('has no phantom dependency — nothing that only resolves via npm hoisting', () => {
    const offenders: string[] = []
    for (const file of files) {
      const missing = undeclaredPackages(importedPackages(readFileSync(file, 'utf8')), declared)
      for (const name of missing) offenders.push(`${name} (${file})`)
    }
    expect(offenders).toEqual([])
  })

  it('still declares the one that actually broke CI', () => {
    expect(declared).toContain('@types/three')
  })
})
