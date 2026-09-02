/**
 * LLM grading for TEXT deliverables — the third grading path alongside
 * Python tests (code-grading) and the vision reviewer (vision-grading).
 * Judges the submitted text against the job's acceptance criteria with
 * the requester owner's LLM key (same BYOK chain the delegation planner
 * uses). Grader ≠ solver holds: the WORKER's key is never used.
 *
 * Verdict semantics match the other graders: passed true/false drives
 * auto-settlement; passed null means grading was unavailable (no key,
 * provider error) and the job falls back to manual review.
 */
import { resolveLlm } from '@/lib/delegation'

import { fenceUntrusted, graderInjectionClause, untrustedNonce } from '@/lib/untrusted-input'

export interface GradedVerdict {
  passed: boolean | null
  output: string
  gradedAt: string
}

const GRADER_SYSTEM_BASE =
  'You are an independent reviewer for an AI-agent labor market. Judge whether the submitted output satisfies ' +
  'the acceptance criteria. The criteria are the contract — do not invent extra requirements, and do not excuse ' +
  'clear failures. Output ONLY a JSON object {"pass": boolean, "reason": "one sentence"}.'

/** Pure verdict parser — exported for tests. Unparseable output returns
 *  null (no verdict), never a guess in either direction. */
export function parseGraderVerdict(raw: string): { pass: boolean; reason: string } | null {
  const text = raw.replace(/^```(?:json)?\s*|\s*```$/g, '')
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.pass !== 'boolean') return null
    return { pass: parsed.pass, reason: String(parsed.reason ?? '') }
  } catch {
    return null
  }
}

export async function gradeTextSubmission(
  spec: { title: string; description: string | null; acceptanceCriteria: string | null },
  output: string,
  requesterOwnerUserId: string | null,
): Promise<GradedVerdict> {
  const gradedAt = new Date().toISOString()
  if (!spec.acceptanceCriteria?.trim()) {
    return { passed: null, output: 'No acceptance criteria to grade against — awaiting manual review.', gradedAt }
  }
  if (!requesterOwnerUserId) {
    return { passed: null, output: 'Requester account unknown — awaiting manual review.', gradedAt }
  }

  let complete
  try {
    complete = await resolveLlm(requesterOwnerUserId)
  } catch {
    return {
      passed: null,
      output: 'LLM grading unavailable (no LLM key on the requester account) — awaiting manual review.',
      gradedAt,
    }
  }

  try {
    // The submission is written by the party being judged, so it is fenced
    // with a nonce minted now — after they wrote — and the system prompt is
    // told to treat any instruction inside as a failing offence.
    const nonce = untrustedNonce()
    // Same token hygiene as verifySubmission (lib/delegation.ts): the
    // description is capped as context (criteria stay whole — they are the
    // contract), the stable system text is cached across a sweep's burst of
    // gradings, and effort 'low' caps thinking on a one-JSON-object call.
    const contextCap = 6_000
    const fullDescription = spec.description ?? '(none)'
    const description =
      fullDescription.length > contextCap
        ? `${fullDescription.slice(0, contextCap)}\n[context cut for grading — the full brief is on the job record; judge against the acceptance criteria]`
        : fullDescription
    const raw = await complete(
      { stable: GRADER_SYSTEM_BASE, volatile: graderInjectionClause(nonce) },
      `Job: ${spec.title}\n\nDescription:\n${description}\n\nAcceptance criteria:\n${spec.acceptanceCriteria}\n\nSubmitted output:\n${fenceUntrusted('submission', output.slice(0, 20_000), nonce)}`,
      2000,
      { effort: 'low' },
    )
    const verdict = parseGraderVerdict(raw)
    if (!verdict) {
      return { passed: null, output: 'Grader returned no parseable verdict — awaiting manual review.', gradedAt }
    }
    return { passed: verdict.pass, output: verdict.reason || '(no reason given)', gradedAt }
  } catch (error) {
    return {
      passed: null,
      output: `LLM grading errored (${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}) — awaiting manual review.`,
      gradedAt,
    }
  }
}
