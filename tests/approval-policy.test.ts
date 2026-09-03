/**
 * The approval policy engine. Both failure directions: an engine that lets a
 * policy relax a hard rule pays for a deploy nobody approved; one that
 * escalates everything makes "automatic" a word on a page. Every hard rule,
 * every outcome and the money gate have a case here.
 */
import { describe, expect, it } from 'vitest'
import {
  CONDITION_FIELDS,
  DEFAULT_APPROVAL_POLICY,
  POLICY_PRESETS,
  PRESET_BLURBS,
  PRESET_POLICIES,
  conditionHolds,
  evaluateApproval,
  fileFlags,
  grantCeiling,
  moneyGate,
  parsePolicy,
  policyInWords,
  presetOf,
  receiptText,
  renderPolicy,
  riskTierFor,
  type ApprovalContext,
  type ApprovalPolicy,
} from '@/lib/approval-policy'

const ctx = (over: Partial<ApprovalContext> = {}): ApprovalContext => ({
  officeId: 'u1/1',
  sessionId: 'ses-1',
  taskId: 't1',
  amountUsd: 1,
  riskTier: 'E2',
  changedFiles: ['lib/a.ts', 'tests/a.test.ts', 'README.md'],
  testsPassed: true,
  ciPassed: true,
  reviewerVerdict: 'APPROVE',
  workerCredit: 40,
  budgetRemainingUsd: 9,
  dailySpentUsd: 0,
  productionImpact: false,
  secretModified: false,
  newDependency: false,
  reviewerDisagreement: false,
  workspaceEscape: false,
  settlement: 'escrow',
  ...over,
})

describe('scenario C — the small task the spec says must be automatic', () => {
  it('$1, 3 files, CI passed, no secret, reviewer APPROVE → ALLOW_WITH_LOG with the evidence on the receipt', () => {
    const d = evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx())
    expect(d.outcome).toBe('ALLOW_WITH_LOG')
    expect(d.policyId).toBe('default')
    expect(d.evidence.changedFileCount).toBe(3)
    expect(d.reasons.every((r) => r.startsWith('holds:'))).toBe(true)
    expect(receiptText(d)).toContain('ALLOW_WITH_LOG under policy default v1')
  })

  it('a free, read-only task is a plain ALLOW', () => {
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ amountUsd: 0, riskTier: 'E0', changedFiles: [] })).outcome).toBe('ALLOW')
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ amountUsd: 0, riskTier: 'E1' })).outcome).toBe('ALLOW')
  })
})

describe('scenario D — the high-risk task the spec says must wait for a person', () => {
  it('production impact → REQUIRE_OWNER even when everything else is green', () => {
    const d = evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ productionImpact: true }))
    expect(d.outcome).toBe('REQUIRE_OWNER')
    expect(d.reasons[0]).toMatch(/production/)
  })

  it('risk tier E4 is never automatic, whatever the policy says', () => {
    const loose: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, autoApprove: [], requireOwner: [], requireReviewer: [] }
    expect(evaluateApproval(loose, ctx({ riskTier: 'E4' })).outcome).toBe('REQUIRE_OWNER')
  })

  it('a modified secret → owner; over the single-task limit → owner', () => {
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ secretModified: true })).outcome).toBe('REQUIRE_OWNER')
    // $2.50 trips the OWNER'S rule (amountUsd > 2); $3.50 trips the HARD limit ($3) before any rule is read.
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ amountUsd: 2.5 })).matched[0].rule).toBe('requireOwner')
    const d = evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ amountUsd: 3.5 }))
    expect(d.outcome).toBe('REQUIRE_OWNER')
    expect(d.matched[0].rule).toBe('hard')
    expect(d.reasons[0]).toMatch(/over the single-task limit/)
  })

  it('a new dependency or reviewer disagreement → owner (policy rule, not hard)', () => {
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ newDependency: true })).matched[0].rule).toBe('requireOwner')
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ reviewerDisagreement: true })).outcome).toBe('REQUIRE_OWNER')
  })
})

