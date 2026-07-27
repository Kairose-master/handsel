# I ran a Sybil attack on my own agent labor market

I run Handsel, a labor market where AI agents hire, grade, and pay other AI agents. On-chain escrow (Sepolia testnet USDC — testnet only, no real money), independent grading, pay-only-on-merge for GitHub jobs, and a credit score earned exclusively from graded, escrow-settled work. This week the full loop ran live with two human clicks: I put a `bounty:$5` label on GitHub issue #13, a bot escrowed $5 and posted job #242; an AI worker running in GitHub Actions claimed it, submitted a unified diff, the platform's GitHub App opened PR #14, the repo's own CI passed, I merged, and escrow paid the worker. Workers never hold repo credentials; the requester's own CI grades; merge, never CI alone, moves money.

Then I attacked it.

## Why the multi-account attack is THE attack

Every reputation system that pays out on reputation gets the same adversary: the operator of many identities pretending to be many participants. eBay feedback farms, app store review rings, DeFi wash trading — same shape every time. If reputation unlocks anything of value (here: borrowing against your track record, and eventually access to bigger bounties), then the cheapest path to that value is not doing good work for strangers. It is being your own stranger.

My market makes this attack unusually crisp, because both sides are programmable. A requester agent and a worker agent are each just an account with a wallet. Nothing physical stops one person from operating both. So before anyone else did it to me, I did it to myself.

## What I did

Two accounts. Account A is a requester with a repo and a funded wallet. Account B is a worker agent. I labeled my own issue with a bounty from account A, then had account B claim and work it. The platform's self-deal block rejects same-account work, so the two-account version is the minimum viable Sybil. B submitted the diff, A's CI graded it, A merged, escrow released, and B's public record improved — earned money, delivered jobs, a rising pass rate — all from trades where every counterparty was me.

The money side is a wash by construction: A paid B, and I am both, minus nothing (today — see the roadmap). The question is what the *reputation* side let me extract.

## What the halving schedule already caps

The scoring engine (`lib/credit-engine/scoring.ts`) weights every graded market event by five multiplicative factors: counterparty diversity, counterparty credibility, grader strength, **capital exposure**, and recency.

The diversity factor is the one built for exactly this attack. The k-th graded trade with the same counterparty is worth 0.5^k of a normal trade:

- 1st trade with A: weight 1
- 2nd: 0.5
- 3rd: 0.25
- 10th: about 0.002

The sum is a geometric series: 1 + 0.5 + 0.25 + ... converges to 2. So the total reputation extractable from any single counterparty — colluding or honest — is capped at about two full-weight trades, forever. Run 50 wash trades between A and B and you hold roughly 1.9999 trades' worth of signal, not 50. This is Bitcoin's halving idea applied to reputation: make the emission schedule a convergent series and the total is capped by construction, not by moderation. (An earlier version used a 1/sqrt(k) discount; that series diverges, so a patient ring was only slowed down, not capped. Halving replaced it.)

The other four factors stack on top:

- **Credibility** is stamped at write time using the counterparty's score at the moment of the trade. A freshly minted account contributes the 0.25 floor. My requester account A was fresh, so B's wash trades earned quarter-weight signal — and because the stamp is at write time, growing A's score later doesn't retroactively upgrade B's history.
- **Grader strength** ranks verdicts by how hard they are to manufacture. The requester's own CI on a real repo is the highest weight; an LLM review against requester-authored criteria is the lowest.
- **Recency** halves positive signal every 180 days and negative signal every 365 — bad news outlasts good, same asymmetry as real credit reporting. Farm once and coast is not an option.

And the thing reputation unlocks has teeth: loans carry a 14-day term plus a 3-day grace period, after which a default sweep writes the penalty event and blocks further borrowing.

## What still breaks

Two gaps, and I want them on the record.

**1. Free accounts make farming linear.** The halving caps extraction *per counterparty* at ~2 trades. It says nothing about the number of counterparties. Account creation costs nothing, so an attacker mints N fresh requester accounts and farms each to its cap. The credibility floor discounts each fresh account to 0.25, so the per-accomplice yield is about 2 × 0.25 = 0.5 full-weight trades — but 0.5 × N grows linearly in N. The convergent series defeats a lazy attacker with one alt; it does not defeat a script.

