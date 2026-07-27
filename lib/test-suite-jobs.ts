/**
 * Dogfood demand, source #3: TEST-SUITE-WRITING jobs, graded by mutation
 * testing — fully mechanical, no LLM opinion anywhere.
 *
 * The inversion: today the code grader runs requester tests against submitted
 * code. Here the platform supplies the code — one hidden REFERENCE
 * implementation and several hidden BUGGY variants (mutants) — and the worker
 * submits the tests. A suite passes when it (a) passes the correct
 * implementation and (b) fails every mutant. Grader ≠ solver holds by
 * construction, and the demand is real: every winning suite becomes a
 * verified test battery for a future auto-graded job template (today every
 * battery is hand-authored — docs/seed-jobs.md).
 *
 * Pure: catalog + briefs + verdict combination. Execution happens in
 * lib/test-suite-grading.ts via the same platform-runtime /grade endpoint the
 * code grader uses.
 */

/**
 * Does this title belong to a job the HOUSE posted for itself?
 *
 * Used by `cancelPracticeJobs` to tell real work from board filler. It lived
 * in lib/docs-jobs.ts until translation stopped being dogfood work at all —
 * see the note there in git history, and §"What the house no longer buys" in
 * docs/product-thesis.md.
 *
 * Only one prefix left, and that is the point rather than an oversight: the
 * remaining dogfood source is mutation-graded, so a machine decides whether it
 * passed. Repo jobs are the other real source and they are graded by the
 * repository's own CI; neither needs the house to have an opinion.
 */
export function isDogfoodJobTitle(title: string): boolean {
  return title.startsWith(TESTS_JOB_TITLE_PREFIX)
}

export const TESTS_JOB_TITLE_PREFIX = 'tests → '
export const TESTS_JOB_BOUNTY_USD = 8
export const TESTS_JOB_MIN_SCORE = 0

export interface TestSuiteSpec {
  slug: string
  functionName: string
  /** The behavioral contract the tests must pin down — shown to the worker. */
  contract: string
  /** Worked examples included in the brief (tests must go beyond them). */
  examples: string
  /** Hidden from the worker. Must satisfy the contract exactly. */
  referenceSolution: string
  /** Hidden buggy variants; a good suite fails every one of them. */
  mutants: { code: string; bug: string }[]
}

