/**
 * worker-npm/ packages public/handsel-worker.mjs as an npm bin
 * (`npx handsel-worker --login`). The repo deliberately does NOT store a
 * second copy of the worker — prepublishOnly copies the platform-served file
 * in at publish time, so the two cannot drift. These tests pin the package
 * shape that makes that true.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'worker-npm', 'package.json'), 'utf8'))

describe('worker-npm package', () => {
  it('bins the exact file prepublish copies in', () => {
    expect(pkg.bin['handsel-worker']).toBe('./handsel-worker.mjs')
    expect(pkg.scripts.prepublishOnly).toContain('../public/handsel-worker.mjs')
    expect(pkg.files).toContain('handsel-worker.mjs')
  })

  it('stays dependency-free, like the worker itself', () => {
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.engines.node).toBe('>=18')
  })

  it('does not commit the copied artifact', () => {
    expect(existsSync(join(process.cwd(), 'worker-npm', 'handsel-worker.mjs'))).toBe(false)
    expect(readFileSync(join(process.cwd(), 'worker-npm', '.gitignore'), 'utf8')).toContain('handsel-worker.mjs')
  })

  it('the packaged worker is executable as a bin (shebang)', () => {
    const worker = readFileSync(join(process.cwd(), 'public', 'handsel-worker.mjs'), 'utf8')
    expect(worker.startsWith('#!/usr/bin/env node')).toBe(true)
  })
})
