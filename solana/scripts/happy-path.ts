/**
 * The money loop, end to end, against a live cluster.
 *
 * post → accept (bond) → submit → approve → withdraw, with the arithmetic
 * asserted at every step rather than eyeballed. This is the "verify by
 * running" half of the repo's own gate list: `cargo check` and `anchor build`
 * prove the program compiles, and neither has any opinion about whether the
 * escrow adds up.
 *
 * Idempotent on purpose. The market is a singleton PDA (seeds `["market"]`),
 * so it can only be initialised once per program — a script that assumed a
 * fresh cluster would work exactly once and then fail in a way that looks like
 * a program bug. On re-run it adopts the existing market and its mint.
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/happy-path.ts
 */
import * as anchor from '@coral-xyz/anchor'
import { BN, Program } from '@coral-xyz/anchor'
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token'
import idl from '../target/idl/handsel_market.json'
import type { HandselMarket } from '../target/types/handsel_market'

// Mirrors the program's constants. Duplicated deliberately: if a constant
// changes on one side and not the other, an assertion below fails loudly
// instead of the script quietly agreeing with whatever the program did.
const DECIMALS = 6
const BOUNTY = 1_000_000 // 1.00 token
const FEE_BPS = 500
const FLAT_FEE = 30_000
const BOND_BPS = 500
const FLAT_BOND = 30_000
const REVIEW_WINDOW = 600 // 10m — the program's MIN_REVIEW_WINDOW
const DELIVERY_WINDOW = 3600 // 1h — the program's MIN_DELIVERY_WINDOW
const MIN_BOUNTY = 1

const expectedFee = FLAT_FEE + (BOUNTY * FEE_BPS) / 10_000
const expectedBond = FLAT_BOND + (BOUNTY * BOND_BPS) / 10_000

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

function step(n: number, msg: string) {
  console.log(`\n[${n}] ${msg}`)
}

