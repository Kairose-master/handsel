/**
 * ExternalEvaluatorBridge — route a Bounty-mode deliverable to Handsel's
 * independent grader and get back its real, signed, publicly verifiable verdict.
 *
 * This replaces the placeholder in daydreamsai/skills-market#58. Two things that
 * draft did that this does not:
 *
 *  1. It hardcoded `https://handsel.dev`, a domain that does not resolve and is
 *     not Handsel's. The real base is `https://handsel-main.vercel.app`
 *     (Base mainnet, real USDC) or `https://handsel-nu.vercel.app`
 *     (Base Sepolia, zero value — use this to try it).
 *  2. It returned `{ passed: true }` without calling anything. An evaluator that
 *     can only return "pass" is a check that cannot fail. This one returns the
 *     grader's actual verdict, including `false` and `null`, and never
 *     fabricates a result.
 *
 * HONEST SCOPE — read before you trust the word "recomputable" anywhere near it.
 * `/api/grade` today is Handsel's LLM-REVIEW lane: a model reads the deliverable
 * against the spec, billed to the caller's own key, and it is never the agent
 * that produced the work (grader != solver). That makes it an *independent*
 * opinion — but an opinion, not a recomputation. Every verdict is labelled
 * `lane: 'model'` for exactly that reason. The genuinely recomputable lane
 * (CI / test suites / canary fingerprints, where a third party re-runs the check
 * and gets the same answer) runs caller-supplied code and is therefore a
 * separate, security-gated endpoint that is not yet exposed (`docs/external-grading.md`).
 * Do NOT present a verdict from this bridge as recomputable.
 */

export interface EvaluationResult {
  /** true | false | null. `null` means grading was unavailable — treat it as
   *  NOT graded, never as a pass. */
  passed: boolean | null
  /** 1 on pass, 0 on fail, null when ungraded. */
  score: number | null
  /** The grader's stated reason. */
  reason: string
  /** Which grading lane produced this. Currently always 'model' (LLM review);
   *  a future 'recomputable' lane will re-run a mechanical check. */
  lane: 'model'
  /** Signed, publicly verifiable work proof — present only on a pass. Anyone
   *  can fetch it; it attests provenance (this deliverable was graded and passed
   *  at this time), which for the model lane is provenance, not recomputability. */
  proofUrl?: string
  gradedAt: string
}

export interface BridgeOptions {
  /** Handsel base URL. Defaults to Base mainnet (real money). Pass
   *  `https://handsel-nu.vercel.app` for the zero-value Base Sepolia deployment. */
  baseUrl?: string
  /** Handsel OAuth bearer or personal token (from /api/oauth/personal-token).
   *  Required — the endpoint is fail-closed: no token, no grade. */
  token: string
  /** Injectable for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export class ExternalEvaluatorBridge {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: BridgeOptions) {
    if (!opts || !opts.token) {
      throw new Error('ExternalEvaluatorBridge: a Handsel token is required (no token, no grade)')
    }
    this.baseUrl = (opts.baseUrl ?? 'https://handsel-main.vercel.app').replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * Grade `deliverable` against `spec` (the task's acceptance criteria).
   * Returns the grader's real verdict. Throws only on transport/auth errors —
   * a `false` or `null` verdict is a normal return, not an exception.
   */
  async evaluate(input: { deliverable: string; spec: string; label?: string }): Promise<EvaluationResult> {
    if (!input?.deliverable?.trim()) throw new Error('ExternalEvaluatorBridge: deliverable is required')
    if (!input?.spec?.trim()) throw new Error('ExternalEvaluatorBridge: spec (acceptance criteria) is required')

    const res = await this.fetchImpl(`${this.baseUrl}/api/grade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        deliverable: input.deliverable,
        spec: input.spec,
        label: input.label ?? 'TaskMarket bounty evaluation',
      }),
    })

    if (res.status === 401) throw new Error('ExternalEvaluatorBridge: token rejected (401)')
    if (res.status === 429) throw new Error('ExternalEvaluatorBridge: rate limited (429) — retry later')
    if (!res.ok) throw new Error(`ExternalEvaluatorBridge: grade failed (HTTP ${res.status})`)

    const body = (await res.json()) as {
      passed?: boolean | null
      reason?: string
      gradedAt?: string
      proof?: { url?: string }
    }

    // The grader's verdict, verbatim. `passed` is deliberately not coerced to a
    // boolean: `null` (ungraded) must survive as null, not collapse to false.
    const passed = body.passed === true ? true : body.passed === false ? false : null

    return {
      passed,
      score: passed === true ? 1 : passed === false ? 0 : null,
      reason: body.reason ?? '',
      lane: 'model',
      proofUrl: body.proof?.url,
      gradedAt: body.gradedAt ?? new Date().toISOString(),
    }
  }
}
