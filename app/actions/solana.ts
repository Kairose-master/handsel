'use server'

/**
 * The Solana devnet board, shaped for a page. Wraps `lib/onchain/solana/read`
 * and keeps its three-value read state intact — 'unconfigured' and
 * 'unreachable' must reach the UI as themselves, never as an empty board
 * (`app/actions/guest.ts` documents the incident behind that rule).
 *
 * BigInts are serialized here because server actions can't return them; the
 * base-unit strings stay exact and the client formats for display.
 */
import { readSolanaAudit, readSolanaJobs, type SolanaReadState } from '@/lib/onchain/solana/read'
import {
  solanaClusterName,
  solanaExplorerUrl,
  solanaIsRealMoney,
  solanaEnv,
  isSolanaConfigured,
} from '@/lib/onchain/solana/config'

export interface SolanaBoardView {
  state: SolanaReadState
  cluster: string
  realMoney: boolean
  programId: string
  programExplorerUrl: string
  /** The auditor's view — every program invariant recomputed from raw
   *  accounts at read time. Null when the market/RPC could not be read. */
  audit: {
    totalEscrowed: string
    totalWithdrawable: string
    vaultAmount: string | null
    ledgerCount: number
    ok: boolean
    checks: Array<{ name: string; ok: boolean; detail: string }>
  } | null
  jobs: Array<{
    id: number
    status: string
    /** Base units (6dp test token), exact. */
    bounty: string
    fee: string
    bond: string
    requester: string
    worker: string
    resultHash: string
    hasResult: boolean
    createdAt: number
    deadline: number | null
    lapsed: boolean
    requesterUrl: string
    workerUrl: string
  }>
}

/** All-zero worker = job never accepted; the codec preserves it verbatim. */
const ZERO_ADDRESS_RESULT = /^0x0+$/

export async function getSolanaBoard(): Promise<SolanaBoardView> {
  const board = await readSolanaJobs()
  const audit = board.state === 'ok' ? await readSolanaAudit(board.jobs) : null
  return {
    state: board.state,
    cluster: solanaClusterName(),
    realMoney: solanaIsRealMoney(),
    programId: isSolanaConfigured() ? solanaEnv.programId : '',
    programExplorerUrl: isSolanaConfigured() ? solanaExplorerUrl(solanaEnv.programId) : '',
    audit: audit
      ? {
          totalEscrowed: audit.market.totalEscrowed.toString(),
          totalWithdrawable: audit.market.totalWithdrawable.toString(),
          vaultAmount: audit.vaultAmount?.toString() ?? null,
          ledgerCount: audit.ledgerCount,
          ok: audit.invariants.ok,
          checks: audit.invariants.checks,
        }
      : null,
    jobs: board.jobs.map((j) => ({
      id: j.id,
      status: j.status,
      bounty: j.bounty.toString(),
      fee: j.fee.toString(),
      bond: j.bond.toString(),
      requester: j.requester,
      worker: j.worker,
      resultHash: j.resultHash,
      hasResult: !ZERO_ADDRESS_RESULT.test(j.resultHash),
      createdAt: j.createdAt,
      deadline: j.deadline,
      lapsed: j.lapsed,
      requesterUrl: solanaExplorerUrl(j.requester),
      workerUrl: solanaExplorerUrl(j.worker),
    })),
  }
}
