/**
 * The contract object: one machine-readable record of an agreement between
 * two agents.
 *
 * Handsel already has every fact this describes — a sealed brief, an on-chain
 * job, a grader verdict, a settlement split. What it did not have was a name
 * for the whole, and a statement of which parts are BINDING. That distinction
 * is the point of this file, not the shape:
 *
 *   The specHash commits nine fields and nothing else.
 *
 * `lib/spec-hash.ts` seals title, agent, nonce, description, acceptance
 * criteria, test code, deliverable kind, required capabilities and test-suite
 * slug. Everything else about a job — who graded it, whether it passed, what
 * the escrow did, who got paid — is TRUE but not COMMITTED. It is observed
 * after the fact by this platform, and a reader who cannot see the line
 * between the two is trusting our database exactly as much as they trust the
 * chain, while believing they are trusting the chain.
 *
 * So every field here carries its provenance, and the three values are not
 * decoration:
 *
 *   'sealed'   — inside the specHash. Tamper with it and `briefMatchesHash`
 *                says so. This is what the counterparty actually agreed to.
 *   'chain'    — read from the LaborMarket contract. Not in the hash, but not
 *                ours to edit either.
 *   'platform' — this deployment's own record. Believe it exactly as much as
 *                you believe us.
 *
 * A counterparty agent consuming this can then do the only thing that matters:
 * decide what it is willing to rely on. That is the difference between a
 * contract and a receipt.
 *
 * This is a PROJECTION, in the sense CLAUDE.md means: the canonical state
 * stays in job_specs and on-chain, and this is derived from it. Nothing writes
 * a contract object; there is no second source of truth to drift.
 */
import type { GraderClass } from '@/lib/grader-class'

export const AGENT_CONTRACT_PROTOCOL = 'handsel/agent-contract'
export const AGENT_CONTRACT_VERSION = 1

/** Where a field came from, and therefore what it is worth. */
export type Provenance = 'sealed' | 'chain' | 'platform'

/** A value and the reason to believe it. Every leaf that a counterparty might
 *  act on is wrapped, rather than documented in prose somewhere else — a
 *  provenance you have to look up is a provenance nobody checks. */
export type Attested<T> = { value: T; from: Provenance }

function sealed<T>(value: T): Attested<T> {
  return { value, from: 'sealed' }
}
function chain<T>(value: T): Attested<T> {
  return { value, from: 'chain' }
}
function platform<T>(value: T): Attested<T> {
  return { value, from: 'platform' }
}

/** Does the stored brief still hash to what was posted on-chain? Mirrors
 *  BriefVerdict in lib/spec-hash.ts rather than importing it, so a contract
 *  can be built from a plain row with no chain access. */
export type BindingState = 'sealed' | 'mismatch' | 'unverifiable'

/** Map lib/spec-hash.ts's verdict onto this vocabulary.
 *
 *  Its 'match' becomes 'sealed' rather than being reused, because the two
 *  words answer different questions: 'match' says the stored row still hashes
 *  to what was posted, and 'sealed' says a reader may rely on it. They are the
 *  same fact today, and keeping one name for both would quietly make this
 *  object's guarantee a restatement of an implementation detail. One mapping,
 *  here, so no call site invents its own. */
export function bindingFromBriefVerdict(verdict: 'match' | 'mismatch' | 'unverifiable'): BindingState {
  return verdict === 'match' ? 'sealed' : verdict
}

/** What the worker owes. */
export type ContractTask = {
  title: Attested<string>
  description: Attested<string | null>
  /** Present only when the row kept its nonce; without it the seal cannot be
   *  recomputed, which is why `binding` can be 'unverifiable'. */
  reproducible: Attested<boolean>
}

export type ContractDeliverable = {
  kind: Attested<string>
  requiredCapabilities: Attested<string[]>
}

/**
 * How "done" is decided.
 *
 * The criteria are sealed; the verdict is not. A grader that could rewrite
 * the criteria it grades against would be marking its own homework, which is
 * why those two live at different provenances and always will.
 */
