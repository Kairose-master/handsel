/**
 * Job faucet — the demand bootstrap. A house requester agent keeps a
 * handful of small, auto-graded jobs Open at all times, so a brand-new
 * miner's first ten minutes are "installed the app → real job arrived →
 * got graded → got paid" instead of an empty market.
 *
 * Design constraints, in order:
 *  - ZERO LLM dependency: every faucet job carries Python acceptance
 *    tests, so grading is mechanical and settlement is fully autonomous.
 *  - Self-funding: testnet USDC is minted into the faucet wallet when it
 *    runs low (mintTestUsdc — testnet only by construction).
 *  - Bounded: at most FAUCET_TARGET_OPEN jobs open, FAUCET_MAX_PER_DAY
 *    posted per day, 2 posts per tick. Spending caps apply to the escrow
 *    transfers like any other agent.
 *  - No cron of its own: ticks ride the settlement heartbeat and the
 *    jobs-page read path, throttled in-memory.
 */
import { db } from '@/lib/db'
import { user, agent, jobSpec } from '@/lib/db/schema'
import { and, eq, gte } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { logPlatformEvent } from '@/lib/platform-feed'
import { sealForInsert } from '@/lib/spec-hash'

export const FAUCET_EMAIL = 'faucet@handsel.internal'
export const FAUCET_AGENT_NAME = 'Job Faucet'

/** New-miner grace window: for this long after a faucet job is posted,
 *  auto-mine holds it back from agents above NEW_MINER_MAX_SCORE so a
 *  fresh miner gets first pick. After it elapses anyone may claim, so a
 *  faucet job never sits forever when no newbie is around. */
export const FAUCET_GRACE_MS = 3 * 60 * 1000
export const NEW_MINER_MAX_SCORE = 350

let cachedFaucetAgentIdForReserve: string | null = null

/** The faucet agent's id, cached — lets auto-mine recognize faucet jobs
 *  without a per-tick lookup. Null until the faucet has been bootstrapped
 *  (no faucet jobs exist before then, so nothing to reserve). */
export async function faucetAgentId(): Promise<string | null> {
  if (cachedFaucetAgentIdForReserve) return cachedFaucetAgentIdForReserve
  const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, FAUCET_EMAIL))
  if (!owner) return null
  const [a] = await db
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.userId, owner.id), eq(agent.name, FAUCET_AGENT_NAME)))
  cachedFaucetAgentIdForReserve = a?.id ?? null
  return cachedFaucetAgentIdForReserve
}

/** Should `agentScore` be held back from this faucet job right now?
 *  Pure — reserved iff the job is still inside its grace window AND the
 *  agent is above the new-miner score band. */
export function faucetReservedFor(agentScore: number, postedAt: Date | null, now: number): boolean {
  if (!postedAt) return false
  const withinGrace = now - postedAt.getTime() < FAUCET_GRACE_MS
  return withinGrace && agentScore > NEW_MINER_MAX_SCORE
}

/**
 * Bounds from the environment, with ZERO meaning zero.
 *
 * These read `Number(x) || fallback`, and `Number('0')` is `0`, which is FALSY —
 * so `FAUCET_MAX_PER_DAY=0`, the documented way to switch the faucet off, gave
 * 15 jobs a day instead of none. An operator turning it off got the default.
 *
 * That is survivable on a testnet and not on a real chain: the faucet posts
 * practice work with real bounties, and `realMoneyBlockers` has a
 * `faucet-enabled` blocker whose whole premise is that this switch works.
 *
 * `??` handles absent, an explicit NaN check handles garbage, and 0 is left
 * alone.
 */
function faucetBound(name: string, fallback: number, floor: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(floor, n)
}

const TARGET_OPEN = () => faucetBound('FAUCET_TARGET_OPEN', 3, 1)
/** Floor of 0, so setting it to 0 really does stop the faucet. */
const MAX_PER_DAY = () => faucetBound('FAUCET_MAX_PER_DAY', 15, 0)
const MAX_PER_TICK = 2
const MIN_BALANCE_USD = 20
const REFUEL_USD = 100

export interface FaucetTemplate {
  title: string
  description: string
  acceptanceCriteria: string
  testCode: string
  bountyUsd: number
  /** Reference implementation — used only by the test suite to prove the
   *  template is solvable and its asserts are correct. Never posted. */
  referenceSolution: string
}

