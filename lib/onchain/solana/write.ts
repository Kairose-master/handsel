/**
 * The write path — signing and sending, the one file that needs an SDK.
 *
 * Instruction bytes and account orders come from `tx.ts` (pure, pinned to
 * the Rust by tests); this file only turns them into signed transactions.
 * `docs/solana-port.md` week 3: "signing needs ed25519 and transaction
 * serialisation, which is what an SDK is for."
 *
 * Commitment is `confirmed` everywhere, and that is load-bearing — the
 * happy-path script documents the failure mode verbatim: with `processed`,
 * a follow-up instruction's preflight can land on a node one slot behind
 * and report AccountNotInitialized for an account that demonstrably exists.
 *
 * Env:
 *   SOLANA_OPERATOR_KEYPAIR — JSON byte array (the id.json format) for the
 *   key that pays and signs platform-side writes. Devnet-only by policy:
 *   every entry point below refuses when `solanaIsRealMoney()`.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { decodeMarketAccount, type SolanaMarket } from './codec'
import { isSolanaConfigured, solanaEnv, solanaIsRealMoney, solanaRpcUrl } from './config'
import {
  INSTRUCTION_ACCOUNTS,
  PDA_SEEDS,
  encodeAcceptJob,
  encodeApproveJob,
  encodePostJob,
  encodeSetCredit,
  encodeSubmitWork,
  encodeWithdraw,
} from './tx'

export function loadOperatorKeypair(raw = process.env.SOLANA_OPERATOR_KEYPAIR): Keypair | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  try {
    const bytes = JSON.parse(trimmed) as number[]
    if (!Array.isArray(bytes) || bytes.length !== 64) return null
    return Keypair.fromSecretKey(Uint8Array.from(bytes))
  } catch {
    return null
  }
}

export function isSolanaWriteConfigured(): boolean {
  return isSolanaConfigured() && loadOperatorKeypair() !== null
}

export function solanaConnection(): Connection {
  const url = solanaRpcUrl()
  if (!url) throw new Error('no Solana RPC configured')
  return new Connection(url, 'confirmed')
}

export function programId(): PublicKey {
  return new PublicKey(solanaEnv.programId)
}

// ── PDAs (seed layouts from tx.ts, derivation from the SDK) ───────────────

export const pda = {
  market: () => PublicKey.findProgramAddressSync(PDA_SEEDS.market(), programId())[0],
  vault: () => PublicKey.findProgramAddressSync(PDA_SEEDS.vault(), programId())[0],
  job: (id: bigint) => PublicKey.findProgramAddressSync(PDA_SEEDS.job(id), programId())[0],
  withdrawable: (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(PDA_SEEDS.withdrawable(owner.toBase58()), programId())[0],
  credit: (agent: PublicKey) =>
    PublicKey.findProgramAddressSync(PDA_SEEDS.credit(agent.toBase58()), programId())[0],
}

export async function fetchMarket(connection: Connection): Promise<SolanaMarket> {
  const info = await connection.getAccountInfo(pda.market())
  if (!info) throw new Error('market account not found — is the program initialised on this cluster?')
  const market = decodeMarketAccount(new Uint8Array(info.data))
  if (!market) throw new Error('market account failed to decode — codec/program layout mismatch')
  return market
}

/** Build a TransactionInstruction from tx.ts's account order + data bytes.
 *  `keys` must be passed in the exact order INSTRUCTION_ACCOUNTS declares —
 *  the names are asserted here so a caller reordering args fails loudly. */
function ix(name: string, keys: Array<{ name: string; pubkey: PublicKey }>, data: Uint8Array): TransactionInstruction {
  const spec = INSTRUCTION_ACCOUNTS[name]
  if (!spec) throw new Error(`unknown instruction ${name}`)
  if (keys.length !== spec.accounts.length) {
    throw new Error(`${name} expects ${spec.accounts.length} accounts, got ${keys.length}`)
  }
  return new TransactionInstruction({
    programId: programId(),
    keys: spec.accounts.map((acc, i) => {
      if (keys[i].name !== acc.name) throw new Error(`${name} account ${i} must be ${acc.name}, got ${keys[i].name}`)
      return { pubkey: keys[i].pubkey, isWritable: acc.writable, isSigner: acc.signer }
    }),
    data: Buffer.from(data),
  })
}

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

function guardDevnet() {
  if (solanaIsRealMoney()) {
    // The write path has no mainnet standing (docs/solana-port.md) — this is
    // the code-level enforcement of that document, same as the EVM side's
    // isRealMoney() guards.
    throw new Error(`refusing to write on '${solanaEnv.cluster}' — the Solana write path is devnet-only`)
  }
}

async function send(connection: Connection, instruction: TransactionInstruction, signers: Keypair[]): Promise<string> {
  guardDevnet()
  const tx = new Transaction().add(instruction)
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
}

