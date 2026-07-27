/**
 * Reputation-gated limits — borrowed from the EAS "Reputation Lending" lab.
 *
 * The lab's core lesson: a lending decision must not trust "what was said" but
 * "WHO said it". A credit-score attestation carries a `subject` (who it is
 * about) and is signed by an `attester`. A borrower must not be able to forge
 * "my score = 999" for themselves, so the resolver enforces four gates:
 *
 *   ① look the score proof up            (we receive it directly, EIP-712 signed)
 *   ② attester == TRUSTED_SCORER         ★ blocks self-attestation
 *   ③ not stale & subject == borrower
 *   ④ score >= minScore
 *
 * Applied to Handsel: an agent's credit score (already attested by the
 * platform oracle) unlocks an undercollateralized draw / auto-approve limit
 * that scales with the score — read-only condition checks, no funds move here.
 */
import { recoverTypedDataAddress, type Hex, type Account } from 'viem'
import { CHAIN } from '@/lib/onchain/config'
import { oracleAccount } from '@/lib/onchain/clients'

export interface CreditScoreProof {
  subject: string // agentId or smart-account address the score is ABOUT
  score: number
  issuedAt: number // unix seconds
}

const DOMAIN = { name: 'Handsel', version: '1', chainId: CHAIN.id } as const
const TYPES = {
  CreditScore: [
    { name: 'subject', type: 'string' },
    { name: 'score', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const
const toMessage = (p: CreditScoreProof) => ({ subject: p.subject, score: BigInt(p.score), issuedAt: BigInt(p.issuedAt) })

/** The only attester a lending decision trusts — the platform oracle. */
export function trustedScorer(): `0x${string}` | null {
  try {
    return oracleAccount().address
  } catch {
    return null
  }
}

/** Oracle signs a credit-score proof (EIP-712). `account` injectable for tests. */
export async function signCreditScore(proof: CreditScoreProof, account?: Account): Promise<{ signature: Hex; attester: `0x${string}` } | null> {
  let signer: Account
  try {
    signer = account ?? oracleAccount()
  } catch {
    return null
  }
  if (!signer.signTypedData) return null
  const signature = await signer.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'CreditScore', message: toMessage(proof) })
  return { signature, attester: signer.address }
}

export interface ReputationTerms {
  minScore: number
  baseLimitUsd: number // headroom granted at exactly minScore
  perPointUsd: number // extra headroom per point above minScore
  maxLimitUsd: number
  maxAgeSec: number // a score older than this is stale
}

export const DEFAULT_TERMS: ReputationTerms = {
  minScore: 600,
  baseLimitUsd: 5,
  perPointUsd: 0.2,
  maxLimitUsd: 100,
  maxAgeSec: 30 * 24 * 60 * 60,
}

export interface ReputationDecision {
  approved: boolean
  limitUsd: number
  reasons: string[]
  checks: { signatureValid: boolean; attesterTrusted: boolean; subjectMatches: boolean; fresh: boolean; scoreOk: boolean; withinLimit: boolean }
}

/**
 * Evaluate the four gates and derive the reputation-based limit. Pure w.r.t.
 * inputs (no chain, no DB) so it is fully unit-testable.
 */
export async function evaluateReputation(input: {
  proof: CreditScoreProof
  signature: Hex
  borrower: string
  requestUsd?: number
  terms?: ReputationTerms
  expectedScorer?: `0x${string}`
  now?: number
}): Promise<ReputationDecision> {
  const terms = input.terms ?? DEFAULT_TERMS
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const reasons: string[] = []

  // ① recover signer from the EIP-712 proof
  const recovered = await recoverTypedDataAddress({
    domain: DOMAIN,
    types: TYPES,
    primaryType: 'CreditScore',
    message: toMessage(input.proof),
    signature: input.signature,
  })
  const signatureValid = true // recovery succeeded

  // ② attester == TRUSTED_SCORER  (self-attestation defense)
  const scorer = (input.expectedScorer ?? trustedScorer())?.toLowerCase()
  const attesterTrusted = !!scorer && recovered.toLowerCase() === scorer
  if (!attesterTrusted) reasons.push('score not signed by the trusted scorer (self-attestation blocked)')

  // ③ subject == borrower && not stale
  const subjectMatches = input.proof.subject.toLowerCase() === input.borrower.toLowerCase()
  if (!subjectMatches) reasons.push('score is about a different subject than the borrower')
  const fresh = now - input.proof.issuedAt <= terms.maxAgeSec
  if (!fresh) reasons.push('score is stale')

  // ④ score >= minScore
  const scoreOk = input.proof.score >= terms.minScore
  if (!scoreOk) reasons.push(`score ${input.proof.score} below minimum ${terms.minScore}`)

  const limitUsd =
    attesterTrusted && subjectMatches && fresh && scoreOk
      ? Math.min(terms.maxLimitUsd, Math.max(0, terms.baseLimitUsd + (input.proof.score - terms.minScore) * terms.perPointUsd))
      : 0
  const roundedLimit = Math.round(limitUsd * 100) / 100

  const withinLimit = input.requestUsd == null || input.requestUsd <= roundedLimit
  if (!withinLimit) reasons.push(`requested $${input.requestUsd} exceeds limit $${roundedLimit}`)

  const approved = attesterTrusted && subjectMatches && fresh && scoreOk && withinLimit
  return {
    approved,
    limitUsd: roundedLimit,
    reasons,
    checks: { signatureValid, attesterTrusted, subjectMatches, fresh, scoreOk, withinLimit },
  }
}

/**
 * Server-side reputation quote: the platform IS the trusted scorer, so it
 * signs a fresh score proof for the subject and runs it through the SAME four
 * gates as the public endpoint (one code path, no bypass). Returns the
 * reputation-derived limit in USD — 0 when the oracle key is unavailable or
 * any gate fails.
 */
export async function quoteReputationLimit(subject: string, score: number, terms?: ReputationTerms): Promise<number> {
  try {
    const proof: CreditScoreProof = { subject, score: Math.floor(score), issuedAt: Math.floor(Date.now() / 1000) }
    const signed = await signCreditScore(proof)
    if (!signed) return 0
    const decision = await evaluateReputation({ proof, signature: signed.signature, borrower: subject, terms })
    return decision.limitUsd
  } catch {
    return 0
  }
}