export const FAUCET_TEMPLATES: FaucetTemplate[] = [
  {
    title: 'Reverse the words of a string',
    description:
      'Write a Python 3 function reverse_words(s) that returns the words of s in reverse order, joined by single spaces. Words are separated by any whitespace; collapse repeated whitespace.',
    acceptanceCriteria: 'The last python code block defines reverse_words and passes the acceptance tests.',
    testCode: [
      "assert reverse_words('a b c') == 'c b a'",
      "assert reverse_words('') == ''",
      "assert reverse_words('one  two') == 'two one'",
    ].join('\n'),
    bountyUsd: 1,
    referenceSolution: "def reverse_words(s):\n    return ' '.join(s.split()[::-1])",
  },
  {
    title: 'Count the vowels',
    description:
      'Write a Python 3 function vowel_count(s) returning how many characters of s are vowels (aeiou), case-insensitive.',
    acceptanceCriteria: 'The last python code block defines vowel_count and passes the acceptance tests.',
    testCode: [
      "assert vowel_count('Hello') == 2",
      "assert vowel_count('') == 0",
      "assert vowel_count('xyz') == 0",
      "assert vowel_count('AEIOU') == 5",
    ].join('\n'),
    bountyUsd: 1,
    referenceSolution: "def vowel_count(s):\n    return sum(1 for c in s.lower() if c in 'aeiou')",
  },
  {
    title: 'Palindrome check (letters and digits only)',
    description:
      'Write a Python 3 function is_palindrome(s) that returns True when s reads the same forwards and backwards, considering only letters and digits and ignoring case. The empty string is a palindrome.',
    acceptanceCriteria: 'The last python code block defines is_palindrome and passes the acceptance tests.',
    testCode: [
      "assert is_palindrome('A man, a plan, a canal: Panama') == True",
      "assert is_palindrome('abc') == False",
      "assert is_palindrome('') == True",
    ].join('\n'),
    bountyUsd: 1.5,
    referenceSolution:
      "def is_palindrome(s):\n    t = [c.lower() for c in s if c.isalnum()]\n    return t == t[::-1]",
  },
  {
    title: 'FizzBuzz as a list',
    description:
      "Write a Python 3 function fizz_buzz(n) returning a list of strings for 1..n where multiples of 3 are 'Fizz', multiples of 5 are 'Buzz', multiples of both are 'FizzBuzz', and everything else is the number as a string.",
    acceptanceCriteria: 'The last python code block defines fizz_buzz and passes the acceptance tests.',
    testCode: [
      "assert fizz_buzz(5) == ['1', '2', 'Fizz', '4', 'Buzz']",
      "assert fizz_buzz(15)[-1] == 'FizzBuzz'",
      'assert fizz_buzz(0) == []',
    ].join('\n'),
    bountyUsd: 1,
    referenceSolution:
      "def fizz_buzz(n):\n    out = []\n    for i in range(1, n + 1):\n        s = ('Fizz' if i % 3 == 0 else '') + ('Buzz' if i % 5 == 0 else '')\n        out.append(s or str(i))\n    return out",
  },
  {
    title: 'snake_case to camelCase',
    description:
      "Write a Python 3 function snake_to_camel(s) converting a snake_case identifier to camelCase: 'hello_world_now' -> 'helloWorldNow'. A string without underscores is returned unchanged; the empty string returns ''.",
    acceptanceCriteria: 'The last python code block defines snake_to_camel and passes the acceptance tests.',
    testCode: [
      "assert snake_to_camel('hello_world_now') == 'helloWorldNow'",
      "assert snake_to_camel('abc') == 'abc'",
      "assert snake_to_camel('') == ''",
    ].join('\n'),
    bountyUsd: 1.5,
    referenceSolution:
      "def snake_to_camel(s):\n    parts = s.split('_')\n    return parts[0] + ''.join(p.title() for p in parts[1:])",
  },
  {
    title: 'Run-length encode',
    description:
      "Write a Python 3 function run_length(s) that run-length encodes s: 'aaabbc' -> 'a3b2c1'. Every run is written as the character followed by its count, including runs of 1. The empty string returns ''.",
    acceptanceCriteria: 'The last python code block defines run_length and passes the acceptance tests.',
    testCode: [
      "assert run_length('aaabbc') == 'a3b2c1'",
      "assert run_length('') == ''",
      "assert run_length('abc') == 'a1b1c1'",
    ].join('\n'),
    bountyUsd: 1.5,
    referenceSolution:
      "def run_length(s):\n    out = ''\n    i = 0\n    while i < len(s):\n        j = i\n        while j < len(s) and s[j] == s[i]:\n            j += 1\n        out += s[i] + str(j - i)\n        i = j\n    return out",
  },
  {
    title: 'Balanced brackets',
    description:
      "Write a Python 3 function balanced(s) returning True when every bracket in s — (), [], {} — is properly matched and nested. Non-bracket characters never appear. The empty string is balanced.",
    acceptanceCriteria: 'The last python code block defines balanced and passes the acceptance tests.',
    testCode: [
      "assert balanced('([]{})') == True",
      "assert balanced('(]') == False",
      "assert balanced('') == True",
      "assert balanced('((') == False",
    ].join('\n'),
    bountyUsd: 2,
    referenceSolution:
      "def balanced(s):\n    pairs = {')': '(', ']': '[', '}': '{'}\n    stack = []\n    for c in s:\n        if c in '([{':\n            stack.append(c)\n        elif not stack or stack.pop() != pairs[c]:\n            return False\n    return not stack",
  },
  {
    title: 'Second largest distinct value',
    description:
      'Write a Python 3 function second_largest(xs) returning the second largest DISTINCT value in the non-empty list xs. The input always contains at least two distinct values.',
    acceptanceCriteria: 'The last python code block defines second_largest and passes the acceptance tests.',
    testCode: [
      'assert second_largest([1, 3, 2]) == 2',
      'assert second_largest([5, 5, 4]) == 4',
      'assert second_largest([2, 1]) == 1',
    ].join('\n'),
    bountyUsd: 1.5,
    referenceSolution: 'def second_largest(xs):\n    return sorted(set(xs))[-2]',
  },
  {
    title: 'Sum of digits',
    description: 'Write a Python 3 function digit_sum(n) returning the sum of the decimal digits of the non-negative integer n.',
    acceptanceCriteria: 'The last python code block defines digit_sum and passes the acceptance tests.',
    testCode: ['assert digit_sum(123) == 6', 'assert digit_sum(0) == 0', 'assert digit_sum(999) == 27'].join('\n'),
    bountyUsd: 1,
    referenceSolution: 'def digit_sum(n):\n    return sum(int(d) for d in str(n))',
  },
  {
    title: 'Anagram check',
    description:
      'Write a Python 3 function anagrams(a, b) returning True when a and b are anagrams of each other, ignoring case and spaces.',
    acceptanceCriteria: 'The last python code block defines anagrams and passes the acceptance tests.',
    testCode: [
      "assert anagrams('listen', 'silent') == True",
      "assert anagrams('Dormitory', 'dirty room') == True",
      "assert anagrams('a', 'b') == False",
    ].join('\n'),
    bountyUsd: 1.5,
    referenceSolution:
      "def anagrams(a, b):\n    norm = lambda s: sorted(s.lower().replace(' ', ''))\n    return norm(a) == norm(b)",
  },
]

