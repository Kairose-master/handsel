/**
 * Which money this page is talking about, decided once instead of written down.
 *
 * `docs/deployments.md` claimed: *"Nothing asserts 'testnet' or 'mainnet'
 * anywhere; the chain does."* That was false, and the counterexample was the
 * single most-read sentence this project ships — the first line under the
 * headline on the public landing page:
 *
 *   "Running on a public testnet — real escrow, signatures, and grading, with
 *    zero monetary value. Everything below is live data."
 *
 * It rendered unconditionally, so **the Base-mainnet homepage told every visitor
 * their money had no value** while the page beneath it listed live $5, $3 and
 * $100 jobs settling in real Circle USDC. The banner and the footer on the same
 * page already branched correctly; the hero was a plain `t()` call that nobody
 * noticed was a claim. Found by a third-party auditor, not by us — §26.
 *
 * ## The two defaults, and why they differ
 *
 * `realMoney` is tri-state: true, false, and **null while the page is still
 * loading**. Null is not a chain, so it cannot be answered by asking what chain
 * this is. It is answered by asking which way the mistake hurts.
 *
 * - **`tokenNoun` defaults to the real-money word.** Calling test tokens "USDC"
 *   makes a visitor over-cautious. Calling real USDC "test USDC" invites someone
 *   to risk money they think is play money. `lib/onchain/config.ts` already
 *   resolved this exact question for chains it does not recognise — *"an unknown
 *   chain is treated as real money, which is the safe direction"* — and this is
 *   the same question one layer up.
 *
 * - **`heroDisclaimerKey` defaults to neither.** Unlike a noun, a sentence can
 *   decline to answer, and a third sentence that makes no environment claim is
 *   strictly better than guessing. Same reasoning as `RiskBanner`: *"I don't
 *   know what chain this is" is not a position from which to write one.*
 *
 * The rule underneath both: **an environment is a fact about the chain, so no
 * user-facing string may assert one from a constant.** Enforced by
 * `tests/money-label.test.ts`, which fails on any `guest.*` translation that
 * names an environment without being part of a branched set.
 */

/** The i18n key for the noun to interpolate as `{token}` into money sentences. */
export function tokenKey(realMoney: boolean | null | undefined): 'token.real' | 'token.test' {
  // Only an explicit `false` earns the test-token wording. Null, undefined and
  // true all read as real money — see the header on why the tie goes this way.
  return realMoney === false ? 'token.test' : 'token.real'
}

/**
 * The i18n key for the hero disclaimer.
 *
 * Three keys rather than one interpolated sentence because the two environments
 * make structurally different claims — mainnet warns about real settlement,
 * testnet reassures about zero value — and forcing them through one template
 * produces a sentence that is limp in both.
 */
export function heroDisclaimerKey(
  realMoney: boolean | null | undefined,
): 'guest.hero.disclaimer.mainnet' | 'guest.hero.disclaimer.testnet' | 'guest.hero.disclaimer.unknown' {
  if (realMoney === true) return 'guest.hero.disclaimer.mainnet'
  if (realMoney === false) return 'guest.hero.disclaimer.testnet'
  return 'guest.hero.disclaimer.unknown'
}

/**
 * Phrases that make an environment claim, for the guard test.
 *
 * Deliberately about MEANING, not about the word "testnet": "zero monetary
 * value" names an environment just as firmly as "testnet" does, and it is the
 * half of the broken sentence that actually misled anyone.
 */
export const ENVIRONMENT_ASSERTIONS = [
  'testnet',
  'mainnet',
  'zero monetary value',
  'no monetary value',
  'test tokens',
  'test USDC',
  '테스트넷',
  '메인넷',
  '금전적 가치',
  '테스트 USDC',
  '测试网',
  '主网',
  '货币价值',
  '测试 USDC',
]

/** Keys allowed to name an environment: the branched hero variants and the two
 *  token nouns, which exist precisely so the rest of the copy does not have to. */
export const ENVIRONMENT_KEYED = [
  'guest.hero.disclaimer.mainnet',
  'guest.hero.disclaimer.testnet',
  'guest.hero.disclaimer.unknown',
  'token.real',
  'token.test',
]