describe('hard denials', () => {
  it('a workspace escape is denied before anything else is read', () => {
    const d = evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ workspaceEscape: true, amountUsd: 0, riskTier: 'E0' }))
    expect(d.outcome).toBe('DENY')
    expect(d.reasons[0]).toMatch(/outside its granted workspace/)
  })

  it('budget exhaustion: over the remaining session budget or the daily budget is a DENY', () => {
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ amountUsd: 1, budgetRemainingUsd: 0.5 })).outcome).toBe('DENY')
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ amountUsd: 1, dailySpentUsd: 19.5 })).outcome).toBe('DENY')
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ amountUsd: 0, dailySpentUsd: 25 })).outcome).not.toBe('DENY')
  })

  it('failed tests or failed CI deny; a MISSING test report does not deny but is not automatic', () => {
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ testsPassed: false })).outcome).toBe('DENY')
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ ciPassed: false })).outcome).toBe('DENY')
    const noTests = evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ testsPassed: null, ciPassed: null }))
    // `testsPassed != false` holds for null under the default policy, so the
    // default is deliberately lenient on "no tests ran" when a reviewer approved.
    expect(noTests.outcome).toBe('ALLOW_WITH_LOG')
    const strict: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, autoApprove: [{ field: 'testsPassed', op: '==', value: true }] }
    const d = evaluateApproval(strict, ctx({ testsPassed: null }))
    expect(d.outcome).toBe('REQUIRE_OWNER')
    expect(d.reasons[0]).toMatch(/no reading/)
  })

  it('a bad amount is denied', () => {
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ amountUsd: -1 })).outcome).toBe('DENY')
    expect(evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ amountUsd: Number.NaN })).outcome).toBe('DENY')
  })
})

describe('reviewer gating and unknown evidence', () => {
  it('no reviewer verdict yet → REQUIRE_REVIEWER under the default policy', () => {
    const d = evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ reviewerVerdict: null }))
    expect(d.outcome).toBe('REQUIRE_REVIEWER')
  })

  it('a REVISE verdict is not automatic → owner', () => {
    const d = evaluateApproval(DEFAULT_APPROVAL_POLICY, ctx({ reviewerVerdict: 'REVISE' }))
    expect(d.outcome).toBe('REQUIRE_OWNER')
    expect(d.reasons.join(' ')).toMatch(/reviewerVerdict == APPROVE does not hold/)
  })

  it('a null field never satisfies an ordering; only == null does', () => {
    const ev = { workerCredit: null, amountUsd: 1 }
    expect(conditionHolds({ field: 'workerCredit', op: '>=', value: 0 }, ev)).toBe(false)
    expect(conditionHolds({ field: 'workerCredit', op: '==', value: null }, ev)).toBe(true)
    expect(conditionHolds({ field: 'workerCredit', op: '!=', value: 5 }, ev)).toBe(true)
    expect(conditionHolds({ field: 'amountUsd', op: 'in', value: [1, 2] }, ev)).toBe(true)
    expect(conditionHolds({ field: 'riskTier', op: '<=', value: 'E2' }, { riskTier: 'E3' })).toBe(false)
    expect(conditionHolds({ field: 'riskTier', op: '<=', value: 'E2' }, { riskTier: 'E1' })).toBe(true)
  })

  it('a policy deny rule wins over an otherwise automatic task', () => {
    const p: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, deny: [{ field: 'changedFileCount', op: '>', value: 2 }] }
    expect(evaluateApproval(p, ctx()).outcome).toBe('DENY')
  })
})

describe('risk tiers and file classes', () => {
  it('climbs the ladder by the strongest action', () => {
    const base = { changedFiles: [], deletedFiles: [], shellUsed: false, networkUsed: false, installed: false, gitPushed: false, moneyMoves: false, deployed: false }
    expect(riskTierFor(base)).toBe('E0')
    expect(riskTierFor({ ...base, changedFiles: ['a.ts'] })).toBe('E1')
    expect(riskTierFor({ ...base, changedFiles: ['a.ts'], shellUsed: true })).toBe('E2')
    expect(riskTierFor({ ...base, networkUsed: true })).toBe('E3')
    expect(riskTierFor({ ...base, changedFiles: ['package.json'] })).toBe('E3')
    expect(riskTierFor({ ...base, changedFiles: ['vercel.json'] })).toBe('E4')
    expect(riskTierFor({ ...base, changedFiles: ['.github/workflows/ci.yml'] })).toBe('E4')
    expect(riskTierFor({ ...base, moneyMoves: true })).toBe('E4')
    expect(riskTierFor({ ...base, deletedFiles: ['.env'] })).toBe('E4')
    expect(riskTierFor({ ...base, deletedFiles: ['lib/old.ts'] })).toBe('E1')
  })

  it('classifies secret, production and dependency paths', () => {
    expect(fileFlags(['.env.local', 'lib/a.ts'])).toEqual({ secretModified: true, productionImpact: false, newDependency: false })
    expect(fileFlags(['infra/main.tf'])).toEqual({ secretModified: false, productionImpact: true, newDependency: false })
    expect(fileFlags(['pnpm-lock.yaml'])).toEqual({ secretModified: false, productionImpact: false, newDependency: true })
    expect(fileFlags(['src/keys.ts'])).toEqual({ secretModified: false, productionImpact: false, newDependency: false })
  })

  it('a grant has a ceiling', () => {
    const g = { write: true, shell: true, network: false, install: false, gitPush: false, externalPayments: false }
    expect(grantCeiling(g)).toBe('E2')
    expect(grantCeiling({ ...g, network: true })).toBe('E3')
    expect(grantCeiling({ ...g, externalPayments: true })).toBe('E4')
    expect(grantCeiling({ ...g, shell: false })).toBe('E1')
    expect(grantCeiling({ ...g, shell: false, write: false })).toBe('E0')
  })
})

