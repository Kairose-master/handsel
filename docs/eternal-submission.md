# Colosseum Eternal — submission package (draft)

Working draft for the week-4 submission (`docs/solana-port.md` sets the
4-week gate: product demo + repo + technical walkthrough). Everything below
is written to be pasted into the submission form with minimal editing.
Claims are limited to what is deployed and verifiable — links, not
adjectives.

## Product description (short form, ~100 words)

> **Handsel** is a labor market where AI agents hire, work for, and extend
> credit to other AI agents — live on Base mainnet with real USDC: on-chain
> escrow, independent grading, pay-only-on-pass, a signed proof per
> deliverable, and a credit score earned from graded work. The Eternal
> sprint brought the escrow core to Solana: the same money loop
> (post → accept-with-bond → submit → approve → withdraw) as an Anchor
> program on devnet, operated by the same off-chain stack — one task feed,
> one credit engine, two runtimes. Devnet by decision, not omission:
> mainnet standing is earned by publication and attack, the way our EVM
> contracts earned it.

## The three sentences that differentiate it

1. **It already runs with real money somewhere.** The Base mainnet
   deployment (verified bytecode, self-audit, static analysis, a funded
   "break it" challenge) is the credibility floor; the Solana port is a
   second runtime for a proven mechanism — not a first draft of one.
2. **The platform operates the market, it doesn't just host it.** The board
   (/solana) re-audits every program invariant from raw accounts on each
   refresh — solvency against the actual vault balance included. The feed
   (/api/tasks) serves both runtimes in one schema. Credit publishes to
   both chains.
3. **Slashes are burned, never paid.** A slash paid to any party who can
   influence the slash is an incentive to manufacture it. `token::burn`
   from the vault, same reasoning verbatim as the EVM `_burnBond`.

## Links block

| What | Where |
|---|---|
| Live board (devnet, no login) | https://handsel-nu.vercel.app/solana |
| Cross-runtime task feed | https://handsel-nu.vercel.app/api/tasks?status=all |
| Program (devnet) | `8C3gbrTv5vriPiEjuS7BukrnxyAFoDYt8BdBCf7W2G6H` — explorer link on the board |
| Program source | `solana/programs/handsel-market/src/lib.rs` |
| Design & scope contract | `docs/solana-port.md` |
| Base mainnet product | https://handsel-main.vercel.app |
| Encoder-vs-chain verifier | `scripts/verify-solana-write.mts` (read-only, run it yourself) |

## Technical walkthrough (script, ~3 min — record as one screen capture)

1. **The scope contract** (`docs/solana-port.md`, 20s). One month of Rust
   does not inherit the EVM deployment's trust; the doc says devnet-only
   and the code enforces it (`guardDevnet()` in write.ts refuses any
   real-money cluster). Show the invariant-mapping table.
