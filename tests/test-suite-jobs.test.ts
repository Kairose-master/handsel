import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  TEST_SUITE_CATALOG,
  judgeTestSuite,
  resolveTestSuiteSpec,
  testSuiteJobAcceptanceCriteria,
  testSuiteJobDescription,
  testSuiteJobTitle,
} from '@/lib/test-suite-jobs'
import { isDogfoodJobTitle } from '@/lib/test-suite-jobs'

describe('catalog sanity', () => {
  it('slugs are unique and every entry has a reference plus at least 2 mutants', () => {
    const slugs = TEST_SUITE_CATALOG.map((s) => s.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const s of TEST_SUITE_CATALOG) {
      expect(s.referenceSolution).toContain(`def ${s.functionName.replace(/-/g, '_')}`)
      expect(s.mutants.length).toBeGreaterThanOrEqual(2)
      for (const m of s.mutants) expect(m.code).not.toBe(s.referenceSolution)
    }
  })

  it('briefs never leak the hidden implementations', () => {
    for (const s of TEST_SUITE_CATALOG) {
      const brief = testSuiteJobDescription(s) + testSuiteJobAcceptanceCriteria(s)
      expect(brief).not.toContain(s.referenceSolution)
      for (const m of s.mutants) {
        expect(brief).not.toContain(m.code)
        expect(brief).not.toContain(m.bug)
      }
    }
  })
})

describe('title round-trip', () => {
  it('resolveTestSuiteSpec recovers every catalog entry from its title', () => {
    for (const s of TEST_SUITE_CATALOG) {
      expect(resolveTestSuiteSpec(testSuiteJobTitle(s))?.slug).toBe(s.slug)
    }
  })

  it('rejects non-tests titles and unknown slugs', () => {
    expect(resolveTestSuiteSpec('Implement sum_multiples(n)')).toBeNull()
    expect(resolveTestSuiteSpec('tests → not-a-real-slug: write the acceptance tests for x()')).toBeNull()
  })

  it('tests titles count as dogfood (the practice sweep must not cancel them)', () => {
    for (const s of TEST_SUITE_CATALOG) {
      expect(isDogfoodJobTitle(testSuiteJobTitle(s))).toBe(true)
    }
  })
})

describe('judgeTestSuite', () => {
  it('any unavailable run → null (manual review), never a guess', () => {
    expect(judgeTestSuite(null, [false, false]).passed).toBeNull()
    expect(judgeTestSuite(true, [false, null]).passed).toBeNull()
  })

  it('failing the correct implementation fails the suite', () => {
    const v = judgeTestSuite(false, [false, false, false])
    expect(v.passed).toBe(false)
    expect(v.output).toContain('correct implementation')
  })

  it('an escaped mutant fails the suite and says how many slipped through', () => {
    const v = judgeTestSuite(true, [false, true, true])
    expect(v.passed).toBe(false)
    expect(v.output).toContain('2 of 3')
  })

  it('reference passes + all mutants caught → pass', () => {
    const v = judgeTestSuite(true, [false, false, false])
    expect(v.passed).toBe(true)
  })
})

/** End-to-end against real Python, exactly what the runtime sandbox will do:
 *  a thorough suite must pass every reference and kill every mutant; a lazy
 *  suite (asserting only the brief's examples) must let some mutant escape at
 *  least somewhere — that gap is the whole reason mutation grading exists. */
describe('catalog vs real Python (the actual grading semantics)', () => {
  const run = (code: string, tests: string): boolean => {
    try {
      execFileSync('python3', ['-c', `${code}\n${tests}`], { stdio: 'pipe', timeout: 10_000 })
      return true
    } catch {
      return false
    }
  }

  const THOROUGH: Record<string, string> = {
    slugify: [
      'assert slugify("Hello, World!") == "hello-world"',
      'assert slugify("  --A--B-- ") == "a-b"',
      'assert slugify("ABC") == "abc"',
      'assert slugify("!!!") == ""',
    ].join('\n'),
    'next-backoff': [
      'assert next_backoff(1, 2, 60) == 2',
      'assert next_backoff(4, 2, 60) == 16',
      'assert next_backoff(10, 2, 60) == 60',
      'try:',
      '    next_backoff(0, 2, 60)',
      '    raise AssertionError("expected ValueError")',
      'except ValueError:',
      '    pass',
    ].join('\n'),
    'dedupe-keep-first': [
      'assert dedupe_keep_first([3, 1, 3, 2, 1]) == [3, 1, 2]',
      'assert dedupe_keep_first([0, "", 0, None]) == [0, "", None]',
      'assert dedupe_keep_first(["b", "a", "b"]) == ["b", "a"]',
    ].join('\n'),
    'word-wrap': [
      'assert word_wrap("a bb ccc", 4) == ["a bb", "ccc"]',
      'assert word_wrap("ab cd", 5) == ["ab cd"]',
      'assert word_wrap("a b c", 3) == ["a b", "c"]',
      'try:',
      '    word_wrap("x", 0)',
      '    raise AssertionError("expected ValueError")',
      'except ValueError:',
      '    pass',
    ].join('\n'),
  }

  it('a thorough suite passes every reference and kills every mutant', () => {
    for (const spec of TEST_SUITE_CATALOG) {
      const tests = THOROUGH[spec.slug]
      expect(tests, `missing thorough suite for ${spec.slug}`).toBeDefined()
      expect(run(spec.referenceSolution, tests!), `${spec.slug}: reference must pass`).toBe(true)
      spec.mutants.forEach((m, i) => {
        expect(run(m.code, tests!), `${spec.slug}: mutant ${i + 1} (${m.bug}) must be caught`).toBe(false)
      })
    }
  })

  it('judgeTestSuite over the real runs yields a clean pass for the thorough suite', () => {
    const spec = TEST_SUITE_CATALOG[0]!
    const tests = THOROUGH[spec.slug]!
    const verdict = judgeTestSuite(
      run(spec.referenceSolution, tests),
      spec.mutants.map((m) => run(m.code, tests)),
    )
    expect(verdict.passed).toBe(true)
  })
})