export const TEST_SUITE_CATALOG: TestSuiteSpec[] = [
  {
    slug: 'slugify',
    functionName: 'slugify',
    contract: [
      'slugify(s: str) -> str',
      '- Lowercases the input.',
      '- Every maximal run of characters that are not ASCII letters or digits becomes a single hyphen.',
      '- Leading and trailing hyphens are stripped.',
      '- A string with no letters or digits returns "".',
    ].join('\n'),
    examples: 'slugify("Hello, World!") == "hello-world"  ·  slugify("  --Already—Slugged-- ") == "already-slugged"',
    referenceSolution: [
      'import re',
      'def slugify(s):',
      '    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")',
    ].join('\n'),
    mutants: [
      {
        bug: 'does not collapse runs — every separator char becomes its own hyphen',
        code: [
          'import re',
          'def slugify(s):',
          '    return re.sub(r"[^a-z0-9]", "-", s.lower()).strip("-")',
        ].join('\n'),
      },
      {
        bug: 'keeps leading/trailing hyphens',
        code: [
          'import re',
          'def slugify(s):',
          '    return re.sub(r"[^a-z0-9]+", "-", s.lower())',
        ].join('\n'),
      },
      {
        bug: 'forgets to lowercase',
        code: [
          'import re',
          'def slugify(s):',
          '    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-")',
        ].join('\n'),
      },
    ],
  },
  {
    slug: 'next-backoff',
    functionName: 'next_backoff',
    contract: [
      'next_backoff(attempt: int, base_s: float, cap_s: float) -> float',
      '- attempt is 1-based: attempt 1 waits base_s, attempt 2 waits base_s*2, attempt 3 waits base_s*4, …',
      '- The delay never exceeds cap_s (it is clamped, not skipped).',
      '- attempt < 1 raises ValueError.',
    ].join('\n'),
    examples: 'next_backoff(1, 2, 60) == 2  ·  next_backoff(4, 2, 60) == 16  ·  next_backoff(10, 2, 60) == 60',
    referenceSolution: [
      'def next_backoff(attempt, base_s, cap_s):',
      '    if attempt < 1:',
      '        raise ValueError("attempt must be >= 1")',
      '    return min(base_s * (2 ** (attempt - 1)), cap_s)',
    ].join('\n'),
    mutants: [
      {
        bug: 'off-by-one exponent (attempt 1 already doubles)',
        code: [
          'def next_backoff(attempt, base_s, cap_s):',
          '    if attempt < 1:',
          '        raise ValueError("attempt must be >= 1")',
          '    return min(base_s * (2 ** attempt), cap_s)',
        ].join('\n'),
      },
      {
        bug: 'never clamps to the cap',
        code: [
          'def next_backoff(attempt, base_s, cap_s):',
          '    if attempt < 1:',
          '        raise ValueError("attempt must be >= 1")',
          '    return base_s * (2 ** (attempt - 1))',
        ].join('\n'),
      },
      {
        bug: 'returns 0 for attempt < 1 instead of raising',
        code: [
          'def next_backoff(attempt, base_s, cap_s):',
          '    if attempt < 1:',
          '        return 0',
          '    return min(base_s * (2 ** (attempt - 1)), cap_s)',
        ].join('\n'),
      },
    ],
  },
  {
    slug: 'dedupe-keep-first',
    functionName: 'dedupe_keep_first',
    contract: [
      'dedupe_keep_first(items: list) -> list',
      '- Returns a new list with duplicates removed.',
      '- Order is the order of FIRST appearance.',
      '- Falsy values (0, "", None, False) are kept like any other value.',
      '- The input list is not modified.',
    ].join('\n'),
    examples: 'dedupe_keep_first([3, 1, 3, 2, 1]) == [3, 1, 2]  ·  dedupe_keep_first([0, "", 0, None]) == [0, "", None]',
    referenceSolution: [
      'def dedupe_keep_first(items):',
      '    seen = set()',
      '    out = []',
      '    for x in items:',
      '        if x not in seen:',
      '            seen.add(x)',
      '            out.append(x)',
      '    return out',
    ].join('\n'),
    mutants: [
      {
        bug: 'returns sorted unique values, losing the original order',
        code: [
          'def dedupe_keep_first(items):',
          '    return sorted(set(items), key=lambda x: (x is None, str(x)))',
        ].join('\n'),
      },
      {
        bug: 'keeps the LAST occurrence instead of the first',
        code: [
          'def dedupe_keep_first(items):',
          '    out = []',
          '    for i, x in enumerate(items):',
          '        if x not in items[i + 1:]:',
          '            out.append(x)',
          '    return out',
        ].join('\n'),
      },
      {
        bug: 'drops falsy values entirely',
        code: [
          'def dedupe_keep_first(items):',
          '    seen = set()',
          '    out = []',
          '    for x in items:',
          '        if x and x not in seen:',
          '            seen.add(x)',
          '            out.append(x)',
          '    return out',
        ].join('\n'),
      },
    ],
  },
  {
    slug: 'word-wrap',
    functionName: 'word_wrap',
    contract: [
      'word_wrap(text: str, width: int) -> list[str]',
      '- Splits text on whitespace and greedily packs words into lines of at most `width` characters, one space between words.',
      '- Greedy: each line takes as many words as fit before starting the next.',
      '- A single word longer than width gets its own line, unbroken.',
      '- Empty/whitespace-only text returns []. width < 1 raises ValueError.',
    ].join('\n'),
    examples: 'word_wrap("a bb ccc", 4) == ["a bb", "ccc"]  ·  word_wrap("hello", 3) == ["hello"]',
    referenceSolution: [
      'def word_wrap(text, width):',
      '    if width < 1:',
      '        raise ValueError("width must be >= 1")',
      '    words = text.split()',
      '    lines = []',
      '    line = ""',
      '    for w in words:',
      '        if not line:',
      '            line = w',
      '        elif len(line) + 1 + len(w) <= width:',
      '            line += " " + w',
      '        else:',
      '            lines.append(line)',
      '            line = w',
      '    if line:',
      '        lines.append(line)',
      '    return lines',
    ].join('\n'),
    mutants: [
      {
        bug: 'off-by-one fit check (a line that would be exactly width wraps early)',
        code: [
          'def word_wrap(text, width):',
          '    if width < 1:',
          '        raise ValueError("width must be >= 1")',
          '    words = text.split()',
          '    lines = []',
          '    line = ""',
          '    for w in words:',
          '        if not line:',
          '            line = w',
          '        elif len(line) + 1 + len(w) < width:',
          '            line += " " + w',
          '        else:',
          '            lines.append(line)',
          '            line = w',
          '    if line:',
          '        lines.append(line)',
          '    return lines',
        ].join('\n'),
      },
      {
        bug: 'loses the final line (missing flush)',
        code: [
          'def word_wrap(text, width):',
          '    if width < 1:',
          '        raise ValueError("width must be >= 1")',
          '    words = text.split()',
          '    lines = []',
          '    line = ""',
          '    for w in words:',
          '        if not line:',
          '            line = w',
          '        elif len(line) + 1 + len(w) <= width:',
          '            line += " " + w',
          '        else:',
          '            lines.append(line)',
          '            line = w',
          '    return lines',
        ].join('\n'),
      },
      {
        bug: 'accepts width < 1 silently instead of raising',
        code: [
          'def word_wrap(text, width):',
          '    words = text.split()',
          '    lines = []',
          '    line = ""',
          '    for w in words:',
          '        if not line:',
          '            line = w',
          '        elif len(line) + 1 + len(w) <= width:',
          '            line += " " + w',
          '        else:',
          '            lines.append(line)',
          '            line = w',
          '    if line:',
          '        lines.append(line)',
          '    return lines',
        ].join('\n'),
      },
    ],
  },
]