/** How many jobs to post this tick. Pure — the whole budget/bound story
 *  lives here so it's directly testable. */
export function computeRefill(input: {
  openCount: number
  target: number
  postedToday: number
  dailyMax: number
  perTick?: number
}): number {
  const perTick = input.perTick ?? MAX_PER_TICK
  const wanted = Math.max(0, input.target - input.openCount)
  const dailyRoom = Math.max(0, input.dailyMax - input.postedToday)
  return Math.min(wanted, dailyRoom, perTick)
}

let cachedFaucetAgentId: string | null = null

/** Find-or-create the faucet's owning user + agent. The user row has no
 *  password, so nobody can ever log into it — it exists only to own the
 *  agent. Idempotent. Exported for the benchmark loop
 *  (lib/benchmark-loop-server.ts), which posts from the same house wallet. */
export async function ensureFaucetAgent(): Promise<typeof agent.$inferSelect | null> {
  if (cachedFaucetAgentId) {
    const [cached] = await db.select().from(agent).where(eq(agent.id, cachedFaucetAgentId))
    if (cached) return cached
  }

  let [owner] = await db.select().from(user).where(eq(user.email, FAUCET_EMAIL))
  if (!owner) {
    const id = nanoid()
    await db.insert(user).values({ id, email: FAUCET_EMAIL, name: 'Handsel Faucet', emailVerified: true })
    ;[owner] = await db.select().from(user).where(eq(user.id, id))
  }

  let [faucet] = await db
    .select()
    .from(agent)
    .where(and(eq(agent.userId, owner.id), eq(agent.name, FAUCET_AGENT_NAME)))
  if (!faucet) {
    const { randomBytes } = await import('node:crypto')
    const agentId = nanoid()
    await db.insert(agent).values({
      id: agentId,
      userId: owner.id,
      name: FAUCET_AGENT_NAME,
      walletAddress: `0x${randomBytes(20).toString('hex')}`,
      description: 'House requester — keeps small auto-graded starter jobs open for new miners.',
      modelVersion: 'claude-sonnet-5',
      creditScore: '0',
      creditRating: 'unrated',
      riskLevel: 'UNKNOWN',
      riskRating: 'unrated',
      totalCreditLine: '0',
      availableCredit: '0',
      capabilities: ['text'],
    })
    ;[faucet] = await db.select().from(agent).where(eq(agent.id, agentId))
  }

  if (!faucet.smartAccountAddress) {
    try {
      const { getAgentAccountAddress } = await import('@/lib/onchain/account')
      const address = await getAgentAccountAddress(faucet.id)
      await db.update(agent).set({ smartAccountAddress: address }).where(eq(agent.id, faucet.id))
      faucet = { ...faucet, smartAccountAddress: address }
    } catch (error) {
      console.error('[faucet] provisioning failed (will retry next tick):', error)
      return null
    }
  }

  cachedFaucetAgentId = faucet.id
  return faucet
}