async function main() {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)
  const program = new Program<HandselMarket>(idl as HandselMarket, provider)
  const payer = provider.wallet.publicKey
  // The Keypair, not the pubkey. spl-token's `authority` parameter accepts
  // `Signer | PublicKey` — the PublicKey form is for multisig and silently
  // typechecks while producing a transaction nobody signed.
  const walletPayer = (provider.wallet as anchor.Wallet).payer
  console.log(`cluster : ${provider.connection.rpcEndpoint}`)
  console.log(`program : ${program.programId.toBase58()}`)
  console.log(`payer   : ${payer.toBase58()}`)

  const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market')], program.programId)
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault')], program.programId)

  // ── 1. market ──────────────────────────────────────────────────────────
  step(1, 'market')
  let market = await program.account.market.fetchNullable(marketPda)
  // The fee recipient must not be the oracle — the program rejects it at init,
  // for the reason docs/basescan-verification.md records on the EVM side: a fee
  // stream welded to the key that signs oracle writes.
  const oracle = payer
  const feeRecipient = Keypair.generate().publicKey

  if (market) {
    console.log(`  adopting existing market (jobs so far: ${market.jobCount.toString()})`)
  } else {
    const mint = await createMint(provider.connection, walletPayer, payer, null, DECIMALS)
    console.log(`  minted test token ${mint.toBase58()}`)
    await program.methods
      .initMarket({
        oracle,
        feeRecipient,
        feeBps: FEE_BPS,
        flatFee: new BN(FLAT_FEE),
        bondBps: BOND_BPS,
        flatBond: new BN(FLAT_BOND),
        reviewWindow: REVIEW_WINDOW,
        minBounty: new BN(MIN_BOUNTY),
      })
      .accountsPartial({
        market: marketPda,
        vault: vaultPda,
        usdcMint: mint,
        authority: payer,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
    market = await program.account.market.fetch(marketPda)
    console.log(`  initialised market ${marketPda.toBase58()}`)
  }
  const mint = market.usdcMint
  const jobId = market.jobCount
  console.log(`  vault ${vaultPda.toBase58()} · mint ${mint.toBase58()} · next job #${jobId.toString()}`)

  // ── 2. two parties ─────────────────────────────────────────────────────
  step(2, 'funding a requester and a worker')
  const requester = Keypair.generate()
  const worker = Keypair.generate()
  // SOL from the payer rather than the faucet: devnet airdrops rate-limit, and
  // a script that fails on someone else's rate limit teaches nothing.
  const fund = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: requester.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: worker.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
  )
  await provider.sendAndConfirm(fund)

  const requesterAta = await getOrCreateAssociatedTokenAccount(provider.connection, walletPayer, mint, requester.publicKey)
  const workerAta = await getOrCreateAssociatedTokenAccount(provider.connection, walletPayer, mint, worker.publicKey)
  // Enough for the bounty + fee, and the bond, with change left over so a
  // balance assertion that should shrink cannot pass by hitting zero.
  await mintTo(provider.connection, walletPayer, mint, requesterAta.address, walletPayer, BOUNTY * 4)
  await mintTo(provider.connection, walletPayer, mint, workerAta.address, walletPayer, BOUNTY * 4)
  console.log(`  requester ${requester.publicKey.toBase58()}`)
  console.log(`  worker    ${worker.publicKey.toBase58()}`)

  const balance = async (ata: PublicKey) => Number((await getAccount(provider.connection, ata)).amount)
  const requesterBefore = await balance(requesterAta.address)
  const workerBefore = await balance(workerAta.address)

  const [jobPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('job'), jobId.toArrayLike(Buffer, 'le', 8)],
    program.programId,
  )
  const [workerLedger] = PublicKey.findProgramAddressSync(
    [Buffer.from('withdrawable'), worker.publicKey.toBuffer()],
    program.programId,
  )
  const [feeLedger] = PublicKey.findProgramAddressSync(
    [Buffer.from('withdrawable'), market.feeRecipient.toBuffer()],
    program.programId,
  )

  // ── 3. post ────────────────────────────────────────────────────────────
  step(3, `post_job — bounty ${BOUNTY}, fee ${expectedFee}`)
  const specHash = Array.from(Buffer.alloc(32, 7))
  await program.methods
    .postJob(new BN(BOUNTY), new BN(0), specHash, DELIVERY_WINDOW)
    .accountsPartial({
      market: marketPda,
      job: jobPda,
      requester: requester.publicKey,
      requesterToken: requesterAta.address,
      vault: vaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([requester])
    .rpc()

  let job = await program.account.job.fetch(jobPda)
  assert(job.fee.toNumber() === expectedFee, `fee ${job.fee} != ${expectedFee}`)
  assert(Object.keys(job.status)[0] === 'open', `status ${JSON.stringify(job.status)} != Open`)
  const afterPost = await balance(requesterAta.address)
  assert(
    requesterBefore - afterPost === BOUNTY + expectedFee,
    `requester paid ${requesterBefore - afterPost}, expected ${BOUNTY + expectedFee}`,
  )
  console.log(`  ok — escrowed ${BOUNTY + expectedFee}, job #${job.id.toString()} Open`)

  // ── 4. accept ──────────────────────────────────────────────────────────
  step(4, `accept_job — bond ${expectedBond}`)
  await program.methods
    .acceptJob()
    .accountsPartial({
      market: marketPda,
      job: jobPda,
      worker: worker.publicKey,
      workerToken: workerAta.address,
      vault: vaultPda,
      workerCredit: null, // min_score is 0, so no credit account is required
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([worker])
    .rpc()

  job = await program.account.job.fetch(jobPda)
  assert(job.bond.toNumber() === expectedBond, `bond ${job.bond} != ${expectedBond}`)
  assert(Object.keys(job.status)[0] === 'accepted', 'status != Accepted')
  const afterAccept = await balance(workerAta.address)
  assert(
    workerBefore - afterAccept === expectedBond,
    `worker staked ${workerBefore - afterAccept}, expected ${expectedBond}`,
  )
  // The invariant the whole UI hangs off: an Accepted job has no submission.
  assert(job.resultHash.every((b: number) => b === 0), 'result_hash must still be zero on Accepted')
  console.log(`  ok — bond staked, result_hash still zero`)

  // ── 5. submit ──────────────────────────────────────────────────────────
  step(5, 'submit_work')
  const resultHash = Array.from(Buffer.alloc(32, 42))
  await program.methods
    .submitWork(resultHash)
    .accountsPartial({ market: marketPda, job: jobPda, worker: worker.publicKey })
    .signers([worker])
    .rpc()

  job = await program.account.job.fetch(jobPda)
  assert(Object.keys(job.status)[0] === 'submitted', 'status != Submitted')
  assert(job.resultHash.some((b: number) => b !== 0), 'result_hash must be non-zero after submit')
  assert(job.reviewDeadline.toNumber() > 0, 'review deadline not set')
  console.log(`  ok — result_hash set, review closes at ${new Date(job.reviewDeadline.toNumber() * 1000).toISOString()}`)

  // ── 6. approve ─────────────────────────────────────────────────────────
  step(6, 'approve_job — pull-payment credit, no tokens move')
  const vaultBeforeApprove = await balance(vaultPda)
  await program.methods
    .approveJob()
    .accountsPartial({
      market: marketPda,
      job: jobPda,
      authority: requester.publicKey,
      workerWithdrawable: workerLedger,
      feeWithdrawable: feeLedger,
      systemProgram: SystemProgram.programId,
    })
    .signers([requester])
    .rpc()

  job = await program.account.job.fetch(jobPda)
  assert(Object.keys(job.status)[0] === 'completed', 'status != Completed')
  const ledger = await program.account.withdrawable.fetch(workerLedger)
  const feeOwed = await program.account.withdrawable.fetch(feeLedger)
  assert(
    ledger.amount.toNumber() === BOUNTY + expectedBond,
    `worker owed ${ledger.amount}, expected ${BOUNTY + expectedBond} (bounty + returned bond)`,
  )
  assert(feeOwed.amount.toNumber() === expectedFee, `fee owed ${feeOwed.amount}, expected ${expectedFee}`)
  // Pull payments: settlement is bookkeeping. Nothing left the vault.
  assert(
    (await balance(vaultPda)) === vaultBeforeApprove,
    'vault balance changed on approve — settlement must credit, not transfer',
  )
  console.log(`  ok — worker owed ${ledger.amount}, fee owed ${feeOwed.amount}, vault untouched`)

  // ── 7. withdraw ────────────────────────────────────────────────────────
  step(7, 'withdraw — the only instruction that moves tokens out')
  await program.methods
    .withdraw()
    .accountsPartial({
      market: marketPda,
      withdrawable: workerLedger,
      owner: worker.publicKey,
      ownerToken: workerAta.address,
      vault: vaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([worker])
    .rpc()

  const workerFinal = await balance(workerAta.address)
  assert(
    workerFinal - workerBefore === BOUNTY,
    `worker net ${workerFinal - workerBefore}, expected +${BOUNTY} (bond staked then returned)`,
  )
  const drained = await program.account.withdrawable.fetch(workerLedger)
  assert(drained.amount.toNumber() === 0, 'ledger must be zeroed by withdraw')
  console.log(`  ok — worker net +${BOUNTY}, ledger zeroed`)

  // ── 8. solvency ────────────────────────────────────────────────────────
  step(8, 'solvency')
  const finalMarket = await program.account.market.fetch(marketPda)
  const vaultAmount = await balance(vaultPda)
  const owed = finalMarket.totalEscrowed.toNumber() + finalMarket.totalWithdrawable.toNumber()
  assert(owed <= vaultAmount, `INSOLVENT: owes ${owed}, holds ${vaultAmount}`)
  console.log(`  ok — owes ${owed}, holds ${vaultAmount}`)

  console.log('\nHAPPY PATH PASSED')
  console.log(`job:     https://explorer.solana.com/address/${jobPda.toBase58()}?cluster=devnet`)
  console.log(`program: https://explorer.solana.com/address/${program.programId.toBase58()}?cluster=devnet`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
