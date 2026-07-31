/**
 * Lock the open-challenge prize as a self-to-self escrow — the direct-call path
 * of docs/challenge-setup.md, done with the SAME account-abstraction plumbing
 * the app uses (so the kernel accounts derive identically to production — no
 * hand-rolled address derivation on a real-money path).
 *
 *   R posts a $100 job → W accepts it → W never submits → the escrow sits
 *   Accepted and locked for the delivery window, extractable only by a contract
 *   bug. Run this BEFORE announcing.
 *
 * It reuses postJobV2 / acceptJobV2, so it needs the app's env. tsx resolves the
 * "@/" tsconfig paths; there is no server-only import in the chain.
 *
 *   R_AGENT_ID=<requester agent id> \
 *   W_AGENT_ID=<worker agent id, AUTO-MINE OFF> \
 *   DATABASE_URL=... AGENT_OWNER_PRIVATE_KEY=... ORACLE_PRIVATE_KEY=... \
 *   ONCHAIN_CHAIN=base ONCHAIN_RPC_URL=... BUNDLER_RPC=... \
 *   LABOR_MARKET_ADDRESS=... USDC_ADDRESS=... PAYMASTER_DISABLED=true \
 *   npx tsx scripts/challenge-lock-escrow.ts            # dry run: checks + plan only
 *   npx tsx scripts/challenge-lock-escrow.ts --confirm  # actually post + accept
 *
 * Rehearse it on Base Sepolia first (same script, testnet env, a small
 * CHALLENGE_BOUNTY_USD) — that is what the practice deployment is for.
 */
import { keccak256, stringToHex } from 'viem'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agent } from '@/lib/db/schema'
import { CHAIN, onchainEnv } from '@/lib/onchain/config'
import { publicClient } from '@/lib/onchain/clients'
import { LABOR_MARKET_V2_ABI } from '@/lib/onchain/labor-v2-artifact'
import { acceptJobV2, isV2Market, postJobV2, readJobsV2 } from '@/lib/onchain/labor-v2'

const BOUNTY_USD = Number(process.env.CHALLENGE_BOUNTY_USD ?? 100)
const DELIVERY_WINDOW_SEC = 2_592_000 // 30 days; postJobV2 clamps to the contract max
const MIN_SCORE = 0
const SPEC_HASH = keccak256(stringToHex('handsel-open-challenge'))
const bountyUnits = BigInt(Math.round(BOUNTY_USD * 1e6)) // USDC has 6 decimals

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const die = (m: string): never => {
  console.error(`\n✖ ${m}`)
  process.exit(1)
}
const usd = (units: bigint) => `$${(Number(units) / 1e6).toFixed(2)}`