/** Store an Anthropic key on the faucet's owner account so house-posted
 *  image/text jobs can be vision/LLM graded (the requester-key path in
 *  resolveUserAnthropicKey). The key is encrypted at rest via encryptSecret;
 *  the plaintext never leaves this call. Returns the masked tail only. */
export async function setFaucetOwnerAnthropicKey(plaintext: string, email?: string): Promise<{ ok: true; keyTail: string }> {
  const key = plaintext.trim()
  if (!key.startsWith('sk-')) throw new Error('that does not look like an Anthropic key (expected sk-...)')

  const targetEmail = (email ?? FAUCET_EMAIL).toLowerCase()
  if (targetEmail === FAUCET_EMAIL) await ensureFaucetAgent() // creates the faucet owner if missing
  const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, targetEmail))
  if (!owner) throw new Error(`no account for ${targetEmail}`)

  const { encryptSecret } = await import('@/lib/crypto')
  const { userApiKey } = await import('@/lib/db/schema')
  const enc = encryptSecret(key)
  await db
    .insert(userApiKey)
    .values({ userId: owner.id, anthropicKeyEnc: enc })
    .onConflictDoUpdate({ target: userApiKey.userId, set: { anthropicKeyEnc: enc, updatedAt: new Date() } })

  return { ok: true, keyTail: key.slice(-4) }
}

/** Store an OpenAI-compatible key (Groq, for Whisper transcription) on the
 *  faucet owner account so house audio jobs can be transcription-graded via
 *  resolveUserOpenAiKey. Encrypted at rest; returns the masked tail only. */
export async function setFaucetOwnerOpenAiKey(
  plaintext: string,
  baseUrl = 'https://api.groq.com/openai/v1',
  model = 'whisper-large-v3-turbo',
  email?: string,
): Promise<{ ok: true; keyTail: string }> {
  const key = plaintext.trim()
  if (!key) throw new Error('empty key')

  const targetEmail = (email ?? FAUCET_EMAIL).toLowerCase()
  if (targetEmail === FAUCET_EMAIL) await ensureFaucetAgent()
  const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, targetEmail))
  if (!owner) throw new Error(`no account for ${targetEmail}`)

  const { encryptSecret } = await import('@/lib/crypto')
  const { userApiKey } = await import('@/lib/db/schema')
  const enc = encryptSecret(key)
  await db
    .insert(userApiKey)
    .values({ userId: owner.id, openaiKeyEnc: enc, openaiBaseUrl: baseUrl, openaiModel: model })
    .onConflictDoUpdate({
      target: userApiKey.userId,
      set: { openaiKeyEnc: enc, openaiBaseUrl: baseUrl, openaiModel: model, updatedAt: new Date() },
    })

  return { ok: true, keyTail: key.slice(-4) }
}

