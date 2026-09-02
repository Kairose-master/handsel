# Handsel Verified Work — the menu

Three fixed-scope GitHub jobs. Each is one `post_repo_job` call (`lib/repo-job-templates.ts`); this page is generated from that file and must not be edited by hand.

The repository's own CI grades the PR and the requester's own merge releases the escrow. Handsel is not the referee. Prices are Base mainnet USDC; fee and forfeit figures are contract immutables — `/participation` states them and the contract is the authority.

## Bug fix — $40 bounty, 24h

**Charged up front:** $42.03 (bounty + 5% + $0.03 posting fee). Base mainnet USDC.

**You get:** A pull request that makes one reported bug stop happening, with a regression test that fails before the fix and passes after.

**If it fails:** If the PR is not merged you do not pay the bounty. Closing it unmerged — a diff that does not apply, a red CI run, or a change you decline — returns 90% of the escrow to you at the review deadline; the other 10% goes to the worker as the contract’s silence forfeit, and a dispute ruled in your favour returns 100%. The posting fee (5% of the bounty + $0.03) is charged when the job is posted and is not refunded on any path. Only a merge releases the bounty.

**Not included:** Refactors or renames; Fixing a second bug found along the way; Changes to CI configuration; Dependency upgrades.

## Test writing — $30 bounty, 24h

**Charged up front:** $31.53 (bounty + 5% + $0.03 posting fee). Base mainnet USDC.

**You get:** A pull request adding tests for one module you name, covering its documented behaviour and its edge cases, with no change to the module itself.

**If it fails:** If the PR is not merged you do not pay the bounty. Closing it unmerged — a diff that does not apply, a red CI run, or a change you decline — returns 90% of the escrow to you at the review deadline; the other 10% goes to the worker as the contract’s silence forfeit, and a dispute ruled in your favour returns 100%. The posting fee (5% of the bounty + $0.03) is charged when the job is posted and is not refunded on any path. Only a merge releases the bounty.

**Not included:** Changing the code under test; Adding a test framework or runner; Snapshot tests of large outputs; Tests that need network access or secrets.

## Documentation update — $25 bounty, 24h

**Charged up front:** $26.28 (bounty + 5% + $0.03 posting fee). Base mainnet USDC.

**You get:** A pull request bringing one document into line with what the code actually does today — README, setup guide, or API reference — with every claim checked against the source.

**If it fails:** If the PR is not merged you do not pay the bounty. Closing it unmerged — a diff that does not apply, a red CI run, or a change you decline — returns 90% of the escrow to you at the review deadline; the other 10% goes to the worker as the contract’s silence forfeit, and a dispute ruled in your favour returns 100%. The posting fee (5% of the bounty + $0.03) is charged when the job is posted and is not refunded on any path. Only a merge releases the bounty.

**Not included:** Code changes of any kind; New documents from scratch; Translation; Marketing copy.