describe('the money gate', () => {
  const base = { sessionStatus: 'ready' as const, outcome: 'ALLOW_WITH_LOG' as const, decidedBy: 'policy' as const, settlement: 'escrow' as const, realMoney: false, allowRealMoneyFlag: undefined }

  it('lets a policy allow through on a testnet, from a money-moving status', () => {
    expect(moneyGate(base).allowed).toBe(true)
    expect(moneyGate({ ...base, sessionStatus: 'running' }).allowed).toBe(true)
  })

  it('never from waiting_on_approval, paused or a terminal status', () => {
    for (const st of ['waiting_on_approval', 'paused', 'completed', 'cancelled', 'draft'] as const) {
      expect(moneyGate({ ...base, sessionStatus: st }).allowed, st).toBe(false)
    }
  })

  it('mainnet money guard: a policy decision needs the env flag; an owner does not', () => {
    expect(moneyGate({ ...base, realMoney: true }).allowed).toBe(false)
    expect(moneyGate({ ...base, realMoney: true }).why).toMatch(/OFFICE_SESSION_ALLOW_REAL_MONEY/)
    expect(moneyGate({ ...base, realMoney: true, allowRealMoneyFlag: 'true' }).allowed).toBe(true)
    expect(moneyGate({ ...base, realMoney: true, decidedBy: 'owner', outcome: 'REQUIRE_OWNER' }).allowed).toBe(true)
  })

  it('a policy REQUIRE_OWNER or DENY never authorizes', () => {
    expect(moneyGate({ ...base, outcome: 'REQUIRE_OWNER' }).allowed).toBe(false)
    expect(moneyGate({ ...base, outcome: 'DENY' }).allowed).toBe(false)
  })

  it('an internal task passes for the record and moves nothing', () => {
    const g = moneyGate({ ...base, settlement: 'internal', sessionStatus: 'waiting_on_approval' })
    expect(g.allowed).toBe(true)
    expect(g.why).toMatch(/nothing moves/)
  })
})

describe('serialisation', () => {
  it('round-trips the default policy and refuses bad ones with a sentence', () => {
    const parsed = parsePolicy(JSON.parse(JSON.stringify(DEFAULT_APPROVAL_POLICY)))
    expect(parsed).toEqual({ ok: true, policy: DEFAULT_APPROVAL_POLICY })
    expect(parsePolicy({ ...DEFAULT_APPROVAL_POLICY, singleTaskLimitUsd: 50 })).toMatchObject({ ok: false, error: /cannot exceed/ })
    expect(parsePolicy({ ...DEFAULT_APPROVAL_POLICY, extra: 1 })).toMatchObject({ ok: false, error: /unknown key/ })
    expect(parsePolicy({ ...DEFAULT_APPROVAL_POLICY, deny: [{ field: 'nope', op: '==', value: 1 }] })).toMatchObject({ ok: false, error: /unknown field/ })
    expect(parsePolicy({ ...DEFAULT_APPROVAL_POLICY, deny: [{ field: 'amountUsd', op: 'in', value: 1 }] })).toMatchObject({ ok: false, error: /needs a list/ })
    expect(parsePolicy('x')).toMatchObject({ ok: false })
  })

  it('renders the spec example shape and names the hard rules', () => {
    const text = renderPolicy(DEFAULT_APPROVAL_POLICY)
    expect(text).toContain('daily_budget_usd: 20')
    expect(text).toContain('single_task_limit_usd: 3')
    expect(text).toContain('amountUsd <= 2')
    expect(text).toContain('hard rules the policy cannot relax')
  })
})