// ── the money loop, one call per instruction ──────────────────────────────

export async function postJob(
  connection: Connection,
  requester: Keypair,
  requesterToken: PublicKey,
  args: { bounty: bigint; minScore: bigint; specHashHex: string; deliveryWindow: number },
): Promise<{ signature: string; jobId: bigint; jobPda: PublicKey }> {
  const market = await fetchMarket(connection)
  const jobId = BigInt(market.jobCount)
  const jobPda = pda.job(jobId)
  const signature = await send(
    connection,
    ix(
      'post_job',
      [
        { name: 'market', pubkey: pda.market() },
        { name: 'job', pubkey: jobPda },
        { name: 'requester', pubkey: requester.publicKey },
        { name: 'requester_token', pubkey: requesterToken },
        { name: 'vault', pubkey: pda.vault() },
        { name: 'token_program', pubkey: TOKEN_PROGRAM },
        { name: 'system_program', pubkey: SystemProgram.programId },
      ],
      encodePostJob(args.bounty, args.minScore, args.specHashHex, args.deliveryWindow),
    ),
    [requester],
  )
  return { signature, jobId, jobPda }
}

export async function acceptJob(
  connection: Connection,
  worker: Keypair,
  workerToken: PublicKey,
  jobId: bigint,
): Promise<string> {
  return send(
    connection,
    ix(
      'accept_job',
      [
        { name: 'market', pubkey: pda.market() },
        { name: 'job', pubkey: pda.job(jobId) },
        { name: 'worker', pubkey: worker.publicKey },
        { name: 'worker_token', pubkey: workerToken },
        { name: 'vault', pubkey: pda.vault() },
        // Option<Account> None — Anchor's wire convention: pass the program id.
        { name: 'worker_credit', pubkey: programId() },
        { name: 'token_program', pubkey: TOKEN_PROGRAM },
      ],
      encodeAcceptJob(),
    ),
    [worker],
  )
}

export async function submitWork(
  connection: Connection,
  worker: Keypair,
  jobId: bigint,
  resultHashHex: string,
): Promise<string> {
  return send(
    connection,
    ix(
      'submit_work',
      [
        { name: 'market', pubkey: pda.market() },
        { name: 'job', pubkey: pda.job(jobId) },
        { name: 'worker', pubkey: worker.publicKey },
      ],
      encodeSubmitWork(resultHashHex),
    ),
    [worker],
  )
}

export async function approveJob(
  connection: Connection,
  requester: Keypair,
  jobId: bigint,
  worker: PublicKey,
  feeRecipient: PublicKey,
): Promise<string> {
  return send(
    connection,
    ix(
      'approve_job',
      [
        { name: 'market', pubkey: pda.market() },
        { name: 'job', pubkey: pda.job(jobId) },
        { name: 'authority', pubkey: requester.publicKey },
        { name: 'worker_withdrawable', pubkey: pda.withdrawable(worker) },
        { name: 'fee_withdrawable', pubkey: pda.withdrawable(feeRecipient) },
        { name: 'system_program', pubkey: SystemProgram.programId },
      ],
      encodeApproveJob(),
    ),
    [requester],
  )
}

/** Oracle publishes an agent's credit score + limit to its Credit PDA — the
 *  registry half of the EVM pair, on the second runtime. The signer must be
 *  the market's fixed oracle key; the program enforces it and the caller
 *  should have checked `fetchMarket().oracle` first for a readable error. */
export async function setCredit(
  connection: Connection,
  oracle: Keypair,
  agent: PublicKey,
  score: bigint,
  limit: bigint,
): Promise<{ signature: string; creditPda: PublicKey }> {
  const creditPda = pda.credit(agent)
  const signature = await send(
    connection,
    ix(
      'set_credit',
      [
        { name: 'market', pubkey: pda.market() },
        { name: 'credit', pubkey: creditPda },
        { name: 'oracle', pubkey: oracle.publicKey },
        { name: 'system_program', pubkey: SystemProgram.programId },
      ],
      encodeSetCredit(agent.toBase58(), score, limit),
    ),
    [oracle],
  )
  return { signature, creditPda }
}

export async function withdraw(
  connection: Connection,
  owner: Keypair,
  ownerToken: PublicKey,
): Promise<string> {
  return send(
    connection,
    ix(
      'withdraw',
      [
        { name: 'market', pubkey: pda.market() },
        { name: 'withdrawable', pubkey: pda.withdrawable(owner.publicKey) },
        { name: 'owner', pubkey: owner.publicKey },
        { name: 'owner_token', pubkey: ownerToken },
        { name: 'vault', pubkey: pda.vault() },
        { name: 'token_program', pubkey: TOKEN_PROGRAM },
      ],
      encodeWithdraw(),
    ),
    [owner],
  )
}
