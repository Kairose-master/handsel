/**
 * Unit cover for the scanner behind tests/dependency-declarations.test.ts.
 * The two properties that matter are opposite kinds of wrong: it must find
 * a real import (or the guard is decorative), and it must never invent one
 * out of prose (or the guard fails builds for sentences).
 */
import { describe, expect, it } from 'vitest'

import { importedPackages, packageOfSpecifier, undeclaredPackages } from '@/lib/dependency-scan'

describe('packageOfSpecifier', () => {
  it('reduces a deep specifier to its package', () => {
    expect(packageOfSpecifier('three/examples/jsm/controls')).toBe('three')
    expect(packageOfSpecifier('@react-three/drei/core/Html')).toBe('@react-three/drei')
  })

  it('is not fooled by our own paths or by builtins', () => {
    expect(packageOfSpecifier('./office')).toBeNull()
    expect(packageOfSpecifier('../lib/office')).toBeNull()
    expect(packageOfSpecifier('@/lib/office')).toBeNull()
    expect(packageOfSpecifier('node:crypto')).toBeNull()
  })

  it('rejects fragments a loose regex would hand it', () => {
    expect(packageOfSpecifier(',')).toBeNull()
    expect(packageOfSpecifier('a different key entirely')).toBeNull()
    expect(packageOfSpecifier('')).toBeNull()
  })
})

describe('importedPackages', () => {
  it('finds every import form we actually write', () => {
    const source = [
      "import * as THREE from 'three'",
      "import { Html } from '@react-three/drei'",
      "export { useFrame } from '@react-three/fiber'",
      "import './globals.css'",
      "import { readFileSync } from 'fs'",
      "import { db } from '@/lib/db'",
    ].join('\n')
    expect(importedPackages(source)).toEqual(['@react-three/drei', '@react-three/fiber', 'three'])
  })

  it('never reads a sentence in a comment as an import', () => {
    const source = [
      '/**',
      " * Counter instructions are read fresh from 'the office it serves',",
      " * never frozen at hire time — unlike office_source, which is a work",
      ' * brief and stays fixed for the job it was posted under.',
      ' */',
      "// import { thing } from 'a-package-we-removed'",
      "import { real } from 'viem'",
    ].join('\n')
    expect(importedPackages(source)).toEqual(['viem'])
  })
})

describe('undeclaredPackages', () => {
  it('names exactly what is imported and not declared', () => {
    expect(undeclaredPackages(['three', '@types/three', 'viem'], ['three', 'viem'])).toEqual(['@types/three'])
  })

  it('is quiet when everything is declared', () => {
    expect(undeclaredPackages(['three'], ['three', 'viem'])).toEqual([])
  })
})