async function main() {
  const confirm = process.argv.includes('--confirm')
  const R = process.env.R_AGENT_ID
  const W = process.env.W_AGENT_ID
  if (!R || !W) die('set R_AGENT_ID (requester) and W_AGENT_ID (worker)')
  if (R === W) die('R and W must be different agents — the contract rejects SelfWork')
  if (!onchainEnv.laborMarketAddress) die('LABOR_MARKET_ADDRESS is not set')
  if (!(await isV2Market())) die('the configured market is not a LaborMarketV2 — refusing')

  // The two agents, from the same DB the deployment uses.
  const [rAgent] = await db.select().from(agent).where(eq(agent.id, R as string))
  const [wAgent] = await db.select().from(agent).where(eq(agent.id, W as string))
  if (!rAgent) die(`no agent with id ${R} (requester)`)
  if (!wAgent) die(`no agent with id ${W} (worker)`)
  if (!rAgent.smartAccountAddress) die(`requester ${rAgent.name} has no smart account — provision it first`)
  if (!wAgent.smartAccountAddress) die(`worker ${wAgent.name} has no smart account — provision it first`)

  // The load-bearing guard: an auto-mining worker's self-heal step would
  // generate and submit the work for this job on the next tick, complete it, and
  // destroy the "locked for 30 days" premise. autoMineTick no-ops when this is
  // false; keep it false.
  if (wAgent.autoMine) {
    die(
      `worker ${wAgent.name} has AUTO-MINE ON — turn it off before locking the escrow, ` +
        `or the deployment's auto-mine sweep will complete this job itself`,
    )
  }

  const rAddr = (rAgent.smartAccountAddress as string).toLowerCase()
  const wAddr = (wAgent.smartAccountAddress as string).toLowerCase()

  // What each side must hold, read from the contract (never recomputed).
  const market = { address: onchainEnv.laborMarketAddress as `0x${string}`, abi: LABOR_MARKET_V2_ABI } as const
  const postCost = (await publicClient().readContract({ ...market, functionName: 'postCost', args: [bountyUnits] })) as bigint
  const bond = (await publicClient().readContract({ ...market, functionName: 'bondFor', args: [bountyUnits] })) as bigint

  console.log(`\nChain          ${CHAIN.name} (${CHAIN.id})`)
  console.log(`Market         ${onchainEnv.laborMarketAddress}`)
  console.log(`Bounty         ${usd(bountyUnits)}   delivery window ${DELIVERY_WINDOW_SEC}s (clamped to max)`)
  console.log(`Requester  R   ${rAgent.name}  ${rAgent.smartAccountAddress}  — must hold ≥ ${usd(postCost)} USDC (bounty + fee)`)
  console.log(`Worker     W   ${wAgent.name}  ${wAgent.smartAccountAddress}  — must hold ≥ ${usd(bond)} USDC (bond) + gas ETH, auto-mine OFF`)

  if (!confirm) {
    console.log('\n(dry run — checks passed. Re-run with --confirm to post + accept.)')
    return
  }

  // 1. Post as R (approve postCost + postJob, one UserOp).
  console.log('\n① posting the job as R …')
  const postTx = await postJobV2(R as string, BOUNTY_USD, MIN_SCORE, SPEC_HASH, DELIVERY_WINDOW_SEC)
  console.log(`   tx ${postTx}`)

  // Find the job we just posted: newest Open job owned by R at this bounty.
  const jobId = await poll('the posted job to appear', async () => {
    const mine = (await readJobsV2())
      .filter((j) => j.requester.toLowerCase() === rAddr && j.status === 'Open' && Math.abs(j.bounty - BOUNTY_USD) < 1e-6)
      .sort((a, b) => b.id - a.id)
    if (mine.length > 1) console.warn(`   ⚠ ${mine.length} Open jobs from R at this bounty — taking the newest (#${mine[0].id})`)
    return mine[0]?.id
  })
  console.log(`   → job #${jobId}`)

  // 2. Accept as W (approve bond + acceptJob, one UserOp). This is the raw
  //    on-chain accept — NOT acceptJobAction, which would also dispatch the work.
  console.log('\n② accepting it as W …')
  const acceptTx = await acceptJobV2(W as string, jobId)
  console.log(`   tx ${acceptTx}`)

  const job = await poll('the job to read back Accepted', async () => {
    const j = (await readJobsV2()).find((x) => x.id === jobId)
    return j && j.status === 'Accepted' ? j : undefined
  })
  if (job.worker.toLowerCase() !== wAddr) {
    die(`job #${jobId} accepted, but worker is ${job.worker}, not W (${wAddr}) — do NOT announce; investigate`)
  }

  const deadline = job.deliveryDeadline
  console.log('\n✅ locked.')
  console.log('─'.repeat(60))
  console.log(`Escrow contract   ${onchainEnv.laborMarketAddress}`)
  console.log(`Job id            ${jobId}`)
  console.log(`Status            Accepted  (requester ${rAddr.slice(0, 8)}…, worker ${wAddr.slice(0, 8)}…)`)
  console.log(`Bounty locked     ${usd(bountyUnits)}`)
  console.log(`Ends              ${new Date(deadline * 1000).toISOString()}  (unix ${deadline})`)
  console.log('─'.repeat(60))
  console.log('Fill the launch-post blanks with the contract address, job id, and end date above.')
  console.log('W must never submit and must stay auto-mine OFF for the whole window.')
}

async function poll<T>(what: string, read: () => Promise<T | undefined>, tries = 12, gapMs = 3000): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await read()
    if (v !== undefined) return v
    await sleep(gapMs)
  }
  return die(`timed out waiting for ${what} — the tx may still confirm; re-check on-chain before retrying`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => die(e?.stack ?? e?.message ?? String(e)))
