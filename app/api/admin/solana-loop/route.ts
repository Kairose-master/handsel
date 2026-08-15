/**
 * POST /api/admin/solana-loop — run the whole money loop on devnet, from the
 * platform, in one call.
 *
 * Week 3 of the Eternal sprint (docs/solana-port.md): the write path. Week 2
 * proved the loop from a CI script; this proves it from the OFF-CHAIN STACK —
 * the same Next.js deployment that serves /solana signs and sends every
 * instruction, and the board updates from the chain as the job walks
 * Open → Accepted → Submitted → Completed.
 *
 * What it does, with real transactions: fund two ephemeral keypairs (SOL from
 * the operator — devnet airdrops rate-limit), mint them test tokens (the
 * operator is the mint authority on the devnet test mint), then
 * post → accept (bond) → submit → approve → withdraw. Returns every signature
 * with its explorer link, so nothing here is take-my-word-for-it.
 *
 * Guards, in order of importance:
 *  - devnet-only: write.ts refuses on any real-money cluster, and this route
 *    checks first so the refusal is a clean 400 rather than a mid-loop throw.
 *  - operator-secret auth, POST-only (lib/admin-route — a GET that spends
 *    devnet SOL on every link unfurl would still be a bug).
 */
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { createHash } from 'node:crypto'
import { requireOperator } from '@/lib/admin-route'
import { leftoverNote, parseStopAfter, stopsAfter, type LoopStep } from '@/lib/solana-loop-plan'
import { solanaClusterName, solanaEnv, solanaExplorerUrl, solanaIsRealMoney } from '@/lib/onchain/solana/config'
import {
  acceptJob,
  approveJob,
  fetchMarket,
  isSolanaWriteConfigured,
  loadOperatorKeypair,
  pda,
  postJob,
  solanaConnection,
  submitWork,
  withdraw,
} from '@/lib/onchain/solana/write'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // ~10 confirmed transactions on devnet

const BOUNTY = 1_000_000n // 1.00 test token, matching the happy-path runs

export async function POST(request: Request) {
  const auth = requireOperator(request, { mutating: true })
  if (!auth.ok) return auth.response

  // Parsed before anything spends. `lib/solana-loop-plan.ts` carries why an
  // unrecognised value must refuse rather than fall back to the full loop.
  const body = await request.json().catch(() => ({}))
  const parsed = parseStopAfter((body as { stop_after?: unknown })?.stop_after)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
  const stopAfter = parsed.stopAfter
  const stops = (step: LoopStep) => stopsAfter(stopAfter, step)

  if (!isSolanaWriteConfigured()) {
    return Response.json(
      {
        error:
          'Solana write path is not configured — set SOLANA_CLUSTER, SOLANA_PROGRAM_ID and SOLANA_OPERATOR_KEYPAIR',
      },
      { status: 503 },
    )
  }
  if (solanaIsRealMoney()) {
    return Response.json(
      { error: `cluster '${solanaClusterName()}' is not a test cluster — the write path is devnet-only by policy` },
      { status: 400 },
    )
  }

  const connection = solanaConnection()
  const operator = loadOperatorKeypair()!
  const steps: Array<{ step: string; signature: string; tx: string }> = []
  const record = (step: string, signature: string) => {
    steps.push({ step, signature, tx: txUrl(signature) })
  }

  try {
    const market = await fetchMarket(connection)
    const mint = new PublicKey(market.usdcMint)
    const feeRecipient = new PublicKey(market.feeRecipient)

    // Two ephemeral parties. SelfDeal is program-enforced, so the requester
    // and the worker must genuinely be different keys.
    const requester = Keypair.generate()
    const worker = Keypair.generate()
    // A worker that will never act needs neither SOL nor tokens. Devnet
    // airdrops rate-limit, so the operator's balance is a real constraint and
    // funding an unused party is a cost with no purpose.
    const needsWorker = !stops('post')
    const transfers = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: requester.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    )
    if (needsWorker) {
      transfers.add(
        SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: worker.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
      )
    }
    const fundSig = await sendAndConfirmTransaction(connection, transfers, [operator], { commitment: 'confirmed' })
    record(needsWorker ? 'fund parties (SOL)' : 'fund requester (SOL)', fundSig)

    const requesterAta = await getOrCreateAssociatedTokenAccount(connection, operator, mint, requester.publicKey)
    // The operator created the devnet test mint (happy-path first run), so it
    // is the mint authority. On any other setup this throws and the error
    // says exactly that.
    await mintTo(connection, operator, mint, requesterAta.address, operator, Number(BOUNTY) * 4)
    const workerAta = needsWorker
      ? await getOrCreateAssociatedTokenAccount(connection, operator, mint, worker.publicKey)
      : null
    if (workerAta) await mintTo(connection, operator, mint, workerAta.address, operator, Number(BOUNTY) * 4)

    const spec = `handsel devnet loop demo — posted by the platform at slot ${await connection.getSlot()}`
    const specHashHex = createHash('sha256').update(spec).digest('hex')

    const posted = await postJob(connection, requester, requesterAta.address, {
      bounty: BOUNTY,
      minScore: 0n,
      specHashHex,
      deliveryWindow: 3600,
    })
    record(`post_job (#${posted.jobId})`, posted.signature)

    if (!stops('post')) {
      record('accept_job (bond staked)', await acceptJob(connection, worker, workerAta!.address, posted.jobId))
    }
    if (!stops('accept')) {
      const resultHashHex = createHash('sha256').update(`${spec} — done`).digest('hex')
      record('submit_work (result_hash set)', await submitWork(connection, worker, posted.jobId, resultHashHex))
    }
    if (!stops('submit')) {
      record(
        'approve_job (pull-payment credit)',
        await approveJob(connection, requester, posted.jobId, worker.publicKey, feeRecipient),
      )
    }
    if (!stops('approve')) {
      record('withdraw (tokens leave the vault)', await withdraw(connection, worker, workerAta!.address))
    }

    return Response.json({
      cluster: solanaClusterName(),
      job_id: posted.jobId.toString(),
      job_account: solanaExplorerUrl(posted.jobPda.toBase58()),
      vault: solanaExplorerUrl(pda.vault().toBase58()),
      board: '/solana',
      stopped_after: stopAfter,
      note: leftoverNote(stopAfter),
      steps,
    })
  } catch (error) {
    // Signatures collected before the failure stay in the answer — a loop
    // that died at step 4 leaves real state on chain, and hiding the first
    // three receipts would make that state look like a mystery.
    console.error('[solana-loop] failed:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : String(error), completed_steps: steps },
      { status: 502 },
    )
  }
}

function txUrl(signature: string): string {
  const cluster = solanaEnv.cluster
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(cluster)}`
  return `https://explorer.solana.com/tx/${signature}${suffix}`
}
