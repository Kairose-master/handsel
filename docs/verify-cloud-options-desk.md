# Running the Cloud Options Desk once, end to end

Everything shipped for the office — the four verified MCP servers, `assisted`
mode, the `[mcp-query]` fix, the review round-trip, per-step payers, the MCP
tool surface — is green on `tsc`, `lint`, the test suite and a production
build, and **has never been executed once**. This is the shortest path from
that to a memo you can read.

Written by tracing the code paths this specific desk takes, not by summarising
`.env.example`. Where a requirement is non-obvious it says which file makes it
one.

---

## The thing most likely to surprise you

**Two of the six roles are not MCP workers.** The Architect and the Red Team
are `platform` agents, and `lib/agent-tasks.ts:157` dispatches those to
`startAgentTask` → **`AGENT_RUNTIME_URL`**, the Python worker runtime
(`agent-runtime/`, default `http://localhost:8000`).

So "the connectors need no key" is true and does not mean the desk needs
nothing. Without that runtime the four vendor reads complete and the desk
**stalls at step 5 of 6** — which looks like the review gate hanging, and
isn't.

---

## Preflight

### Required — the desk cannot run without these

| Variable | Why this desk needs it | Symptom if missing |
|---|---|---|
| `DATABASE_URL` | Everything | Nothing loads |
| `BETTER_AUTH_SECRET` | Sessions. Unset falls back to the library default, i.e. forgeable | App boots, sessions insecure |
| `BETTER_AUTH_URL` | The origin the callback posts back to | Worker results never land |
| `API_KEY_ENCRYPTION_SECRET` | Decrypts stored keys and MCP auth headers | "Stored API key could not be read" |
| `ADMIN_EMAIL` | Your login | No admin |
| `ANTHROPIC_API_KEY` | **Three separate consumers here:** the LLM verifier that grades every deliverable, `resolveLlm` behind `assisted` mode, and the runtime's own key for the two platform agents | Readers fail to write; nothing grades |
| `AGENT_RUNTIME_URL` | The Architect and the Red Team (see above) | Desk stalls after the four reads |
| `ONCHAIN_CHAIN` + `ONCHAIN_RPC_URL` | `sepolia` or `base-sepolia` | No provisioning |
| `AGENT_OWNER_PRIVATE_KEY` | The signer behind every agent account | `isAgentAccountConfigured()` false |
| `LABOR_MARKET_ADDRESS` | `isLaborMarketConfigured()` | Confirm cannot post |
| `USDC_ADDRESS` | Your deployed MockUSDC on testnet | Escrow reverts |
| `BUNDLER_RPC` **or** `AGENT_ACCOUNT_MODE=eoa` | `isAgentAccountConfigured()` needs one or the other (`lib/onchain/config.ts:233`) | Agents cannot transact |

### Deliberately NOT required

- **A key for any of the four MCP servers.** AWS Knowledge, Microsoft Learn,
  Cloudflare Docs and Exa all answered anonymously
  ([`office-connectors.md`](office-connectors.md)).
- Everything in Tier 4+ of `.env.example`: GitHub App, EAS, vault, paymaster
  budgets, Solana. None of it is on this path.

### The one setting that changes the shape

`REQUIRE_USER_API_KEY=true` makes **the account's own key mandatory** rather
than falling back to the platform's — in Settings, before hiring. Note the two
paths disagree in their error text, so this is worth getting right up front:
`resolveLlm` says *"Planning needs an LLM key"* and `resolveUserAnthropicKey`
says *"Add your Anthropic API key in Settings to run agent tasks"*. Same cause.

---

## The run

**0. `/doctor`** for the self-check, then confirm the two things it does not
cover: `AGENT_RUNTIME_URL` answers, and `/office` loads.

**1. One funded agent.** Create it, provision it (Profile → On-Chain), mint
test USDC. It pays for all six steps unless you split the bill.

**2. Test one connector.** Office → Staff & connectors → **Test**, or from
Claude Code, `test_mcp_connector`. Expect: reachable, and *"sends its input as
`search_phrase`"*. **This is the cheapest possible check that the whole MCP
path works** — if it fails, stop here; nothing downstream can succeed.

**3. Hire.** Office → Hire a template office → Cloud Options Desk. The
connector rows arrive pre-filled; leave them. Budget $12 (six steps, the
architect weighted 2 — the dialog will show it escrows $12.00). Nothing is
escrowed by this step.

Six agents are created, each provisioning a smart account. Expect this to take
a minute and to cost gas.

**4. Read the plan on `/delegate` before confirming.** This is where the work
so far becomes checkable:

- Four reads with no dependencies; the Architect depending on all four; the
  Red Team marked *reviews Architect*.
- If you set a shared source, each brief carries it.
- If you split the bill, the steps you reassigned say **paid by X**.

**5. Confirm.** Money moves here and only here.

**6. Watch.** Auto-mine sweeps are traffic-driven, not cron — keep `/delegate`
open, or the sweep will not run.

---

## What each stage proves, and how it fails

| Stage | Proves | Failure signature |
|---|---|---|
| Test button | Handshake, tool exists, argument key | "advertises no tool called…" — a rename upstream |
| The four reads deliver | `assisted` mode: tool called, model wrote from it | A raw JSON result dump as the deliverable = the agent is in `proxy`. Check the roster line |
| Reads name their sources | `[mcp-query]` sent the short query | Vendor-irrelevant pages quoted = the whole brief went as the query |
| Architect delivers | `AGENT_RUNTIME_URL` is reachable | Stalls with four reads done — the failure above |
| Red Team returns APPROVE/REVISE | The review gate | Escrow held with no verdict = the reviewer never got dispatched |
| A REVISE goes back to the Architect | The round-trip, **the least-tested thing here** | `/delegate` shows "revision 1 — back with the worker". If it instead sits at "still not approved… your call" on the first REVISE, `decideRevision` was reached with a spent round count |
| Escrow releases on approve | `approveJob` signed by the payer | An on-chain revert here means the job's requester and its payer disagree — the bug the per-payer commit fixed |

---

## What I would not trust until it has run

Honestly ranked, most to least likely to be wrong:

1. **The revision round-trip.** Only the pure `decideRevision` and the two
   brief builders are tested. Re-dispatching the worker, re-pointing
   `jobSpec.agentTaskId`, and re-running the reviewer are tick-path code with
   no coverage.
2. **`assisted` mode's real output.** The prompt is tested; whether a 24 KB
   Microsoft Learn envelope actually produces a sourced answer is not.
3. **Six concurrent provisions.** Nothing here has hired six agents at once.
4. **The `[mcp-query]` line surviving assembly.** Tested as a string, not
   through a real `postOneSubtask` with the DSL prepended and the shared
   source appended.

Everything above the line in this file is derived from code. Everything in this
list is derived from the absence of a run.
