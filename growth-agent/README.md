# Handsel Growth Agent

A local operations CLI for finding public AI-agent projects, qualifying likely Handsel workers, preparing specific outreach drafts for human review, and measuring activation through verified payouts. It does not send email, open issues, or message GitHub users. No account or external service is created.

## Quick start

```sh
cd growth-agent
cp .env.example .env
node src/cli.js scout 'MCP agent language:TypeScript'
node src/cli.js qualify 35
node src/cli.js queue
node src/cli.js approve <lead-id>  # prints the send-ready draft; still sends nothing
node src/cli.js export ./send-ready.json
node src/cli.js metrics
```

Node 18+; no additional dependencies. GitHub repository search is public. Set `GITHUB_TOKEN` to raise the API rate limit. Data is stored locally in `data/growth.json` with restrictive file permissions. Back it up securely; it contains public profile references and outreach drafts.

## Flow

`scout` stores repository/profile URLs, search query provenance, activity date, README, topics and public contact channel. Repository URL is the dedupe key. `qualify` scores activity, agent/tool execution, framework relevance, public contact route, and paid-work fit, then prepares a message naming the actual project and matching capabilities. The message explains the path from existing agent → claimed job → independently verified completion → payout.

Every qualifying lead enters `approval_pending`. `approve` requires the default-true `approval_required` setting, checks suppression, and applies `GROWTH_DAILY_CAP` to approvals. It only marks a draft send-ready. `export` writes approved drafts for a human to use; there is deliberately no send adapter. Use `suppress <id> [reason]` for opt-outs. Manual sources can use `import` with a JSON array of GitHub-shaped records; HN/Reddit may later add source adapters that preserve provenance and use the same gate.

Activation events are recorded manually with `stage <id> <stage>`: `contacted`, `replied`, `integrated`, `claimed_job`, `completed_job`, `first_verified_payout`, and `repeat_payout`. The `metrics` north star counts distinct external agents with at least one first verified payout. Update this only from Handsel's authoritative job/payout record; this CLI does not pretend to verify payouts or duplicate Handsel's public API and `sdk/` worker protocol.

## Worker adapter example

Growth Agent is an operator tool and does not itself claim arbitrary third-party work. To register it as a Handsel worker, use the existing SDK and connect a bounded growth task (such as reviewing a lead's public README and preparing an integration checklist) to the worker callback:

```js
import { Agent } from 'handsel-agent-sdk'

const worker = new Agent({
  name: 'Handsel Growth Research Agent',
  agentId: process.env.HANDSEL_AGENT_ID,
  secret: process.env.HANDSEL_AGENT_SECRET,
})
worker.onTask(async task => {
  // Perform only the task's public research and return a sourced checklist.
  // Human approval remains mandatory for any contact or account action.
  return `Research completed for: ${task}`
})
worker.start()
```

Use the existing registration/worker instructions in [`../sdk/README.md`](../sdk/README.md) and public protocol in [`../docs/agent-integration.md`](../docs/agent-integration.md). Longer term, a “Bring one external developer agent to first verified payout” task can be decomposed into public research, an integration checklist, human-approved outreach, and manually verified funnel events.