/** Image starter jobs — posted on demand (not on the heartbeat) via the
 *  admin endpoint. Unlike the Python-graded faucet templates these are
 *  vision-graded, so the acceptance criteria are written to be FAIR: one
 *  clear subject, any art style, plain backgrounds allowed, and no text /
 *  watermark demanded. A 1024px generation should pass on merit. */
export interface ImageJobTemplate {
  title: string
  description: string
  acceptanceCriteria: string
  bountyUsd: number
}

export const IMAGE_JOB_TEMPLATES: ImageJobTemplate[] = [
  {
    title: 'A single red apple on a plain background',
    description: 'Generate a clean product-style image of one shiny red apple centered on a plain, light background.',
    acceptanceCriteria:
      'The image clearly shows a single red apple as the main subject. Any photographic or illustrated style is fine. A plain or simple background is acceptable. No text or watermark is required.',
    bountyUsd: 2,
  },
  {
    title: 'A cozy mountain landscape at sunset',
    description: 'Generate a wide mountain landscape at sunset, with warm orange and pink tones in the sky.',
    acceptanceCriteria:
      'The image depicts mountains under a sunset sky with warm colors (orange / pink / red). Any art style is acceptable. It must read clearly as an outdoor mountain scene.',
    bountyUsd: 2,
  },
  {
    title: 'A blue ceramic coffee mug',
    description: 'Generate an image of a blue ceramic coffee mug sitting on a table, simple and well-lit.',
    acceptanceCriteria:
      'The image shows a blue mug or cup that is recognizable as a coffee mug. Any style and any background are fine. No text or watermark is required.',
    bountyUsd: 2,
  },
  {
    title: 'A cute cartoon cat',
    description: 'Generate a friendly, cute cartoon cat character, front-facing, on a simple background.',
    acceptanceCriteria:
      'The image clearly shows a cat. Any breed, pose, or art style is acceptable (cartoon or realistic). It must be recognizable as a cat.',
    bountyUsd: 2,
  },
]

/** Audio starter jobs — the worker speaks the exact script (TTS) and the
 *  server transcribes it back (Whisper) to check it matches. The script is
 *  BOTH the thing to read (in the description, behind a "Script to read:"
 *  marker the audio lane extracts) and the grader's target (acceptanceCriteria
 *  holds the exact sentence). Kept short and plainly worded so a TTS→STT
 *  round-trip lands cleanly. */
export const AUDIO_JOB_SCRIPTS: string[] = [
  'The quick brown fox jumps over the lazy dog.',
  'Please remember to water the plants before you leave.',
  'The meeting is scheduled for three o clock on Tuesday.',
  'A gentle rain fell over the quiet mountain village.',
]

export const AUDIO_JOB_BOUNTY_USD = 2

export interface ImagePostReport {
  posted: number
  jobs: { title: string; specHash: string; bountyUsd: number }[]
  skipped?: string
}

/** Post `count` vision-graded image jobs from the house faucet wallet, on
 *  demand. Mirrors tickJobFaucet's escrow path (mint-if-low → insert spec →
 *  postJob) but for image deliverables, and ignores the open-count / daily
 *  caps because a human explicitly asked for these. */
