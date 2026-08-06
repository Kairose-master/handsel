'use server'

/**
 * One-touch admin action: (re)post the ten standing seed jobs documented in
 * docs/seed-jobs.md, so a freshly connected worker always finds real work
 * within seconds instead of hitting an empty board (the two-sided
 * marketplace cold-start problem — the platform seeds demand until real
 * requesters show up).
 *
 * Posts as the same house requester agent used for x402 external job
 * posting (X402_JOB_REQUESTER_AGENT_ID) — already a funded, provisioned
 * agent that exists specifically to escrow bounties on behalf of the
 * platform. Idempotent per click: a seed title still Open on-chain is
 * skipped, so repeated clicks top the board back up to ten rather than
 * flooding it with duplicates.
 */
import { getSession } from '@/lib/get-session'
import { isSuperAdminEmail } from '@/lib/admin'
import { db } from '@/lib/db'
import { agent, jobSpec } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { revalidatePath } from 'next/cache'
import { logPlatformEvent } from '@/lib/platform-feed'
import { sealForInsert } from '@/lib/spec-hash'

type SeedJob = {
  title: string
  description: string
  acceptanceCriteria: string
  testCode: string
  bountyUsd: number
  minScore: number
}

const SEED_JOBS: SeedJob[] = [
  {
    title: 'Implement sum_multiples(n)',
    description:
      'Write a Python function sum_multiples(n) that returns the sum of all integers below n that are divisible by 3 or 5. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single function named sum_multiples\n- Counts strictly below n; handles n=0 and n=1 (both return 0)\n- Passes the attached tests exactly',
    testCode:
      'assert sum_multiples(10) == 23\nassert sum_multiples(0) == 0\nassert sum_multiples(1) == 0\nassert sum_multiples(16) == 60\nassert sum_multiples(1000) == 233168\nprint("all tests passed")',
    bountyUsd: 6,
    minScore: 0,
  },
  {
    title: 'Implement reverse_words(s)',
    description:
      'Write a Python function reverse_words(s) that returns the words of s in reverse order, joined by single spaces. Extra whitespace between words must be collapsed. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single function named reverse_words\n- Collapses repeated/leading/trailing whitespace\n- Passes the attached tests exactly',
    testCode:
      'assert reverse_words("hello world") == "world hello"\nassert reverse_words("one") == "one"\nassert reverse_words("") == ""\nassert reverse_words("  a   b  c ") == "c b a"\nprint("all tests passed")',
    bountyUsd: 5,
    minScore: 0,
  },
  {
    title: 'Implement moving_average(nums, k)',
    description:
      'Write a Python function moving_average(nums, k) returning the k-window moving averages of the list nums, each rounded to 2 decimals. If k <= 0 or k > len(nums), return []. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single function named moving_average\n- Each average rounded to 2 decimals; invalid k returns []\n- Passes the attached tests exactly',
    testCode:
      'assert moving_average([1, 2, 3, 4, 5], 2) == [1.5, 2.5, 3.5, 4.5]\nassert moving_average([10, 20, 30], 3) == [20.0]\nassert moving_average([5], 1) == [5.0]\nassert moving_average([1, 2], 5) == []\nassert moving_average([1, 2, 3], 0) == []\nassert moving_average([1, 1, 1, 4], 2) == [1.0, 1.0, 2.5]\nprint("all tests passed")',
    bountyUsd: 8,
    minScore: 0,
  },
  {
    title: 'Implement count_primes(n)',
    description:
      'Write a Python function count_primes(n) that returns how many prime numbers are strictly less than n. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single function named count_primes\n- Strictly below n; handles n=0, n=1, n=2 (all 0)\n- Passes the attached tests exactly',
    testCode:
      'assert count_primes(0) == 0\nassert count_primes(2) == 0\nassert count_primes(3) == 1\nassert count_primes(10) == 4\nassert count_primes(100) == 25\nassert count_primes(1000) == 168\nprint("all tests passed")',
    bountyUsd: 10,
    minScore: 0,
  },
  {
    title: 'Implement is_balanced(s)',
    description:
      'Write a Python function is_balanced(s) that returns True when every (, [, { in s is closed by the matching bracket in the correct order, ignoring all non-bracket characters. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single function named is_balanced returning a bool\n- Non-bracket characters are ignored; empty string is balanced\n- Passes the attached tests exactly',
    testCode:
      'assert is_balanced("()") is True\nassert is_balanced("([]{})") is True\nassert is_balanced("(]") is False\nassert is_balanced("(((") is False\nassert is_balanced("") is True\nassert is_balanced("a(b[c]d)e") is True\nprint("all tests passed")',
    bountyUsd: 12,
    minScore: 0,
  },
  {
    title: 'Implement roman_to_int(s)',
    description:
      'Write a Python function roman_to_int(s) that converts a valid Roman numeral string (I, V, X, L, C, D, M — including subtractive forms like IV and CM) to an integer. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single function named roman_to_int\n- Handles subtractive notation (IV=4, IX=9, XL=40, CM=900, ...)\n- Passes the attached tests exactly',
    testCode:
      'assert roman_to_int("III") == 3\nassert roman_to_int("IV") == 4\nassert roman_to_int("IX") == 9\nassert roman_to_int("LVIII") == 58\nassert roman_to_int("MCMXCIV") == 1994\nassert roman_to_int("MMXXVI") == 2026\nprint("all tests passed")',
    bountyUsd: 12,
    minScore: 0,
  },
  {
    title: 'Implement parse_duration(s)',
    description:
      'Write a Python function parse_duration(s) that converts a human duration string like "1h 30m" or "45s" into total seconds. Units are h, m, s; any of them may be absent; an empty string is 0. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single function named parse_duration returning an int of seconds\n- Supports any combination/order of h/m/s tokens; empty string -> 0\n- Passes the attached tests exactly',
    testCode:
      'assert parse_duration("1h 30m") == 5400\nassert parse_duration("45s") == 45\nassert parse_duration("2h") == 7200\nassert parse_duration("1h 1m 1s") == 3661\nassert parse_duration("90m") == 5400\nassert parse_duration("") == 0\nprint("all tests passed")',
    bountyUsd: 13,
    minScore: 0,
  },
  {
    title: 'Implement summarize_ledger(csv_text)',
    description:
      'Write a stdlib-only Python function summarize_ledger(csv_text) that takes CSV content as a string (columns: task_id, agent, status, duration_s, payout_usd) and returns a dict with keys total_tasks (int), successful_tasks (int), success_rate (float, 2 decimals), total_payout_usd (float, 2 decimals). A header-only CSV means 0 tasks. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single stdlib-only function named summarize_ledger(csv_text)\n- Handles the header row and an empty ledger (header only = 0 tasks, rate 0.0)\n- Passes the attached tests exactly',
    testCode:
      'SAMPLE = """task_id,agent,status,duration_s,payout_usd\\nt-1,a,success,10,5.00\\nt-2,b,failure,20,0.00\\nt-3,c,success,30,7.50\\nt-4,d,success,40,12.50\\n"""\nr = summarize_ledger(SAMPLE)\nassert r["total_tasks"] == 4\nassert r["successful_tasks"] == 3\nassert r["success_rate"] == 0.75\nassert r["total_payout_usd"] == 25.00\nassert summarize_ledger("task_id,agent,status,duration_s,payout_usd\\n")["total_tasks"] == 0\nprint("all tests passed")',
    bountyUsd: 15,
    minScore: 0,
  },
  {
    title: 'Implement merge_intervals(intervals)',
    description:
      'Write a Python function merge_intervals(intervals) that takes a list of (start, end) tuples, merges all overlapping or touching intervals, and returns the merged list of tuples sorted by start. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single function named merge_intervals returning a list of tuples\n- Touching intervals (end == next start) merge; input order may be arbitrary\n- Passes the attached tests exactly',
    testCode:
      'assert merge_intervals([(1, 3), (2, 6), (8, 10), (15, 18)]) == [(1, 6), (8, 10), (15, 18)]\nassert merge_intervals([(1, 4), (4, 5)]) == [(1, 5)]\nassert merge_intervals([]) == []\nassert merge_intervals([(5, 7)]) == [(5, 7)]\nassert merge_intervals([(3, 4), (1, 2)]) == [(1, 2), (3, 4)]\nprint("all tests passed")',
    bountyUsd: 20,
    minScore: 300,
  },
  {
    title: 'Implement top_k_frequent(words, k)',
    description:
      'Write a Python function top_k_frequent(words, k) that returns the k most frequent strings in the list words, ordered by frequency descending; ties broken alphabetically. Submit only the function in a ```python code block.',
    acceptanceCriteria:
      '- A single function named top_k_frequent\n- Frequency descending, alphabetical tie-break\n- Passes the attached tests exactly',
    testCode:
      'assert top_k_frequent(["apple", "banana", "apple", "cherry", "banana", "apple"], 2) == ["apple", "banana"]\nassert top_k_frequent(["b", "a"], 2) == ["a", "b"]\nassert top_k_frequent(["x"], 1) == ["x"]\nassert top_k_frequent(["dog", "cat", "dog", "bird", "cat"], 3) == ["cat", "dog", "bird"]\nprint("all tests passed")',
    bountyUsd: 22,
    minScore: 300,
  },
]

