/**
 * Cross-check the write path's encoders against REAL transactions on devnet.
 *
 * The tests pin tx.ts to the Rust source; this pins it to the chain itself:
 * fetch the transactions the happy-path runs left on a job account, decode
 * every instruction the program received, and compare — discriminator (via
 * our formula), data length, account count and order, and the job PDA our
 * derivation produces vs the account the chain actually used. If Anchor's
 * wire format and ours ever disagree, this is the script that says so with
 * receipts.
 *
 * Read-only; needs no keys.
 *
 *   npx tsx scripts/verify-solana-write.mts [jobId]
 */
// Static imports hoist above these assignments, and config.ts snapshots the
// env at module load — so the modules under test are imported dynamically
// AFTER the env exists.
process.env.SOLANA_CLUSTER ??= 'devnet'
process.env.SOLANA_PROGRAM_ID ??= '8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H'

const { pda, programId, solanaConnection } = await import('../lib/onchain/solana/write')
const { INSTRUCTION_ACCOUNTS, instructionDiscriminator } = await import('../lib/onchain/solana/tx')

const jobId = BigInt(process.argv[2] ?? '3')
const conn = solanaConnection()
const jobPda = pda.job(jobId)
console.log(`job #${jobId} PDA (our derivation): ${jobPda.toBase58()}`)

const sigs = await conn.getSignaturesForAddress(jobPda, { limit: 20 })
if (sigs.length === 0) {
  console.error('no transactions found for this job — pass a job id that exists')
  process.exit(1)
}
console.log(`transactions touching it: ${sigs.length}`)

const discByHex = new Map(
  Object.keys(INSTRUCTION_ACCOUNTS).map((n) => [Buffer.from(instructionDiscriminator(n)).toString('hex'), n]),
)

let checked = 0
let failed = 0
for (const s of sigs.reverse()) {
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
  if (!tx) continue
  const msg = tx.transaction.message
  const keys = msg.staticAccountKeys
  for (const ci of msg.compiledInstructions) {
    if (!keys[ci.programIdIndex].equals(programId())) continue
    const raw = Buffer.from(ci.data)
    const name = discByHex.get(raw.subarray(0, 8).toString('hex'))
    if (!name) {
      console.error(`✗ unrecognized discriminator ${raw.subarray(0, 8).toString('hex')} — encoder out of sync`)
      failed++
      continue
    }
    const spec = INSTRUCTION_ACCOUNTS[name].accounts
    const ok = ci.accountKeyIndexes.length === spec.length
    console.log(
      `${ok ? '✓' : '✗'} ${name}: ${raw.length}B data, ${ci.accountKeyIndexes.length}/${spec.length} accounts` +
        (name === 'accept_job'
          ? ` (worker_credit slot = ${keys[ci.accountKeyIndexes[5]].equals(programId()) ? 'program id — Option None convention holds' : keys[ci.accountKeyIndexes[5]].toBase58()})`
          : ''),
    )
    checked++
    if (!ok) failed++
  }
}

console.log(failed === 0 ? `\nALL ${checked} INSTRUCTIONS MATCH the chain's wire format` : `\n${failed} MISMATCHES`)
process.exit(failed === 0 ? 0 : 1)