export async function postHouseImageJobs(count = 3): Promise<ImagePostReport> {
  const n = Math.max(1, Math.min(count, IMAGE_JOB_TEMPLATES.length * 3))

  const { isLaborMarketConfigured, isAgentAccountConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured() || !isAgentAccountConfigured()) {
    return { posted: 0, jobs: [], skipped: 'onchain not configured' }
  }

  const faucet = await ensureFaucetAgent()
  if (!faucet?.smartAccountAddress) return { posted: 0, jobs: [], skipped: 'no faucet wallet' }

  // Self-fund on testnet when low — same as the text faucet.
  try {
    const { usdcBalanceOf, mintTestUsdc } = await import('@/lib/onchain/treasury')
    const balance = await usdcBalanceOf(faucet.smartAccountAddress as `0x${string}`)
    if (balance < MIN_BALANCE_USD) {
      await mintTestUsdc(faucet.id, REFUEL_USD, faucet.smartAccountAddress as `0x${string}`)
    }
  } catch (error) {
    console.error('[faucet] image refuel failed (posting may still succeed):', error)
  }
  const { postJob } = await import('@/lib/onchain/labor')
  const report: ImagePostReport = { posted: 0, jobs: [] }
  for (let i = 0; i < n; i++) {
    const template = IMAGE_JOB_TEMPLATES[i % IMAGE_JOB_TEMPLATES.length]
    try {
      const sealed = sealForInsert(
        faucet.id,
        {
          title: template.title,
          description: template.description,
          acceptanceCriteria: template.acceptanceCriteria,
          deliverableKind: 'image',
        },
        nanoid(),
      )
      const specHash = sealed.specHash
      await db.insert(jobSpec).values({
        ...sealed,
        requesterAgentId: faucet.id,
        autoApprove: true, // a passing vision review releases escrow with no manual step
      })
      if (report.posted > 0) await new Promise((r) => setTimeout(r, 2000)) // bundler rate limit
      await postJob(faucet.id, template.bountyUsd, 0, specHash)
      report.posted++
      report.jobs.push({ title: template.title, specHash, bountyUsd: template.bountyUsd })
      await logPlatformEvent('JOB_POSTED', `Job Faucet posted image job "${template.title}" — $${template.bountyUsd} bounty`)
    } catch (error) {
      console.error('[faucet] image post failed:', error)
      report.skipped = error instanceof Error ? error.message : String(error)
      break
    }
  }
  return report
}

/** Post `count` Python-graded code jobs from the house faucet wallet, on
 *  demand and bypassing the open-count/daily caps — so a worker can be shown
 *  claiming and settling a mechanically-graded job right now. */
export async function postHouseCodeJobs(count = 1): Promise<ImagePostReport> {
  const n = Math.max(1, Math.min(count, 5))
  const { isLaborMarketConfigured, isAgentAccountConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured() || !isAgentAccountConfigured()) {
    return { posted: 0, jobs: [], skipped: 'onchain not configured' }
  }
  const faucet = await ensureFaucetAgent()
  if (!faucet?.smartAccountAddress) return { posted: 0, jobs: [], skipped: 'no faucet wallet' }

  try {
    const { usdcBalanceOf, mintTestUsdc } = await import('@/lib/onchain/treasury')
    const balance = await usdcBalanceOf(faucet.smartAccountAddress as `0x${string}`)
    if (balance < MIN_BALANCE_USD) await mintTestUsdc(faucet.id, REFUEL_USD, faucet.smartAccountAddress as `0x${string}`)
  } catch (error) {
    console.error('[faucet] code refuel failed (posting may still succeed):', error)
  }
  const { postJob } = await import('@/lib/onchain/labor')
  const report: ImagePostReport = { posted: 0, jobs: [] }
  for (let i = 0; i < n; i++) {
    const t = FAUCET_TEMPLATES[i % FAUCET_TEMPLATES.length]
    try {
      const sealed = sealForInsert(
        faucet.id,
        {
          title: t.title,
          description: t.description,
          acceptanceCriteria: t.acceptanceCriteria,
          testCode: t.testCode,
          deliverableKind: 'text',
        },
        nanoid(),
      )
      const specHash = sealed.specHash
      await db.insert(jobSpec).values({ ...sealed, requesterAgentId: faucet.id, autoApprove: true })
      if (report.posted > 0) await new Promise((r) => setTimeout(r, 2000))
      await postJob(faucet.id, t.bountyUsd, 0, specHash)
      report.posted++
      report.jobs.push({ title: t.title, specHash, bountyUsd: t.bountyUsd })
      await logPlatformEvent('JOB_POSTED', `Job Faucet posted code job "${t.title}" — $${t.bountyUsd} bounty`)
    } catch (error) {
      console.error('[faucet] code post failed:', error)
      report.skipped = error instanceof Error ? error.message : String(error)
      break
    }
  }
  return report
}

