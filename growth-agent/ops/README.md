# Handsel Growth Operations Runtime

A continuously running **research -> review -> approved delivery -> follow-up review** operator. It extends the existing `growth-agent` CLI, reuses its project normalization/scoring and honest outreach template, and reads Handsel's shipped `GET /api/tasks` feed. It never claims jobs, creates bounties, registers accounts, signs wallet transactions, or changes Handsel's escrow.

## Run now (no external messages)

Requires **Node.js 22.16+** (`node:sqlite`; experimental on Node 22), with no npm dependencies.

```sh
cd growth-agent
# Fresh setup only. If .env already exists, merge these settings instead.
cp .env.runtime.example .env
# Save the generated token securely; it unlocks the local operator console.
node -e "console.log('GROWTH_ADMIN_TOKEN='+require('node:crypto').randomBytes(32).toString('hex'))" >> .env
node ops/main.mjs demo  # optional: labelled fictional lead; pauses scheduler; cannot be sent
node ops/main.mjs serve
```

Open `http://127.0.0.1:4318`, enter your admin token, and inspect the queue. The token stays only in the tab's memory. With a demo fixture loaded, click **Resume** only when you intend real public research to start. Demo leads remain non-sendable in every mode.

For actual public research, without sending:

```sh
node ops/main.mjs resume
node ops/main.mjs run
node ops/main.mjs report
node ops/main.mjs serve
```

The long-running server automatically scouts every six hours, bounded to ten new projects per cycle by default. Every minute it checks for authorized pending sends. You do not have to invoke `scout`, `qualify`, or `export` repeatedly. The persisted next-run time prevents a restart from causing a tight research loop. GitHub rate-limit/errors and incomplete results are logged, not relabelled success.

## Optional local LLM research

Set `GROWTH_OLLAMA_URL=http://127.0.0.1:11434` and `GROWTH_OLLAMA_MODEL` to a model you have installed. The runner requests at most three suggestions per research cycle, with a 250-token output bound and 30s timeout. The model must cite an exact excerpt from the retrieved README. Invalid output fails closed to the existing template. Its suggestions appear beside the draft for review; they are **not silently inserted into an already approved message**.

This is bounded evidence extraction, not a claim to have tested the project. README and model text have no access to recipient selection, credentials, shell, approval state or send tools. Source text is rendered as text, never HTML. No LLM endpoint or model is supplied implicitly, and there is no paid-model purchase.

## Enable delivery deliberately

The included adapter calls Resend's `POST /emails`; no message is sent just by running the default configuration. To enable delivery, configure your verified sending domain, a monitored reply inbox and an API key:

```dotenv
RESEND_API_KEY=your-server-side-key
GROWTH_FROM=Your Name <you@your-verified-domain.example>
GROWTH_REPLY_TO=your-monitored-inbox@example.com
GROWTH_DRY_RUN=false
GROWTH_SEND_ENABLED=true
GROWTH_SEND_DAILY_CAP=5
```

Restart the runtime after configuration changes. In the web queue:

1. Check the actual project and a legitimate public business/contact invitation. A GitHub profile is **not** a contact channel or permission. Do not use promotional GitHub issues or emails scraped from commits.
2. Enter the recipient, the evidence URL and the contact basis. Review and save the exact subject/body.
3. Identify the reviewer, tick the confirmation, and approve the saved message. Any later edit, sender change or 24h expiry invalidates approval.

The scheduler will then send only eligible approvals, at most five first-contact attempts per UTC day by default. It rechecks person/email suppression and prevents another repository from becoming a second unsolicited contact. There is no bulk-approval endpoint and no automatic follow-up sender. Provider acceptance is recorded as **sent / provider accepted**, not delivered/read/replied.

### Uncertain deliveries

Each message has a durable reservation and an `Idempotency-Key`. Resend retains keys for 24h, so the runtime **does not assume permanent provider idempotency**: it never automatically retries an attempted send. Timeout, crash or an ambiguous response leaves `unknown`/`sending` for operator reconciliation. Do not create a replacement message until you have checked the provider logs. Pause/suppression stop future requests but cannot recall an already in-flight email.

Monitor the reply inbox and provider bounces during any experiment. Record opt-outs/bounces promptly in the console; known owners and recipient emails are suppressed. Automatic inbox ingestion and verified provider-webhook ingestion are **not implemented** in this version.

## What it tracks, and what it does not

The console shows source snapshots, evidence, run history, messages awaiting review, provider receipts, errors, current market-read status and seven-day follow-up **review reminders**. Reply/integration/job/payout observations require an evidence URL and are explicitly `operator_reported`; duplicates are ignored.

`verifiedExternalPaidAgents` is **null**, not zero or a made-up success count. The public task feed deliberately withholds worker agent IDs. Reading a balance or a public work-proof cannot establish that a newly recruited external owner received an attributable payout. Authenticated owner linkage + authoritative settlement attribution is a separate integration still required. Reported payout records never become verified adoption automatically.

No click/open tracking pixels, fabricated case studies, automatic paid jobs or self-dealing growth bounties are created. Attribution query parameters are only hints, not proof of acquisition. Existing job availability, gas/bond funding, eligibility and grading still apply to prospective workers.

## Keep it running on one host

```sh
cd growth-agent
# Configure .env first. Containers are not started by this repository or PR.
docker compose -f compose.runtime.yaml up -d --build
docker compose -f compose.runtime.yaml logs -f --tail=50
```

The runtime runs as an unprivileged user, restarts after a host reboot and stores its SQLite WAL database in a persistent Docker volume. The review port binds only to loopback. On a remote host, use an SSH tunnel:

```sh
ssh -L 4318:127.0.0.1:4318 your-host
```

Do not publish the console directly to the Internet. Host/origin checks and a strong bearer token protect this private single-operator surface; it is not a multi-tenant SaaS or a substitute for a security audit. SQLite leases coordinate processes on **the same local database**, not separate machines or a network filesystem. Data includes contact details and drafts; back up and restrict access to the volume. Stop the runtime before copying the DB, or use SQLite's online backup. Never commit the data directory, `.env` or exported drafts.

`node ops/main.mjs pause` is a persisted kill switch; `resume` re-enables research and eligible sends. The original `src/cli.js` remains a legacy local tool with a separate JSON store. Its old approvals/payout stages are intentionally **not trusted or imported**. Do not run duplicate outreach campaigns across the old and new stores. Before importing old/public records, carry over known opt-outs via the runtime suppression controls. Import accepts only a bounded array of GitHub public-repository records:

```sh
node ops/main.mjs import ./reviewed-public-projects.json
```

## Tests and implementation boundaries

`node --test test/ops.test.mjs` tests the runtime, SQLite transactions/leases, exact approval, opt-outs, cap, expiry, sender binding, restart safety, source failures, source response limits, bounded LLM evidence, HTTP authentication/CSRF and the complete HTTP review flow. All network/payment/email behavior in those tests is simulated; they do not send messages or verify real payouts.

Reference APIs: [Handsel worker integration](../../docs/agent-integration.md), [TaskSpec](../../lib/task-spec.ts), [Resend send](https://resend.com/docs/api-reference/emails/send-email), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [Ollama generate](https://docs.ollama.com/api/generate), [Node SQLite](https://nodejs.org/api/sqlite.html).

T54/XRPL remain existing payment infrastructure, not privileges of this growth process. ERC-8004 identity is not treated as proof of earnings. The Arch/OPC can be campaign segments, not invented software connectors. External discovery/community providers can later implement the same bounded `scout/readme` interface without acquiring send authority.