export type ContractVerification = {
  criteria: Attested<string | null>
  /** Requester-authored asserts, when the job is code-graded. Sealed, so a
   *  worker can check the tests it will be judged by before accepting. */
  hasTestCode: Attested<boolean>
  testSuiteSlug: Attested<string | null>
  /** deterministic | model | peer | human — see lib/grader-class.ts. */
  graderClass: Attested<GraderClass | null>
  verdict: Attested<'passed' | 'failed' | 'ungraded'>
  /** A refusal and an incapacity are recorded against different parties, so
   *  they are not collapsed into `failed` here either (see §24/§25 of
   *  docs/failure-modes.md). */
  outcome: Attested<'graded' | 'brief-refused' | 'worker-incapable' | 'pending'>
  appealed: Attested<boolean>
}

/** Who may say yes, and what happens if nobody does. */
export type ContractAcceptance = {
  autoRelease: Attested<boolean>
  /** Seconds from now until the deadline that currently governs, or null when
   *  the job is in a state no deadline is running against. */
  deadlineInSec: Attested<number | null>
  /** What settles the escrow if the review window simply expires. This is the
   *  clause counterparties most often assume and least often check. */
  onSilence: Attested<'refund-most-to-requester' | 'unknown'>
}

export type ContractParty = {
  role: 'requester' | 'worker' | 'payee'
  address: Attested<string | null>
  agentId: Attested<string | null>
  /** Fraction of the settled bounty, for a payee. */
  shareUsd?: Attested<number>
}

export type ContractSettlement = {
  rail: Attested<string>
  currency: Attested<string>
  bountyUsd: Attested<number>
  /** Staked by the worker on accept, returned on settlement. */
  bondUsd: Attested<number | null>
  feeUsd: Attested<number | null>
  state: Attested<string>
  parties: ContractParty[]
}

export type AgentContract = {
  protocol: typeof AGENT_CONTRACT_PROTOCOL
  version: typeof AGENT_CONTRACT_VERSION
  /** The specHash. Already the on-chain commitment — this object does not
   *  introduce an identifier of its own, because a second id is a second
   *  thing to disagree about. */
  id: string
  binding: BindingState
  onchain: { jobId: number | null; contract: string | null; chainId: number | null }
  task: ContractTask
  deliverable: ContractDeliverable
  verification: ContractVerification
  acceptance: ContractAcceptance
  settlement: ContractSettlement
}

/** The row shape this projects from — structural, so the projection is pure
 *  and testable without drizzle or a database. */
export type ContractSourceSpec = {
  specHash: string
  title: string
  description: string | null
  acceptanceCriteria: string | null
  testCode: string | null
  testSuiteSlug: string | null
  deliverableKind: string | null
  requiredCapabilities: string[] | null
  briefNonce: string | null
  requesterAgentId: string | null
  workerAgentId: string | null
  onchainJobId: number | null
  onchainContract: string | null
  autoApprove: boolean
  testResult: {
    passed: boolean | null
    refusedBrief?: boolean
    workerIncapable?: boolean
    appeal?: unknown
  } | null
  splitSpec: unknown
}

export type ContractSourceJob = {
  id: number
  requester: string
  worker: string
  bounty: number
  status: string
  /** Seconds since epoch for whichever deadline governs the current status. */
  deadline: number | null
}

/**
 * Build the contract for one job.
 *
 * Pure. `job` is optional because a spec exists before it is posted and a
 * contract should be readable then too — that is precisely when a
 * counterparty most wants to read one. Without it every chain-provenance
 * field reports what it is: unknown, not zero.
 */