/** Post `count` transcription-graded audio jobs from the house faucet wallet.
 *  Mirrors postHouseImageJobs but for the audio lane: the worker reads the
 *  script aloud, the server transcribes it back and checks the match. */
export async function postHouseAudioJobs(count = 3): Promise<ImagePostReport> {
  const n = Math.max(1, Math.min(count, AUDIO_JOB_SCRIPTS.length * 3))

  const { isLaborMarketConfigured, isAgentAccountConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured() || !isAgentAccountConfigured()) {
    return { posted: 0, jobs: [], skipped: 'onchain not configured' }
  }

  const faucet = await ensureFaucetAgent()
  if (!faucet?.smartAccountAddress) return { posted: 0, jobs: [], skipped: 'no faucet wallet' }

  try {
    const { usdcBalanceOf, mintTestUsdc } = await import('@/lib/onchain/treasury')
    const balance = await usdcBalanceOf(faucet.smartAccountAddress as `0x${string}`)
    if (balance < MIN_BALANCE_USD) {
      await mintTestUsdc(faucet.id, REFUEL_USD, faucet.smartAccountAddress as `0x${string}`)
    }
  } catch (error) {
    console.error('[faucet] audio refuel failed (posting may still succeed):', error)
  }
  const { postJob } = await import('@/lib/onchain/labor')
  const report: ImagePostReport = { posted: 0, jobs: [] }
  for (let i = 0; i < n; i++) {
    const script = AUDIO_JOB_SCRIPTS[i % AUDIO_JOB_SCRIPTS.length]
    const title = 'Read a short sentence aloud (text-to-speech)'
    try {
      const sealed = sealForInsert(
        faucet.id,
        {
          title,
          // The audio lane extracts the text after "Script to read:" and speaks
          // only that — see generate_audio in the desktop worker.
          description: `Produce clear spoken audio of the following line, nothing else.\n\nScript to read: "${script}"`,
          // The grader's exact target — the transcript is checked against this.
          acceptanceCriteria: script,
          deliverableKind: 'audio',
        },
        nanoid(),
      )
      const specHash = sealed.specHash
      await db.insert(jobSpec).values({
        ...sealed,
        requesterAgentId: faucet.id,
        autoApprove: true, // a passing transcription review releases escrow with no manual step
      })
      if (report.posted > 0) await new Promise((r) => setTimeout(r, 2000)) // bundler rate limit
      await postJob(faucet.id, AUDIO_JOB_BOUNTY_USD, 0, specHash)
      report.posted++
      report.jobs.push({ title: `${title} — "${script}"`, specHash, bountyUsd: AUDIO_JOB_BOUNTY_USD })
      await logPlatformEvent('JOB_POSTED', `Job Faucet posted audio job — $${AUDIO_JOB_BOUNTY_USD} bounty`)
    } catch (error) {
      console.error('[faucet] audio post failed:', error)
      report.skipped = error instanceof Error ? error.message : String(error)
      break
    }
  }
  return report
}

// A cross-instance lease, not a per-lambda timestamp. The faucet posts real
// escrowed jobs, and it is called from the jobs page's after() block, so on a
// warm fleet every instance thought it was due at once. The daily cap bounded
// that; it did not stop a burst.
const FAUCET_TICK_COOLDOWN_MS = 10 * 60 * 1000
/** `force` still serializes — it shortens the window, it does not remove it. */
const FAUCET_FORCE_LEASE_MS = 60_000

export interface FaucetReport {
  posted: number
  openBefore: number
  skipped?: string
}

/** One faucet tick: top up the wallet if low, then post enough templates
 *  to keep TARGET_OPEN faucet jobs open. Safe to call from any read path. */
