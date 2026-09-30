# Running the Growth Agent safely

This is an operator-invoked CLI, not a deployed scheduler or an autonomous outreach service. It discovers candidate repositories and prepares template-based drafts. It does not send messages, verify actual project capabilities, or verify on-chain payouts.

## Configuration

Run commands from `growth-agent/`. The CLI reads `.env` in its current working directory **before** choosing its data directory or making a GitHub request. Explicit environment variables take precedence. The dependency-free loader supports single-line `KEY=value`, quoted values, blank lines and comments; it never evaluates shell code or expands variables. Protect `.env` and the local lead store. Node.js 18+ is the supported API target; this patch was tested on Node.js 22.16.0.

`GROWTH_DAILY_CAP` must be a positive safe integer. An invalid cap or `GROWTH_APPROVAL_REQUIRED=false` stops the command instead of disabling the guard. The cap counts approvals per UTC day, not delivered messages. There is no send adapter.

```sh
cp .env.example .env
node src/cli.js scout 'MCP agent language:TypeScript'
node src/cli.js qualify 35
node src/cli.js queue
# Review the repository, draft and a legitimate public contact route first.
node src/cli.js approve <lead-id>
node src/cli.js export ./send-ready.json
node --test
```

A GitHub profile URL is a research pointer, **not** a messaging channel or consent to marketing. Do not open unsolicited promotional issues. GitHub-shaped manual imports must have an `https://github.com/` `html_url`; HN/Reddit adapters and direct non-GitHub lead imports are not implemented.

## Opt-outs

`node src/cli.js suppress <lead-id> 'opt-out'` blocks approval and export for that lead, its known owner, and matching contact/source URLs. The export path rechecks suppression even for previously approved drafts and legacy leadId-only suppression records. A new repository by that same known owner is not a new permission to contact them.

Previously exported files cannot be recalled: regenerate them after an opt-out and delete obsolete copies before manual outreach. Default export filenames are gitignored. Exports receive restrictive file permissions; do not publish them or overwrite the lead store with them.

## Evidence and limits

Repo keywords are candidate signals, not proof of functionality. Drafts say metadata *mentions* a capability and link to the existing protocol document rather than asserting that an integration was tested. Available work, funding requirements and independent grading still determine whether a worker earns anything.

Activation stages remain manual operator entries. The current `north_star_external_agents_with_verified_payout` field is **not verified on-chain** and is deduplicated by owner (or lead ID), not agent identity. Treat it only as an operator-reported proxy; do not publish it as independently verified external-agent adoption. An authenticated Handsel payout read adapter and agent-level attribution remain future work.

Validation for this patch is local: original source/test files were checked against GitHub blob SHAs, then the Node tests exercised configuration and import/qualification/approval/suppression/export using temporary fixtures. No live prospect was contacted, no payment was made, and no scheduled process was started.
