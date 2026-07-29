import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Every module the scripts import must be declared in package.json.
 *
 * `solc` was installed in this working tree and declared NOWHERE — `npm ls`
 * called it *extraneous*. It works here because someone once installed it
 * without saving; a fresh `git clone && npm install` would not have it, and
 * `scripts/deploy-registry.mjs` would die on `Cannot find module 'solc'`.
 *
 * That is the deploy path for the contract that holds every agent's credit
 * score, failing on the first machine that is not this one — discovered with
 * a funded key in hand and a chain waiting.
 *
 * The version matters as much as the presence. `solc` is pinned EXACTLY,
 * without a caret: the committed artifact in lib/onchain/labor-v2-artifact.ts
 * was produced by 0.8.24, tests/labor-v2-artifact.test.ts pins its shape, and
 * a Basescan verification that does not reproduce that bytecode is a different
 * contract. A range would let `npm install` quietly compile a different one.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const declared = { ...pkg.dependencies, ...pkg.devDependencies }

/** Bare module specifiers imported by anything in scripts/. */
function scriptImports(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const name of readdirSync('scripts')) {
    if (!name.endsWith('.mjs') && !name.endsWith('.js')) continue
    const src = readFileSync(`scripts/${name}`, 'utf8')
    for (const m of src.matchAll(/(?:from\s+|import\(\s*)['"]([^'".][^'"]*)['"]/g)) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('node:')) continue
      // A computed specifier — `import(`${SOLC}`)` in compile-labor-v2.mjs
      // resolves a path at run time, so there is no package name to check.
      if (spec.includes('${')) continue
      // scope the package name: `viem/chains` is declared as `viem`
      const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      found.set(pkgName, [...(found.get(pkgName) ?? []), name])
    }
  }
  return found
}

const BUILTINS = new Set(['fs', 'path', 'crypto', 'url', 'util', 'os', 'child_process'])

describe('the scripts can run on a machine that is not this one', () => {
  it('finds imports at all — the parse is the test here', () => {
    const imports = scriptImports()
    expect(imports.size).toBeGreaterThan(2)
    expect([...imports.keys()]).toContain('viem')
  })

  it('declares every package the scripts import', () => {
    const missing: string[] = []
    for (const [name, users] of scriptImports()) {
      if (BUILTINS.has(name)) continue
      if (!declared[name]) missing.push(`${name} (used by ${users.join(', ')})`)
    }
    expect(missing, `imported by scripts/ but not in package.json: ${missing.join('; ')}`).toEqual([])
  })

  it('pins solc exactly, because the committed artifact was built with it', () => {
    // Not ^0.8.24. The bytecode hash the deploy script prints, the artifact the
    // server deploys, and the Basescan verification all have to be the same
    // compiler — "a verification that does not reproduce this hash is a
    // different contract" is the script's own claim about itself.
    expect(declared.solc).toBe('0.8.24')
  })

  it('matches the compiler the committed fixture records', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/evm-artifacts.json', 'utf8')) as { solc: string }
    expect(fixture.solc.startsWith(declared.solc!)).toBe(true)
  })
})
