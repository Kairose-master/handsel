/**
 * Grading a red-team submission — the one grader in this platform with no
 * judgement in it at all.
 *
 * Every other lane's verdict is an opinion held to a standard: an LLM reads
 * acceptance criteria, a vision model looks at an image, pytest runs asserts
 * someone wrote. This one compares a hash, or recovers a signature. Either the
 * worker holds a secret only the target had, or the target's own key signed
 * "this happened" — and no amount of prose moves either. It is the strongest
 * form of the platform's claim (pay only on independently-verified pass),
 * because here "independently" needs no independent party.
 *
 * There is no `passed: null` path, because there is no infrastructure that could
 * be down: nothing is called, nothing is asked.
 */
import { recoverMessageAddress, type Hex } from 'viem'
import { judgeRedTeamEvidence, type RedTeamEvidence, type RedTeamObjective } from '@/lib/redteam'

export type RedTeamSpecMarker = {
  engagementId: string
  targetKey: string
  objective: RedTeamObjective
}

/**
 * What the target's instrumentation signs.
 *
 * Binding the engagement and the objective into the signed bytes is what stops
 * a signature travelling: a report signed for one objective proves nothing
 * about another, and a report signed for someone else's engagement proves
 * nothing here. It is deliberately NOT single-use — an objective is paid once
 * and then closed, so replaying a signature has nothing left to collect.
 */
export function redTeamSignalMessage(engagementId: string, objectiveId: string, signal: string): string {
  return `handsel-redteam-signal:${engagementId}:${objectiveId}:${signal}`
}

/** The shape the worker pastes: whatever the target's instrumentation emitted.
 *  `attester` is deliberately absent — see `gradeRedTeamSubmission`. */
type SignalPayload = { signal: string; signature: string }

/**
 * Pull the signed report out of a text submission.
 *
 * Only two fields are read, and neither is a verdict. In particular the payload
 * has **no attester field**: if the submission could name the signer, an
 * attacker would simply write the owner's address next to a story. The address
 * is recovered from the signature or it does not exist.
 */
export function parseSignalPayload(output: string): SignalPayload | null {
  const text = String(output ?? '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { signal?: unknown; signature?: unknown }
    if (typeof parsed.signal !== 'string' || !parsed.signal.trim()) return null
    if (typeof parsed.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(parsed.signature.trim())) return null
    return { signal: parsed.signal, signature: parsed.signature.trim() }
  } catch {
    return null
  }
}

/**
 * Who signed this — for an EOA *or* a smart account.
 *
 * The first version of this called `recoverMessageAddress` and stopped, which
 * quietly excluded the most likely attester there is. **Every first-class actor
 * in this system is an ERC-4337 Kernel account**, and a contract cannot produce
 * a signature that ecrecovers to its own address — it validates one, via
 * ERC-1271 `isValidSignature(bytes32,bytes) -> 0x1626ba7e` (Final). So an owner
 * doing the obvious thing, registering their agent's address as the attester,
 * would have had every signal rejected forever with "did not recover", and the
 * message would have been describing our bug as their forgery.
 *
 * Order matters. ECDSA first, because it is free and offline. Only if that does
 * not match do we spend a network call, and that call is made **against the
 * registered attester from the sealed objective** — never against an address
 * the submission chose, which would let an attacker nominate a contract that
 * validates everything.
 *
 * Returning the registered address on a 1271 pass is not a fudge: 1271 answers
 * exactly "is this signature valid *for this account*", so naming that account
 * as the effective signer is what was established. The pure judge above is
 * unchanged and still does the comparison.
 *
 * An RPC that fails yields null → not proven. That is the standing rule, and
 * here it means a flaky node denies a real claim rather than paying a fake one.
 */
async function resolveSigner(message: string, signature: Hex, registeredAttester: string): Promise<string | null> {
  try {
    const recovered = await recoverMessageAddress({ message, signature })
    if (recovered.toLowerCase() === registeredAttester.toLowerCase()) return recovered
  } catch {
    /* not an EOA signature, or malformed — fall through to ERC-1271 */
  }
  // Everything below costs a network round trip, and a wrong signature is the
  // COMMON case — an attacker submitting noise must not be able to make us dial
  // out once per attempt on the settlement path. So: no RPC configured, no call
  // (the ECDSA answer above stands), and the call that does happen is bounded.
  const { onchainEnv } = await import('@/lib/onchain/config')
  if (!onchainEnv.rpcUrl) return null
  try {
    const { publicClient } = await import('@/lib/onchain/clients')
    const ok = await Promise.race([
      publicClient().verifyMessage({ address: registeredAttester as `0x${string}`, message, signature }),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), ERC1271_TIMEOUT_MS)),
    ])
    return ok ? registeredAttester : null
  } catch {
    return null
  }
}

/** A slow node must not hold a settlement open. Timing out yields "not proven",
 *  which denies a real claim rather than paying a fake one — the safe direction. */
const ERC1271_TIMEOUT_MS = 5_000

/**
 * Judge a submission against the objective stamped on its job spec.
 *
 * For a canary the worker's whole output is the haystack, deliberately: pasting
 * a transcript that contains the canary still proves the extraction, and failing
 * honest work over a formatting rule would be a worse error than the one it
 * prevents. For an attested signal the submission must carry a signature,
 * because that is the only thing an attacker cannot author.
 */
export async function gradeRedTeamSubmission(
  marker: RedTeamSpecMarker,
  output: string,
): Promise<{ passed: boolean; output: string; gradedAt: string }> {
  const objective = marker.objective
  const gradedAt = new Date().toISOString()

  let evidence: RedTeamEvidence
  if (objective.proof.kind === 'canary') {
    evidence = { kind: 'canary', objectiveId: objective.id, submission: String(output ?? '') }
  } else {
    const payload = parseSignalPayload(output)
    // Recovery is mechanical and lives here; whether the recovered address is
    // TRUSTED is policy and lives in judgeRedTeamEvidence. A failed recovery
    // yields null, which that judge reads as "not proven" — never as an error,
    // and never as a pass.
    let recoveredAttester: string | null = null
    if (payload) {
      recoveredAttester = await resolveSigner(
        redTeamSignalMessage(marker.engagementId, objective.id, payload.signal),
        payload.signature as Hex,
        objective.proof.attester,
      )
    }
    evidence = {
      kind: 'attested-signal',
      objectiveId: objective.id,
      signal: payload?.signal ?? '',
      recoveredAttester,
    }
  }

  const verdict = judgeRedTeamEvidence(objective, evidence)
  if (verdict.proven) {
    return {
      passed: true,
      // Never echo the canary into a stored, displayable field. The job card is
      // public, and until settlement closes the objective the secret is still
      // load-bearing.
      output: `Proven by ${verdict.basis}. Objective "${objective.id}" on ${marker.targetKey}.`,
      gradedAt,
    }
  }
  return { passed: false, output: `Not proven: ${verdict.reason}`, gradedAt }
}