export async function tickJobFaucet(opts?: { force?: boolean }): Promise<FaucetReport> {
  // OPT-IN. Auto-posting synthetic practice exercises next to real work made
  // the board read as clutter, and the standing demand that replaced it —
  // translation the house bought from itself — has since been removed too, as
  // money spent on output the operator could produce inline. So there is no
  // automatic supply at all now, on purpose: an empty board is a true
  // statement about demand. Set FAUCET_ENABLED=true to bring the faucet back
  // (a workshop or demo where guaranteed instant work matters more).
  if (process.env.FAUCET_ENABLED !== 'true') return { posted: 0, openBefore: 0, skipped: 'disabled (opt-in: set FAUCET_ENABLED=true)' }
  if (process.env.FAUCET_DISABLED === 'true') return { posted: 0, openBefore: 0, skipped: 'disabled' }
  // Practice work funded with real money is money spent on jobs nobody asked
  // for, and it fills the board with exactly the demand that must not be
  // counted as demand. FAUCET_ENABLED does not override this — the chain does.
  const { IS_REAL_MONEY } = await import('@/lib/onchain/config')
  if (IS_REAL_MONEY) return { posted: 0, openBefore: 0, skipped: 'disabled: the configured chain is real money' }

  const { acquireOpsLease } = await import('@/lib/ops-lease')
  const leaseMs = opts?.force ? FAUCET_FORCE_LEASE_MS : FAUCET_TICK_COOLDOWN_MS
  if (!(await acquireOpsLease('faucet-tick', leaseMs))) {
    return { posted: 0, openBefore: 0, skipped: 'throttled' }
  }

  const { isLaborMarketConfigured, isAgentAccountConfigured } = await import('@/lib/onchain/config')
  if (!isLaborMarketConfigured() || !isAgentAccountConfigured()) {
    return { posted: 0, openBefore: 0, skipped: 'onchain not configured' }
  }

  const faucet = await ensureFaucetAgent()
  if (!faucet?.smartAccountAddress) return { posted: 0, openBefore: 0, skipped: 'no faucet wallet' }

  const { postJob } = await import('@/lib/onchain/labor')
  const { readJobsOrUnknown, countOpenBy } = await import('@/lib/onchain/labor-read')
  // computeRefill posts against the shortfall, so a swallowed read error
  // ("openCount = 0") is a standing instruction to refill a board that may
  // already be full. The daily cap bounded the damage; it didn't prevent it.
  const openCount = countOpenBy(await readJobsOrUnknown(), faucet.smartAccountAddress)
  if (openCount === null) {
    return { posted: 0, openBefore: 0, skipped: 'chain read failed — refusing to refill against unknown state' }
  }

  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  const postedToday = (
    await db
      .select({ specHash: jobSpec.specHash })
      .from(jobSpec)
      .where(and(eq(jobSpec.requesterAgentId, faucet.id), gte(jobSpec.createdAt, dayStart)))
  ).length

  const need = computeRefill({ openCount, target: TARGET_OPEN(), postedToday, dailyMax: MAX_PER_DAY() })
  if (need === 0) return { posted: 0, openBefore: openCount }

  // Self-fund on testnet when low — the faucet mints its own escrow money.
  try {
    const { usdcBalanceOf, mintTestUsdc } = await import('@/lib/onchain/treasury')
    const balance = await usdcBalanceOf(faucet.smartAccountAddress as `0x${string}`)
    if (balance < MIN_BALANCE_USD) {
      await mintTestUsdc(faucet.id, REFUEL_USD, faucet.smartAccountAddress as `0x${string}`)
    }
  } catch (error) {
    console.error('[faucet] refuel failed (posting may still succeed):', error)
  }
  let posted = 0
  for (let i = 0; i < need; i++) {
    const template = FAUCET_TEMPLATES[Math.floor(Math.random() * FAUCET_TEMPLATES.length)]
    try {
      const sealed = sealForInsert(
        faucet.id,
        {
          title: template.title,
          description: template.description,
          acceptanceCriteria: template.acceptanceCriteria,
          testCode: template.testCode,
          deliverableKind: 'text',
        },
        nanoid(),
      )
      const specHash = sealed.specHash
      await db.insert(jobSpec).values({
        ...sealed,
        requesterAgentId: faucet.id,
        autoApprove: true, // mechanical pass releases escrow — the faucet never reviews
      })
      if (posted > 0) await new Promise((r) => setTimeout(r, 2000)) // bundler rate limit
      await postJob(faucet.id, template.bountyUsd, 0, specHash)
      posted++
      await logPlatformEvent('JOB_POSTED', `Job Faucet posted "${template.title}" — $${template.bountyUsd} starter bounty`)
    } catch (error) {
      console.error('[faucet] post failed:', error)
      break // wallet/RPC trouble — stop this tick, next tick retries
    }
  }

  return { posted, openBefore: openCount }
}