export function testSuiteJobTitle(spec: TestSuiteSpec): string {
  return `${TESTS_JOB_TITLE_PREFIX}${spec.slug}: write the acceptance tests for ${spec.functionName}()`
}

/** The catalog entry a job title targets, or null if it isn't a tests job. */
export function resolveTestSuiteSpec(title: string): TestSuiteSpec | null {
  if (!title.startsWith(TESTS_JOB_TITLE_PREFIX)) return null
  const slug = title.slice(TESTS_JOB_TITLE_PREFIX.length).split(':')[0]?.trim()
  return TEST_SUITE_CATALOG.find((s) => s.slug === slug) ?? null
}

export function testSuiteJobDescription(spec: TestSuiteSpec): string {
  return [
    `Write a Python ACCEPTANCE TEST SUITE for the function below. You write the tests — the implementations stay hidden.`,
    '',
    'Contract:',
    '```',
    spec.contract,
    '```',
    `Examples (your tests must go beyond these): ${spec.examples}`,
    '',
    `How it is graded, mechanically: your suite runs against one hidden CORRECT implementation of ${spec.functionName}()`,
    `(it must pass) and against several hidden BUGGY implementations (it must fail every one of them).`,
    'So: pin down the whole contract — edge cases, ordering, error cases — not just the examples.',
    '',
    `Submit ONLY plain asserts in a \`\`\`python block. The function ${spec.functionName} is already defined when your code runs —`,
    'do NOT implement or import it. End with print("all tests passed"). Use pytest.raises-style checks via try/except if you',
    'need to assert an exception.',
    '',
    'Accepted suites become part of the platform\'s verified job-template catalog (this is real backlog, not an exercise).',
  ].join('\n')
}

export function testSuiteJobAcceptanceCriteria(spec: TestSuiteSpec): string {
  return [
    `- A \`\`\`python block of asserts targeting ${spec.functionName}() as specified — no implementation of it, no imports of it`,
    '- Passes the hidden correct implementation',
    '- Fails every hidden buggy implementation (each seeded bug is caught by at least one assert)',
    '- Ends with print("all tests passed")',
  ].join('\n')
}

/** Combine the N+1 sandbox runs into a verdict. Mechanical and honest:
 *  - any run unavailable (null) → null (manual review; never guess)
 *  - reference fails → the suite asserts something false about a correct
 *    implementation → fail
 *  - reference passes: pass only if every mutant was caught (failed) */
export function judgeTestSuite(
  reference: boolean | null,
  mutants: (boolean | null)[],
): { passed: boolean | null; output: string } {
  if (reference === null || mutants.some((m) => m === null)) {
    return { passed: null, output: 'Grading unavailable for one or more runs — awaiting manual review.' }
  }
  if (reference === false) {
    return { passed: false, output: 'Your tests FAIL a correct implementation — at least one assert contradicts the contract.' }
  }
  const escaped = mutants.filter((m) => m === true).length
  if (escaped > 0) {
    return {
      passed: false,
      output: `Your tests pass the correct implementation, but ${escaped} of ${mutants.length} hidden buggy implementations slipped through. Cover more of the contract (edge cases, ordering, error cases).`,
    }
  }
  return { passed: true, output: `Passed the correct implementation and caught all ${mutants.length} hidden bugs.` }
}
