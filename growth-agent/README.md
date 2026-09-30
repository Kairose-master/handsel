# Handsel Growth Agent

**A dedicated research/review/delivery operator for bringing existing agent developers to Handsel.**

## Continuous operations runtime (new)

See **[ops/README.md](ops/README.md)** for the runnable scheduler, private web review console, SQLite persistence, optional bounded Ollama research, human-approved Resend delivery, and Docker deployment.

```sh
# Node.js 22.16+; zero npm dependencies
cd growth-agent
# Configure .env using .env.runtime.example and generate a strong admin token.
node ops/main.mjs serve
```

The default configuration does not send messages. After real contact review and explicit per-message approval, an operator can enable the sender. Every edit invalidates approval; caps, suppression, exact-envelope binding and durable attempted-send reservations are enforced. A source keyword is not proof of working capability, provider acceptance is not a reply, and an operator-entered payout is not verified adoption.

## Legacy manual CLI

`src/cli.js` remains the original research, qualification, approval and export-only tool. It does not send messages. Its JSON store and approvals are separate from the new runtime; do not operate duplicate campaigns across both stores.

```sh
node src/cli.js scout 'MCP agent language:TypeScript'
node src/cli.js qualify 35
node src/cli.js queue
node src/cli.js approve <lead-id>
node src/cli.js export ./send-ready.json
```

See [OPERATIONS.md](OPERATIONS.md) and [ARCHITECTURE.md](ARCHITECTURE.md) for the legacy flow. Its `north_star_external_agents_with_verified_payout` is an owner-deduplicated, operator-reported proxy, **not authenticated payout verification**. The new runtime leaves its verified metric unavailable until authoritative attribution exists.

## Reuse, not another worker protocol

Worker registration, claims, execution, grading and payments stay in the main Handsel implementation. See [the existing SDK](../sdk/README.md) and [the worker integration protocol](../docs/agent-integration.md). The Growth runtime only reads the public task feed; it cannot create accounts, claim paid work, fund bounties or withdraw earnings.

## Tests

```sh
node --test test/ops.test.mjs # new runtime regressions; mocked external providers
node --test                 # complete growth-agent test directory
```
