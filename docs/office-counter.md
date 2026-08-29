# The counter — plain-language instructions, and a default agent to carry them

Two customer-facing surfaces this office has — the Mail Desk and an agent
answering a message by itself — used to speak in one of two voices: a fixed
template nobody could adjust without editing code, or the model's own
untuned judgment. Neither is "the owner's voice." The counter is the fix.

```
lib/office-counter.ts          instructions, the prompt preamble, greeting cleanup   (pure, tested)
lib/office-counter-server.ts   the office_counter table + the agent it provisions
```

On `/office`, per slot. Over the connector: `set_counter_instructions`.

## The default, not an extra step

"기본으로 두고" — make it the default — is the whole design constraint. There
is no separate "hire a counter" action. The first time an owner saves
instructions for an office that has none, `setCounterInstructions`:

1. creates a real agent named `"<office> Counter"`,
2. puts it on the office roster (`role_id = 'counter'`),
3. gives it its own key, and
4. turns its **auto-reply on** (`lib/agent-reply-server.ts`'s `setAutoReplyFlag`).

No smart account is provisioned — a counter never escrows, never claims a
job, it only talks, so it needs none of what `office-hire.ts`'s role
provisioning exists for. Saving is instant, with no chain dependency.

## Live, not frozen

`office_source` ("one document every role reads") is a **work brief**,
injected at hire time and deliberately frozen after: "a brief that changed
under a posted job would move the target its worker is graded against."
Counter instructions are the opposite — a policy that must apply to the very
next reply. Reusing `office_source`'s storage would either freeze a policy an
owner just tried to fix, or let a work brief drift under a graded job. Hence
a dedicated table, read fresh on every use, not injected once at a fixed
moment.

Not an `agent` column either, for the same reason `agent_auto_reply` isn't
one (`lib/agent-reply-server.ts`'s header): drizzle's `select()` names every
column of a table, so a new one breaks every read of `agent` from the moment
the code deploys until a manual `/api/admin/migrate` runs — and deploys here
are automatic while migrations are not.

## Where it lands

- **The counter agent's own auto-reply.** `buildReplyPrompt` (the same
  engine every auto-reply agent uses) folds the instructions in via
  `buildCounterPreamble` when the recipient is a designated counter. Nothing
  else about the reply path changes — same depth cap, same daily/per-sender
  caps, same `info`-only, question-only rules.
- **The Mail Desk's catalogue reply.** When an inbound email isn't clearly an
  order, `replyCatalogue` composes one short LLM greeting from the serving
  office's instructions and the actual inbound subject/text, placed **above**
  the fixed catalogue and pricing lines — never inside or in place of them.
  Only for the plain "hello, what do you do" case; the desk's operational
  status lines (full, not provisioned, template closed) stay untouched,
  unambiguous system notices.

Every failure — no LLM resolvable, the lookup throws, the office can't be
found — degrades to no greeting, never to a thrown error. A customer-facing
email must still go out.

## What it can't do

`buildCounterPreamble` states the same boundary in both places it's used:
instructions shape **tone and policy only**. They cannot authorize moving
money, escrowing a job, or accepting one — only the owner's own explicit
action does that (`confirm_delegation`, `claim_job`) — and they don't entitle
the counter to promise something the office cannot actually deliver.

## Trust direction

The instructions are **owner-authored** — the same trust class as
`agent.customInstructions` or `office_source`'s document — so they are never
fenced as hostile input the way a customer's own email is
(`lib/untrusted-input.ts`). Getting this backwards either way is its own bug:
fencing the owner's own policy would make the model treat its instructions as
suspect; failing to fence a stranger's email would let their prose double as
policy.

## Bounds

4,000 characters of instructions (`MAX_COUNTER_INSTRUCTIONS_CHARS`) · 600
characters per composed greeting, above and separate from the reply-body
limit the agent's own auto-reply already enforces.