/** Superadmin-only, same gate as the DB migration button on this page. */
async function requireSuperAdmin() {
  const session = await getSession()
  if (!isSuperAdminEmail(session?.user?.email)) throw new Error('Superadmin access required')
}

export async function getSeedJobsStatus() {
  await requireSuperAdmin()

  const houseAgentId = process.env.X402_JOB_REQUESTER_AGENT_ID
  if (!houseAgentId) return { configured: false, openTitles: [] as string[], total: SEED_JOBS.length }

  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) return { configured: false, openTitles: [] as string[], total: SEED_JOBS.length }

  const { readJobs } = await import('@/lib/onchain/labor')
  const [jobs, specs] = await Promise.all([
    readJobs().catch(() => []),
    db.select().from(jobSpec).where(eq(jobSpec.requesterAgentId, houseAgentId)),
  ])
  const specByHash = new Map(specs.map((s) => [s.specHash, s]))
  const openTitles = jobs
    .filter((j) => j.status === 'Open')
    .map((j) => specByHash.get(j.specHash)?.title)
    .filter((t): t is string => Boolean(t))

  return { configured: true, openTitles, total: SEED_JOBS.length }
}

/** Posts every seed job whose title isn't currently Open on-chain — repeat
 *  clicks top the board back up to ten instead of duplicating live jobs. */
