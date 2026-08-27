# The instruments of a trade

Handsel collapses a whole commercial sequence into four verbs — post, accept,
submit, settle. That is enough to move money and not enough to say what
happened.

Real commerce does not work in verbs. It works in **instruments**, each with
an issuer, a recipient, and an effect the other party can rely on. An order is
not a request. An acknowledgement is not a delivery. An inspection certificate
is not an invoice. A credit note is not a refusal to pay.

`lib/trade-instruments.ts` is that table. It writes nothing: every instrument
is a name for a fact that already exists on-chain or in `job_specs`, in the
same way `lib/agent-contract.ts` is a projection of the agreement.

## By type and route

| Instrument | From → To | Binds | Moves value | Valid in | Advances to |
|---|---|---|---|---|---|
| Request for quote | buyer → market | neither | — | draft | — |
| Quotation | seller → buyer | issuer | — | draft | — |
| Award | buyer → seller | neither | — | draft, Open | — |
| Purchase order | buyer → seller | issuer | ✔ | draft | Open |
| Order acknowledgement | seller → buyer | issuer | ✔ | Open | Accepted |
| Delivery note | seller → buyer | issuer | — | Accepted | Submitted |
| Inspection certificate | verifier → market | **neither** | — | Submitted, Disputed | — |
| Invoice | seller → buyer | issuer | — | Submitted | — |
| Settlement receipt | escrow → market | both | ✔ | Submitted, Disputed | Completed |
| Credit note | escrow → buyer | both | ✔ | Open, Accepted, Submitted, Disputed | Refunded |
| Notice of dispute | buyer → arbiter | neither | — | Submitted | Disputed |

Three properties are doing real work here.

**The route.** `inspection` runs *from someone who is neither party*, and that
is the entire value of the verdict. When the same fact is only "the grader
wrote a row", the property is invisible and nothing checks it. `hasStanding()`
is the check: an inspection from the buyer is not an inspection.

**Binding, separately from a state change.** An `order` commits the buyer's
money while the seller has promised nothing — which is exactly why
`acknowledgement` is a separate instrument and not a formality. An
`inspection` binds nobody: it is evidence, and evidence that moved escrow by
existing would be a verdict its subject could have authored. That reasoning is
already in `lib/dispute-policy.ts`; this states it in the type.

**Which documents move money.** Four of eleven. `acknowledgement` is one of
them even though nothing is paid, because accepting stakes the seller's own
bond (`lib/agent-bond.ts`). A trade layer that called that free would let a
worker commit money it does not have — which is the `TransferFailed()` class
of defect from `docs/failure-modes.md` §30.

## What Handsel does not issue

Naming the instruments makes the missing ones readable rather than
theoretical. `missingInstruments()` returns three:

- **`rfq`** — there is no request phase. A job is posted *already escrowed*,
  so a buyer cannot ask what something costs before committing money.
- **`quote`** — there is no seller-side offer. Prices are set by the buyer
  alone, which is why a capability cannot be listed for sale by the office
  that provides it. This is the gap an inter-office market has to close first.
- **`invoice`** — amounts are fixed at order time and never restated by the
  seller, so there is nothing to reconcile against and no way to bill for less
  than was escrowed.

And one that exists but is weaker than its name:

- **`award`** — `reserveJobForAgent` records who work was meant for, but as
  claim *priority* with a window. A desk lost four assigned reads to a
  stranger once that window lapsed (§31). The eligibility-gated clock fixed
  the symptom; the award is still not a durable record of the assignment.

## Capabilities that act on the world

Every instrument above was written for **reversible** work without saying so.
`credit_note` is valid from four states and reads as making the buyer whole —
true when the deliverable is text, false the moment a capability sends an
email, updates a CRM, or acts in someone else's system.

> Escrow protects the payment. It does not protect the thing the payment was
> protecting.

If a seller sends 500 outreach emails and the verifier returns FAIL, the buyer
gets its money back and the emails are still in strangers' inboxes. This is
the same property `lib/normative-transport.ts` calls **indexical**: the act
happened, to that recipient, at that time, and no later instrument reverses
it.

`admissibleRoute(effect)` states the consequence:

| Effect class | Ordinary route | Because |
|---|---|---|
| `observational` | ✔ | Reads only; a refund fully restores the buyer |
| `reversible` | ✔ | Effects are undoable here, so escrow bounds exposure |
| `irreversible` | ✖ | A credit note returns the money and not the world |

The fix is not a better verifier. It is to **move the inspection in front of
the act**: the deliverable becomes a plan, the plan is inspected, and the
buyer issues `authorisation` before anything executes.

`authorisation` runs buyer → seller, binds the **issuer**, moves no value, and
is issuable only in `Submitted` — against a delivered plan, never before one,
because authorising earlier is a blank cheque. It sits alongside `inspection`
rather than replacing it: an independent party reviews the plan, and the buyer
then decides. Collapsing the two would let a buyer authorise unreviewed work,
or a verifier commit the buyer.

Nothing produces it yet, because no Handsel capability acts on the world yet.
That is the order this has to happen in — the instrument before the
integration, not after.

## Verifier independence

The design doc asks for `independencePolicy: "not-buyer-or-seller"` inside the
proof envelope. A policy the issuer writes about itself is a claim, not a
guarantee. `verifierIndependence()` asks the checkable version instead: does
the verifier's economic controller differ from both parties'?

It returns `'unknown'` today, and that is the honest answer — Handsel has an
agent's wallet and its `userId` and **no Agent ↔ Operator ↔ Organization
relation**. It never returns `'independent'` on missing evidence. Supplying
`controllerOf` is what the identity layer is for, and this function is the
consumer that will make it matter.

## Reading the route from a contract

`AgentContract.route` carries it, so a counterparty gets one answer rather
than re-deriving the rules:

```json
"route": {
  "state": "Accepted",
  "issuable": ["delivery", "credit_note"],
  "movesValue": ["credit_note"],
  "terminal": false
}
```

`terminal: true` on `Completed` / `Cancelled` / `Expired` means nothing
legitimate can be issued — an instrument that could would be a way to restate
a closed trade.
