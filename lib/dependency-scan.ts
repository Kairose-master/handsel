/**
 * Which packages does our own source import, and are they all declared?
 *
 * This exists because of a divergence that kept CI red for weeks without
 * anybody being able to see it locally: this repo's committed lockfile is
 * pnpm's, CI runs `pnpm install --frozen-lockfile`, and pnpm gives each
 * package a strict, symlinked tree where a module can only resolve what its
 * own package.json declares. npm — what a local `npm run gates` uses —
 * hoists every transitive dependency flat into `node_modules/`, so an
 * *undeclared* import resolves anyway. The result is a package that is
 * imported by our code, absent from package.json, and green on every local
 * gate: a phantom dependency. `@types/three` was one, and `tsc` failed on
 * six files in CI while passing on every machine that ran npm.
 *
 * Pure on purpose: the scan takes file text, the check takes names. The
 * test that walks the real tree lives in tests/dependency-declarations.test.ts.
 */

/**
 * npm's package-name grammar. Deliberately strict — this is what separates a
 * real specifier from the fragments a loose regex picks out of source
 * (a trailing `,` from a multi-line export, for one).
 */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/**
 * Node builtins are always resolvable and are never declared in package.json.
 * `node:`-prefixed specifiers are stripped before this list is consulted, so
 * these are the bare spellings our source actually uses.
 */
export const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty',
  'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
])

/**
 * Anchored at the start of a line on purpose. Every import in this codebase
 * is a top-level statement in column 0; prose inside a JSDoc block is
 * indented behind a ` * `, so the anchor is what keeps a sentence like
 * "read fresh, not frozen — from the office it serves" out of the results.
 * Conservative in the right direction: it can miss an exotic import form,
 * but it cannot invent one.
 */
const FROM_CLAUSE = /^[ \t]*(?:import|export)[ \t][^\n;]*?\bfrom[ \t]*['"]([^'"]+)['"]/gm
const SIDE_EFFECT = /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm

/**
 * The package a specifier belongs to: `@scope/pkg/sub` → `@scope/pkg`,
 * `pkg/sub` → `pkg`. Relative paths, the `@/` path alias and `node:`
 * builtins are not packages and come back null.
 */
export function packageOfSpecifier(specifier: string): string | null {
  if (!specifier) return null
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) return null
  if (specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return PACKAGE_NAME.test(name) ? name : null
}

/** Every external package one file's source imports. */
export function importedPackages(source: string): string[] {
  const found = new Set<string>()
  for (const pattern of [FROM_CLAUSE, SIDE_EFFECT]) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      const name = packageOfSpecifier(match[1])
      if (name && !NODE_BUILTINS.has(name)) found.add(name)
    }
  }
  return [...found].sort()
}

/** Imported but not declared — the phantom dependencies. */
export function undeclaredPackages(imported: Iterable<string>, declared: Iterable<string>): string[] {
  const have = new Set(declared)
  return [...new Set([...imported].filter((name) => !have.has(name)))].sort()
}