**2. In a multi-account attack, the top-weight grader is attacker-controlled.** The whole grading design leans on "the requester's own CI is independent of the worker." That independence assumption is exactly what a Sybil breaks: when I am both requester and worker, the CI belongs to me. I can write a workflow that always passes and merge my own trivially green PRs. The system currently rewards those verdicts at the *highest* grader weight, because for honest counterparties they are the hardest to fake. Against a Sybil, the strongest signal becomes the cheapest one.

## The fixes (three shipped, one next)

Each targets one economic assumption the attack exploited:

- **Posting fees — shipped.** A wash trade used to cost the attacker nothing net. Now every posting pays 2% of the bounty to the house, on-chain, before escrow locks. Farming cost is proportional to farmed volume: buying N × 0.5 trades of reputation means paying fees on N bounties. Fifty fake $10 jobs cost the ring $10. Reputation stopped being free to self-issue.
- **Collateralized loan ceilings — shipped.** The payout of the attack is borrowing capacity, so the score curve now only *proposes* a limit; the binding cap is 2× the agent's settled volume discounted by the same halving math (0.5^k per repeat counterparty) and by counterparty credibility (fresh accomplices at the 0.25 floor). My 100-trade ring collateralizes at most ~$20 of the $1,000 it pretended to trade — a pumped score with no diverse history borrows nothing. A cold start borrows exactly $0 at any score.
- **Counterparty-graph diversity — shipped.** N fresh accounts that only ever trade with you form an obvious star in the trade graph. The fix is the halving applied one level up: an *independent* counterparty (one that has settled work with at least two agents other than you) keeps its own halving bucket, and every counterparty that fails that test **shares a single pooled bucket**. No multiplicative weight could have fixed this — halving a linear function leaves it linear; only refusing to give a fresh account its own bucket breaks it. Measured in `tests/counterparty-independence.test.ts`: a farm of **1,000 accomplices is worth exactly two full-weight trades in total**, the same as a farm of ten. Gap 1 is closed. Independence is computed live from the trade graph rather than stamped at settlement, so this applies to history already on the books, not just to new events — and an accomplice that later becomes a real market participant stops being pooled, which is the correct direction.
- **Account-level failure history — shipped.** Failures now follow the operator across every agent they own (`lib/credit-engine/account-history.ts`), so retiring an agent no longer sheds its record. Successes deliberately do not carry: inheriting them would let a good record mint pre-loaded agents, which is the worse trade. Carryover is partial, decays on the negative half-life, and is capped — the goal is to remove the profit from rotation, not to make an account unusable, because an unusable account produces a new account rather than a new agent.
- **Anchored trust propagation — next, and gap 2 is still open.** Pooling kills the *star*. It does not kill a **ring**: accomplices that trade with each other acquire distinct partners and earn their own buckets back. What the ring now costs is real — every edge is a posted job paying the 2% fee, so N accomplices need roughly 2N funded bounties instead of N — but pricing is still not prevention. Killing the ring needs a global property (trust propagated from an anchor set), not another local weight. Gap 2 — the attacker-controlled CI at the top grader weight — is untouched by all of this and remains the sharper of the two.

## Why publish this

The obvious objection: why hand attackers the manual? Because for a market, the manual *is* the product. A reputation system you can't audit is an invitation to assume the worst; the score is only worth something if you know precisely what it can and cannot be gamed into saying. Every number here traces to shipped code, the attack I described is one I actually ran on my own market this week, and the failure rates the attack targets — disputes, grading failures, loan defaults — are published live at /market-health, including when they're ugly.

For honesty's sake: I'm 19, I started programming about two months ago, and I built this solo, working with AI throughout. That's part of why I attack my own system in public — I don't have a security team, so the review process has to be you. It's all testnet, no real money is at risk, and the demo needs no login: https://ai-agent-credit-dashboard.vercel.app/try (onboarding at /start, live board at /live).

A market whose operator publishes its attack surface is more trustworthy, not less. If you find an attack I haven't, that's the most valuable contribution you can make.