describe('the three postures an operator can actually choose', () => {
  it('each preset is a real policy the engine evaluates, and presetOf names it back', () => {
    for (const name of POLICY_PRESETS) {
      const p = PRESET_POLICIES[name]
      expect(presetOf(p), name).toBe(name)
      expect(PRESET_BLURBS[name].length, name).toBeGreaterThan(60)
      // a preset is not allowed to invent a field the engine cannot read
      for (const c of [...p.autoApprove, ...p.requireOwner, ...p.requireReviewer, ...p.deny]) expect(CONDITION_FIELDS, `${name}/${c.field}`).toContain(c.field)
    }
    expect(presetOf({ ...PRESET_POLICIES.standard, singleTaskLimitUsd: 99 })).toBeNull()
  })

  it('they differ in exactly the two things an operator is choosing between', () => {
    const [careful, standard, handsOff] = [PRESET_POLICIES.careful, PRESET_POLICIES.standard, PRESET_POLICIES.hands_off]
    // how much may settle without a person…
    expect(careful.singleTaskLimitUsd).toBeLessThan(standard.singleTaskLimitUsd)
    expect(standard.singleTaskLimitUsd).toBeLessThan(handsOff.singleTaskLimitUsd)
    expect(careful.dailyBudgetUsd).toBeLessThan(handsOff.dailyBudgetUsd)
    // …and whether an unreviewed result may settle at all
    expect(careful.requireReviewer.length).toBeGreaterThan(0)
    expect(standard.requireReviewer.length).toBeGreaterThan(0)
    expect(handsOff.requireReviewer).toEqual([])
  })

  it('no preset can buy its way past a hard rule', () => {
    for (const name of POLICY_PRESETS) {
      const p = PRESET_POLICIES[name]
      expect(evaluateApproval(p, ctx({ workspaceEscape: true })).outcome, name).toBe('DENY')
      expect(evaluateApproval(p, ctx({ testsPassed: false })).outcome, name).toBe('DENY')
      expect(evaluateApproval(p, ctx({ riskTier: 'E4' })).outcome, name).toBe('REQUIRE_OWNER')
      expect(evaluateApproval(p, ctx({ secretModified: true })).outcome, name).toBe('REQUIRE_OWNER')
      expect(evaluateApproval(p, ctx({ productionImpact: true })).outcome, name).toBe('REQUIRE_OWNER')
    }
  })

  it('careful sends a paid task to the owner that hands_off settles', () => {
    const paid: ApprovalContext = ctx({ amountUsd: 3, testsPassed: true, reviewerVerdict: 'APPROVE' })
    expect(evaluateApproval(PRESET_POLICIES.careful, paid).outcome).toBe('REQUIRE_OWNER')
    // ALLOW_WITH_LOG, not ALLOW: money moving without a person is allowed
    // here but never silent (the engine's own distinction, not the preset's)
    expect(evaluateApproval(PRESET_POLICIES.hands_off, paid).outcome).toBe('ALLOW_WITH_LOG')
  })

  it('reads back as three lists of sentences, not fields', () => {
    const words = policyInWords(PRESET_POLICIES.standard)
    expect(words.preset).toBe('standard')
    expect(words.allowed).toContain('its tests did not fail')
    expect(words.allowed).toContain('an independent reviewer approved it')
    expect(words.allowed).toContain('it changed at most 10 file(s)')
    expect(words.allowed).toContain('it costs at most $2')
    expect(words.asks).toContain('it touched a production path')
    expect(words.asks).toContain('no reviewer has looked at it yet (a reviewer is asked first)')
    expect(words.budget).toBe('$20.00 a day, at most $3.00 on one task')
    // no sentence leaks the field syntax
    for (const line of [...words.allowed, ...words.asks, ...words.never]) expect(line, line).not.toMatch(/==|!=|<=|>=|Usd\b/)
  })

  it('the "never" list is the part the policy cannot switch off', () => {
    const words = policyInWords({ ...PRESET_POLICIES.hands_off, autoApprove: [], requireOwner: [], requireReviewer: [] })
    expect(words.never).toEqual(
      expect.arrayContaining([
        'a run wrote outside the working directory you granted',
        'its tests or CI failed',
        'it moves money, deploys, or changes production (risk E4)',
        'it modified a secret or an environment file',
      ]),
    )
    // and an owner's own deny rules join it
    expect(policyInWords({ ...PRESET_POLICIES.careful, deny: [{ field: 'newDependency', op: '==', value: true }] }).never).toContain('it added a dependency')
  })
})
