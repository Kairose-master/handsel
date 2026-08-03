/**
 * Projecting a LaborMarketV2 job into ERC-8183's vocabulary.
 *
 * [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) — "Agentic Commerce",
 * from Virtuals Protocol and the Ethereum Foundation — standardises the Job
 * primitive: a client, a provider, an evaluator, escrowed budget, and the
 * lifecycle `Open → Funded → Submitted → Terminal`. That is the same shape
 * LaborMarketV2 already implements, which makes speaking the standard cheap
 * and worth doing: `docs/product-thesis.md` argues the escrow is not the
 * asset ("the asset is the ledger, not the score"), so there is nothing to
 * defend by being incompatible with a standard for escrows.
 *
 * **This is an export, not conformance, and the direction matters.**
 *
 * Going the other way — accepting 8183 calls — is not an adapter. 8183 has
 * the client *assign* a provider (`setProvider`); this market has the worker
 * *claim* a job (`acceptJob`, behind a credit gate, staking a bond). Those
 * are different markets: 8183 standardises procurement, this is an open
 * board. Conforming inbound would mean changing who may take work, which is
 * the mechanism, not the interface.
 *
 * So: read-only, pure, and honest about what it drops. A projection that
 * silently discarded the bond would hand a consumer a job that looks like an
 * ordinary 8183 job and is not — `lost` exists so the caller can see the
 * difference instead of inferring it.
 */

/** The fields this needs. A structural subset of `OnchainJob` so the mapping
 *  is testable without a chain — same approach as `lib/challenge.ts`. */
export type LaborJobInput = {
  id: number
  requester: string
  worker: string
  bounty: number
  minScore: number
  status: string
  resultHash: string
  deadline: number | null
}

/** ERC-8183's six states, in spec order. */
export const ERC8183_STATUSES = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'] as const
export type Erc8183Status = (typeof ERC8183_STATUSES)[number]

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** What the standard has no field for. Reported rather than dropped. */
export type Erc8183Loss = 'worker-bond' | 'credit-gate' | 'dispute' | 'no-verdict-expiry'

export type Erc8183Job = {
  jobId: number
  client: string
  /** Zero until a worker claims it — the standard's own convention for an
   *  unassigned provider. */
  provider: string
  /** 8183 permits `evaluator = client` "when there is no third-party
   *  attester", and that is exactly this market: `approveJob` reverts with
   *  `NotRequester` for anyone else. So the degenerate case is the honest
   *  mapping, not a shortcut. */
  evaluator: string
  budget: number
  expiredAt: number
  status: Erc8183Status
  /** 8183's `submit(jobId, deliverable)` payload. Zero hash until submitted,
   *  which is the same signal `lib/job-grade.ts` reads. */
  deliverable: string
  /** Non-empty whenever the projection could not carry something. */
  lost: Erc8183Loss[]
}

/**
 * V2 status → 8183 status.
 *
 * The mapping is not symmetric and the asymmetries are the interesting part:
 *
 * - **`Open` becomes `Funded`.** V2 escrows inside `postJob`, so a V2 job is
 *   funded from the instant it exists. 8183's `Open` — created but not yet
 *   funded — is *unreachable* from this market, and a test pins that.
 * - **`Accepted` also becomes `Funded`.** 8183 has no state for "a provider
 *   has committed and staked a bond". This is the biggest thing the standard
 *   cannot see, and it is not cosmetic: the bond is what makes claiming cost
 *   something, which is this market's Sybil resistance on the worker side.
 * - **`Disputed` becomes `Submitted`.** In 8183 terms a disputed job is
 *   precisely one where work was delivered and the evaluator has not yet
 *   ruled, which is what `Submitted` means. The dispute *process* is lost;
 *   the position in the lifecycle is not.
 */
const STATUS_MAP: Record<string, Erc8183Status> = {
  Open: 'Funded',
  Accepted: 'Funded',
  Submitted: 'Submitted',
  Completed: 'Completed',
  Cancelled: 'Rejected',
  Refunded: 'Rejected',
  Disputed: 'Submitted',
  Expired: 'Expired',
}

function hasWorker(worker: string): boolean {
  return worker.toLowerCase() !== ZERO_ADDRESS
}

/**
 * Project one job. Returns null for a status this build has never heard of —
 * same rule as `decodeJobAccount`: guessing which 8183 state an unknown V2
 * state maps to would publish a lifecycle position nobody reached.
 */
export function toErc8183(job: LaborJobInput): Erc8183Job | null {
  const status = STATUS_MAP[job.status]
  if (!status) return null

  const lost: Erc8183Loss[] = []
  // The bond exists from the moment a worker accepts, and stays relevant
  // through every state that followed an acceptance.
  if (hasWorker(job.worker)) lost.push('worker-bond')
  if (job.minScore > 0) lost.push('credit-gate')
  if (job.status === 'Disputed') lost.push('dispute')
  // 8183's `Expired` is defined with one beneficiary: "escrow refunded to
  // client after timeout". V2's means "settled by a deadline with no verdict
  // from anyone", and its three routes there settle to three DIFFERENT
  // parties:
  //
  //   expireOpen     nobody took the job    -> requester, in full
  //   expireReview   requester went silent  -> SPLIT, 10% forfeit to the
  //                                            worker side, 90% refunded
  //   expireDispute  arbiter never ruled    -> worker, in full
  //
  // So the same terminal word covers a full refund, a partial forfeit, and a
  // full release. Projecting any of them as 8183 `Expired` tells a reader the
  // client got their money back, which is true in one case out of three.
  if (job.status === 'Expired') lost.push('no-verdict-expiry')

  return {
    jobId: job.id,
    client: job.requester,
    provider: hasWorker(job.worker) ? job.worker : ZERO_ADDRESS,
    evaluator: job.requester,
    budget: job.bounty,
    expiredAt: job.deadline ?? 0,
    status,
    deliverable: job.resultHash,
    lost,
  }
}

/** Project a board. Unmappable rows are dropped rather than guessed, so the
 *  count can be shorter than the input — the caller reports a short read the
 *  same way the task feed does. */
export function toErc8183Board(jobs: LaborJobInput[]): Erc8183Job[] {
  return jobs.map(toErc8183).filter((j): j is Erc8183Job => j !== null)
}