2. **The program** (`lib.rs`, 45s). Walk the money loop top to bottom:
   escrow at post (fee escrowed WITH bounty — refunds are full; the
   platform is paid only for concluded work), bond at accept, result_hash
   set only by submit (zero = no submission, bit-compatible with the EVM
   signal), pull-payment credit at approve, zero-before-transfer at
   withdraw, bond BURNED on reclaim. Point at the `credit()` bump comment:
   a real devnet bug (job #0's unwithdrawable ledger), found by running,
   documented in place.
3. **The duplication discipline** (30s). Two languages describe one wire
   format, and duplication nobody checks is a second place to be wrong —
   so `tests/solana-codec.test.ts` and `tests/solana-tx.test.ts` READ the
   Rust source and diff the TypeScript against it, and
   `scripts/verify-solana-write.mts` diffs the encoders against REAL
   transactions on the cluster. Run it live: four instructions, all match.
4. **The platform operating the market** (45s). `/solana`: the live audit
   panel — six invariants recomputed from raw accounts, solvency shown as
   the one-line comparison it is. `POST /api/admin/solana-loop`: the
   deployment itself signs the whole loop; run it, watch the new job walk
   Open → Completed on the board. `/api/tasks`: one feed, both runtimes,
   `chain` stamped per entry.
5. **What's deliberately absent** (20s). Disputes/arbiter, liens, silence
   forfeit, lending — v0.1 cuts with reasons in the doc, not omissions.
   Close on the honest line: this program earns standing the way the EVM
   one did, by being published, analyzed and attacked.

## Weekly 1-min updates (backlog — post verbatim, one per week)

**Week 1 (posted retroactively if the form allows):** Scoped the port as a
contract: the money loop only, devnet only, invariants mapped 1:1 from the
mainnet EVM deployment (`docs/solana-port.md`). Program compiles
(`cargo check` in the standard gate list); every v0.1 cut documented with
its reason.

**Week 2:** The loop closed on devnet. CI builds with the real SBF
toolchain, verifies the program keypair matches `declare_id!`, deploys, and
runs a happy-path script that asserts the arithmetic at every step —
including that approve moves NO tokens (settlement credits a ledger; only
withdraw transfers). Found and fixed a real bug this way: settlement
credited a ledger whose bump was never written, so the money was in and
unwithdrawable — job #0 on devnet is the fossil.

**Week 3:** The write path — the platform itself signs. Instruction
encodings pinned twice: tests diff them against the Rust source, and a
read-only script diffs them against real on-chain transactions. The board
now audits the market (six invariants, raw accounts, every refresh), the
task feed serves both runtimes in one schema, and credit publishes to the
second chain via the oracle key. One endpoint runs the whole loop from the
deployment that serves the board.

**Week 4:** The finale ran. An escrowed job on devnet was worked by a pen
plotter over WiFi and settled — post, bond, draw, submit, approve, withdraw —
which is the first time in this project that money moved because a machine did
something in the world.

It took five attempts, and the four that failed are still on the board as
`Accepted`. Three different error messages across them turned out to be two
causes: one genuine hotspot IP churn, then a sagging battery three times wearing
network costumes — a browning-out board answers nothing, then disappears from
mDNS, so the transport reports a name that will not resolve and you debug DNS.
Wall power fixed it.

The defect that exposed is ours rather than the plotter's: **an accepted job has
no exit but the deadline.** A worker that dies mid-run leaves the claim and the
escrow held and nothing notices the claimant stopped existing. The four stuck
jobs are left in place on purpose — they are the evidence the gap is real, and a
heartbeat on accepted claims is the first thing the machine lane needs.
Written up as failure-modes §29.

## The finale shot: devnet pays a physical machine

**It ran, 2026-08-18 — job #9, `Completed`.**

`scripts/solana-physical-loop.mts` runs the whole loop with a real pen
plotter in the middle: post (escrow) → accept (the machine's worker key
bonds) → **the plotter physically draws the card** → submit
(result_hash = sha256 of the printed production record — recompute it
yourself and match the job account) → approve → withdraw. Run it on the
booth laptop with `SOLANA_OPERATOR_KEYPAIR` and `BOOTH_DIR` set, on **wall
power** — see the week 4 note above for why that word is load-bearing.

Likely the only submission whose escrow settles against ink. One asymmetry
worth stating rather than letting a reviewer find: the **settlement** is
verifiable by anyone against the public cluster, but that a pen actually moved
on paper is attested by the booth alone. Nothing in this loop is a camera. The
`result_hash` proves the production record was not edited after the fact; it
does not prove the record describes reality. That is an E2 claim in our own
evidence vocabulary and it is filmed as one.

## Demo video shot list (60–90s, the submission's product demo)

1. /solana cold open — devnet banner, jobs, audit panel all green (8s)
2. Terminal: `curl -X POST …/api/admin/solana-loop` (10s)
3. JSON answer scrolls: five signatures with explorer links (8s)
4. Board refresh: the new job appears, Completed; click through to Solana
   Explorer — the same account, on the public cluster (20s)
5. /api/tasks in the browser: EVM + `"chain":"solana:devnet"` entries in
   one feed (8s)
6. THE FINALE — solana-physical-loop.mts running split-screen with the
   plotter: escrow posts, machine bonds, pen draws, result_hash lands,
   machine withdraws its earnings (20s)
7. Cut to handsel-main.vercel.app (Base mainnet, real USDC) — "the
   mechanism this ports is already live with real money" (8s)
8. Close card: repo + docs/solana-port.md (6s)
