/**
 * Reading the devnet board over plain JSON-RPC.
 *
 * `getProgramAccounts` with a memcmp filter on Anchor's 8-byte discriminator
 * returns every `Job` the program owns and nothing else, so enumerating the
 * board derives no PDAs and needs no SDK. Decoding is `./codec`, which is pure.
 *
 * The three-value read state is not optional and not new: `app/actions/guest.ts`
 * documents why an empty array cannot stand for "unconfigured" and "unreachable"
 * both. A program polling GET /api/tasks has no other signal, and `{count: 0}`
 * with HTTP 200 told every worker "there is no work here" when the truth was
 * "this deployment has no market". Same shape, second runtime, same rule.
 */
import { decodeJobAccount, jobDeadline, type SolanaJob } from './codec'
import { isSolanaConfigured, solanaEnv, solanaRpcUrl } from './config'
import { accountDiscriminator, base58Encode } from './codec'

export type SolanaReadState = 'ok' | 'unconfigured' | 'unreachable'

export type SolanaBoardJob = SolanaJob & {
  /** The deadline governing the CURRENT state, or null when nothing counts
   *  down. See `jobDeadline` — status alone does not say what may be done. */
  deadline: number | null
  /** True when that deadline has passed: the state is stale and the only move
   *  left is the exit that settles it. */
  lapsed: boolean
}

export type SolanaBoard = { state: SolanaReadState; jobs: SolanaBoardJob[] }

const RPC_TIMEOUT_MS = 8_000

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = solanaRpcUrl()
  if (!url) throw new Error('no Solana RPC configured')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`)
    const body = (await res.json()) as { result?: T; error?: { message?: string } }
    if (body.error) throw new Error(`${method} → ${body.error.message ?? 'rpc error'}`)
    if (body.result === undefined) throw new Error(`${method} → no result`)
    return body.result
  } finally {
    clearTimeout(timer)
  }
}

type ProgramAccount = { account: { data: [string, string] } }

/**
 * Every job on the configured program, newest id last.
 *
 * `now` is injected so the lapsed calculation is testable and so a page
 * rendering many jobs classifies them all against ONE instant — deriving
 * `Date.now()` per job means two jobs on the same board can disagree about
 * what time it is.
 */
export async function readSolanaJobs(now: number = Math.floor(Date.now() / 1000)): Promise<SolanaBoard> {
  if (!isSolanaConfigured()) return { state: 'unconfigured', jobs: [] }

  let accounts: ProgramAccount[]
  try {
    accounts = await rpc<ProgramAccount[]>('getProgramAccounts', [
      solanaEnv.programId,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        filters: [{ memcmp: { offset: 0, bytes: base58Encode(accountDiscriminator('Job')) } }],
      },
    ])
  } catch {
    // An unreachable RPC is not an empty market. This is the likelier failure
    // in production than a missing env var, and collapsing it into `[]` is how
    // a rate-limited provider becomes "nobody is hiring".
    return { state: 'unreachable', jobs: [] }
  }

  const jobs: SolanaBoardJob[] = []
  for (const entry of accounts) {
    const [payload, encoding] = entry.account.data
    if (encoding !== 'base64') continue
    const job = decodeJobAccount(new Uint8Array(Buffer.from(payload, 'base64')))
    // Nulls are other account types the same program owns (Market,
    // Withdrawable, Credit) plus anything this build cannot decode. Dropping
    // them is correct; throwing would let one unknown account blank the board.
    if (!job) continue
    const deadline = jobDeadline(job)
    jobs.push({ ...job, deadline, lapsed: deadline !== null && now > deadline })
  }

  jobs.sort((a, b) => a.id - b.id)
  return { state: 'ok', jobs }
}
