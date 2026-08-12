/**
 * The Eternal finale demo: Solana devnet escrow pays a PHYSICAL machine.
 *
 * One run drives the whole money loop on devnet with a real pen plotter in
 * the middle of it:
 *
 *   post_job (bounty escrowed, spec = "plot <text>")
 *     → accept_job (the machine's worker key stakes the bond)
 *       → THE PEN PLOTTER PHYSICALLY DRAWS THE CARD (booth repo, plot-direct)
 *         → submit_work (result_hash = sha256 of the production record)
 *           → approve_job (pull-payment credit)
 *             → withdraw (the machine's earnings leave the vault)
 *
 * The on-chain result_hash is the sha256 of the printed production record,
 * so anyone can recompute it from this script's output and match it against
 * the job account on the explorer — the physical work is bound to the chain
 * by hash, not by claim.
 *
 * Run on the operator's machine (needs the plotter reachable and both repos
 * cloned side by side):
 *
 *   SOLANA_OPERATOR_KEYPAIR='[...]' \
 *   BOOTH_DIR=../onchain-vending-machine/watcher \
 *   npx tsx scripts/solana-physical-loop.mts "百尺竿头更进一步"
 *
 * Devnet only — write.ts refuses any real-money cluster, and the operator
 * keypair must be the devnet market's mint authority (the week-2 deployer).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

process.env.SOLANA_CLUSTER ??= 'devnet'
process.env.SOLANA_PROGRAM_ID ??= '8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H'

const text = process.argv[2]?.replace(/\\n/g, '\n')
if (!text) {
  console.error('usage: npx tsx scripts/solana-physical-loop.mts "문구"')
  process.exit(1)
}
const BOOTH_DIR = process.env.BOOTH_DIR ?? join(process.cwd(), '..', 'onchain-vending-machine', 'watcher')
if (!existsSync(join(BOOTH_DIR, 'scripts', 'plot-direct.ts'))) {
  console.error(`BOOTH_DIR (${BOOTH_DIR}) does not contain scripts/plot-direct.ts — point it at onchain-vending-machine/watcher`)
  process.exit(1)
}

const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js')
const { getOrCreateAssociatedTokenAccount, mintTo } = await import('@solana/spl-token')
const { acceptJob, approveJob, fetchMarket, loadOperatorKeypair, pda, postJob, solanaConnection, submitWork, withdraw } =
  await import('../lib/onchain/solana/write')
const { solanaExplorerUrl } = await import('../lib/onchain/solana/config')

const operator = loadOperatorKeypair()
if (!operator) {
  console.error('SOLANA_OPERATOR_KEYPAIR is not set (JSON byte array — the devnet deployer/mint-authority key)')
  process.exit(1)
}

const BOUNTY = 1_000_000n // 1.00 test token
const txUrl = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${process.env.SOLANA_CLUSTER}`
const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`)

const connection = solanaConnection()
const market = await fetchMarket(connection)
const mint = new PublicKey(market.usdcMint)

step(1, 'two parties — an ephemeral requester, and the MACHINE as the worker')
const requester = Keypair.generate()
const machine = Keypair.generate()
console.log(`  requester ${requester.publicKey.toBase58()}`)
console.log(`  machine   ${machine.publicKey.toBase58()} (this run's worker key)`)
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: requester.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: machine.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
  ),
  [operator],
  { commitment: 'confirmed' },
)
const requesterAta = await getOrCreateAssociatedTokenAccount(connection, operator, mint, requester.publicKey)
const machineAta = await getOrCreateAssociatedTokenAccount(connection, operator, mint, machine.publicKey)
await mintTo(connection, operator, mint, requesterAta.address, operator, Number(BOUNTY) * 4)
await mintTo(connection, operator, mint, machineAta.address, operator, Number(BOUNTY) * 4)

step(2, 'post_job — the bounty is escrowed on devnet before any work happens')
const spec = `plot: "${text}" — physical execution by the booth pen plotter`
const specHashHex = createHash('sha256').update(spec).digest('hex')
const posted = await postJob(connection, requester, requesterAta.address, {
  bounty: BOUNTY,
  minScore: 0n,
  specHashHex,
  deliveryWindow: 3600,
})
console.log(`  job #${posted.jobId} — ${txUrl(posted.signature)}`)
console.log(`  job account: ${solanaExplorerUrl(posted.jobPda.toBase58())}`)

step(3, 'accept_job — the machine stakes its bond')
console.log(`  ${txUrl(await acceptJob(connection, machine, machineAta.address, posted.jobId))}`)

step(4, 'THE PHYSICAL PART — the pen plotter draws the card')
const plotStdout = execFileSync('npx', ['tsx', 'scripts/plot-direct.ts', text], {
  cwd: BOOTH_DIR,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})
process.stdout.write(plotStdout)
const jsonStart = plotStdout.lastIndexOf('\n{')
const outcome = JSON.parse(plotStdout.slice(jsonStart + 1)) as { ok: boolean; mode: string; detail: string; stats: Record<string, unknown> }
if (!outcome.ok) {
  console.error('plot failed — NOT submitting; the escrow stays until the delivery window handles it honestly')
  process.exit(1)
}

step(5, 'submit_work — result_hash binds the physical work to the chain')
const record = [
  `Physical production record — Solana devnet job #${posted.jobId}`,
  `Plotted text: ${text}`,
  `Machine mode: ${outcome.mode} (${outcome.detail})`,
  `Stats: ${JSON.stringify(outcome.stats)}`,
  `Machine worker key: ${machine.publicKey.toBase58()}`,
].join('\n')
const resultHashHex = createHash('sha256').update(record).digest('hex')
console.log(`  ${txUrl(await submitWork(connection, machine, posted.jobId, resultHashHex))}`)

step(6, 'approve_job — pull-payment credit (no tokens move yet)')
console.log(`  ${txUrl(await approveJob(connection, requester, posted.jobId, machine.publicKey, new PublicKey(market.feeRecipient)))}`)

step(7, "withdraw — the machine's earnings leave the vault")
console.log(`  ${txUrl(await withdraw(connection, machine, machineAta.address))}`)

console.log('\nPHYSICAL LOOP COMPLETE — a Solana devnet escrow paid a real machine for real work.')
console.log(`job:     ${solanaExplorerUrl(posted.jobPda.toBase58())}`)
console.log(`vault:   ${solanaExplorerUrl(pda.vault().toBase58())}`)
console.log('\nVerify the binding yourself — the on-chain result_hash is sha256 of exactly this record:')
console.log('----------------------------------------')
console.log(record)
console.log('----------------------------------------')
console.log(`sha256 = 0x${resultHashHex}`)