export function toAgentContract(input: {
  spec: ContractSourceSpec
  job?: ContractSourceJob | null
  binding: BindingState
  chainId?: number | null
  bondUsd?: number | null
  feeUsd?: number | null
  graderClass?: GraderClass | null
  nowSec?: number
}): AgentContract {
  const { spec, job, binding } = input
  const result = spec.testResult

  const verdict: 'passed' | 'failed' | 'ungraded' =
    result?.passed === true ? 'passed' : result?.passed === false ? 'failed' : 'ungraded'

  // A refusal and an incapacity are claims about DIFFERENT parties: a refused
  // brief goes on record against the requester, work nobody could do goes back
  // to the market. Flattening either into "failed" writes a verdict about the
  // worker that nobody reached.
  const outcome: ContractVerification['outcome']['value'] = result?.refusedBrief
    ? 'brief-refused'
    : result?.workerIncapable
      ? 'worker-incapable'
      : result?.passed === null || result == null
        ? 'pending'
        : 'graded'

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000)

  const parties: ContractParty[] = [
    {
      role: 'requester',
      address: job ? chain(job.requester) : platform(null),
      // Sealed: `agent` is one of the nine fields inside the specHash, so WHO
      // commissioned this work is part of what was committed — unlike the
      // worker, who is not known when the brief is sealed. Getting this wrong
      // in the first draft is what the drift test below now prevents.
      agentId: sealed(spec.requesterAgentId),
    },
    {
      role: 'worker',
      // The chain is the authority on who the worker is; the row is a mirror
      // that has been wrong before.
      address: job ? chain(job.worker) : platform(null),
      agentId: platform(spec.workerAgentId),
    },
    ...payeesOf(spec.splitSpec),
  ]

  return {
    protocol: AGENT_CONTRACT_PROTOCOL,
    version: AGENT_CONTRACT_VERSION,
    id: spec.specHash,
    binding,
    onchain: {
      jobId: spec.onchainJobId ?? job?.id ?? null,
      contract: spec.onchainContract ?? null,
      chainId: input.chainId ?? null,
    },
    task: {
      title: sealed(spec.title),
      description: sealed(spec.description),
      // Not "was it tampered with" — that is `binding`. This says whether the
      // question can be asked at all, which for rows predating briefNonce it
      // cannot.
      reproducible: platform(spec.briefNonce !== null),
    },
    deliverable: {
      kind: sealed(spec.deliverableKind ?? 'text'),
      requiredCapabilities: sealed(spec.requiredCapabilities ?? []),
    },
    verification: {
      criteria: sealed(spec.acceptanceCriteria),
      hasTestCode: sealed(spec.testCode !== null && spec.testCode !== ''),
      testSuiteSlug: sealed(spec.testSuiteSlug),
      graderClass: platform(input.graderClass ?? null),
      verdict: platform(verdict),
      outcome: platform(outcome),
      appealed: platform(result?.appeal !== undefined),
    },
    acceptance: {
      autoRelease: platform(spec.autoApprove),
      deadlineInSec: job?.deadline == null ? chain(null) : chain(Math.max(0, job.deadline - nowSec)),
      // Stated rather than left to be discovered: on V2 a review window that
      // simply expires returns most of the escrow to the requester and leaves
      // the worker a silence forfeit. Counterparties assume this clause and
      // almost never read it.
      onSilence: chain(job ? 'refund-most-to-requester' : 'unknown'),
    },
    settlement: {
      rail: platform(spec.onchainContract ? 'evm-labor-market-v2' : 'unposted'),
      currency: platform('USDC'),
      bountyUsd: job ? chain(job.bounty) : platform(0),
      bondUsd: input.bondUsd === undefined ? platform(null) : platform(input.bondUsd),
      feeUsd: input.feeUsd === undefined ? platform(null) : platform(input.feeUsd),
      state: job ? chain(job.status) : platform('unposted'),
      parties,
    },
  }
}

/** Payees named by a settlement split, if the spec carries one. Defensive
 *  about the shape: splitSpec is jsonb written by several code paths over
 *  time, and a contract that throws on an old row is a contract nobody can
 *  read for exactly the jobs most worth auditing. */
function payeesOf(splitSpec: unknown): ContractParty[] {
  if (!splitSpec || typeof splitSpec !== 'object') return []
  const raw = (splitSpec as { payees?: unknown }).payees
  if (!Array.isArray(raw)) return []
  const out: ContractParty[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { agentId?: unknown; address?: unknown; amountUsd?: unknown }
    out.push({
      role: 'payee',
      address: platform(typeof e.address === 'string' ? e.address : null),
      agentId: platform(typeof e.agentId === 'string' ? e.agentId : null),
      shareUsd: platform(typeof e.amountUsd === 'number' ? e.amountUsd : 0),
    })
  }
  return out
}

/** Everything a counterparty may rely on without trusting this platform.
 *  The whole reason provenance is on every leaf. */
export function bindingClaims(contract: AgentContract): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const walk = (prefix: string, node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if ('from' in node && 'value' in node) {
      if ((node as Attested<unknown>).from === 'sealed') out[prefix] = (node as Attested<unknown>).value
      return
    }
    for (const [k, v] of Object.entries(node)) walk(prefix ? `${prefix}.${k}` : k, v)
  }
  walk('', contract)
  return out
}
