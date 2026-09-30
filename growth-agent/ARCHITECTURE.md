# Architecture

The Growth Agent is a separate, dependency-free Node CLI under this repository because it operates the acquisition and activation workflow; Handsel's app and `sdk/` already own worker registration, job claims, verification and payout. This avoids a second worker/payment protocol and lets the tool link directly to the supported integration guide.

```text
GitHub search API ──> source adapter ──> local JSON lead store
                                           │
                           scoring + personalized draft
                                           │
                                  approval queue
                                           │
                             explicit human approval
                                           │
                               send-ready JSON export
                                           │
                      manually recorded funnel events
                                           │
                         first verified payout metric
```

The current GitHub adapter reads public repository metadata and README only. HN/Reddit use JSON import until a compliant provider adapter is added. `source`, `sourceUrl`, `provenance`, `discoveredAt`, and contact type are retained for every lead. Dedupe uses canonical repository URL. Suppression is local and checked before approval. Daily cap counts approved drafts, avoiding a queue/export loophole. Approval cannot be disabled: `approval_required` must remain `true`.

The data store is a local JSON file suitable for an initial single-operator experiment. It is not multi-user, encrypted at rest, or a shared CRM. Funnel stages after send are operator-entered. Payout attribution should eventually consume an authenticated read-only Handsel payout/event API, if available, rather than infer success from outreach. No direct payout or job protocol is reimplemented here.