export async function seedLaborMarketJobs() {
  await requireSuperAdmin()

  const houseAgentId = process.env.X402_JOB_REQUESTER_AGENT_ID
  if (!houseAgentId) {
    throw new Error('Set X402_JOB_REQUESTER_AGENT_ID (a provisioned, funded agent) to post seed jobs as')
  }
  const [house] = await db.select().from(agent).where(eq(agent.id, houseAgentId))
  if (!house?.smartAccountAddress) throw new Error('House requester agent is not provisioned')

  const { isLaborMarketConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured()) throw new Error('Labor market is not configured on this deployment')

  const { readJobs, postJob } = await import('@/lib/onchain/labor')

  const [existingJobs, existingSpecs] = await Promise.all([
    readJobs().catch(() => []),
    db.select().from(jobSpec).where(eq(jobSpec.requesterAgentId, houseAgentId)),
  ])
  const specByHash = new Map(existingSpecs.map((s) => [s.specHash, s]))
  const openTitles = new Set(
    existingJobs
      .filter((j) => j.status === 'Open')
      .map((j) => specByHash.get(j.specHash)?.title)
      .filter(Boolean),
  )

  const results: { title: string; ok: boolean; skipped?: boolean; txHash?: string; error?: string }[] = []

  for (const job of SEED_JOBS) {
    if (openTitles.has(job.title)) {
      results.push({ title: job.title, ok: true, skipped: true })
      continue
    }
    try {
      const sealed = sealForInsert(
        houseAgentId,
        {
          title: job.title,
          description: job.description,
          acceptanceCriteria: job.acceptanceCriteria,
          testCode: job.testCode,
        },
        nanoid(),
      )
      const specHash = sealed.specHash
      await db.insert(jobSpec).values({
        ...sealed,
        requesterAgentId: houseAgentId,
        autoApprove: true, // the house agent has no owner who'll ever click Approve
      })
      const txHash = await postJob(houseAgentId, job.bountyUsd, job.minScore, specHash)
      results.push({ title: job.title, ok: true, txHash })
    } catch (error) {
      results.push({ title: job.title, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const posted = results.filter((r) => r.ok && !r.skipped).length
  const skipped = results.filter((r) => r.skipped).length
  if (posted > 0) {
    await logPlatformEvent('JOB_POSTED', `Admin seeded ${posted} standing job(s) (${skipped} already open)`)
  }
  revalidatePath('/jobs')
  return { posted, skipped, total: SEED_JOBS.length, results }
}
