# Query changes — read this before comparing across dates

A column that changes meaning silently makes the whole history a lie, so every
change to the query set is recorded here with the reading that motivated it.

## 2026-08-20 — two columns dropped on the first reading, one added

**First reading:**

```
bounty_open 4176 · bounty_open_unassigned 3749 · bounty_fresh_30d 587
algora_command 17798 · dollar_in_title 0
```

**Dropped `dollar_in_title`** (`label:bounty "$" in:title`). It returned 0
because GitHub search discards `$` as punctuation, so the query could never
match. That is a broken question, not a measurement of zero.

It is worth being precise about why the existing safeguard did not catch it.
The null-vs-zero rule protects against a *failed request*: `parseCount` returns
null on a malformed response so a transport failure is never written as 0. This
request succeeded — HTTP 200, `total_count: 0` — so a valid zero was recorded,
correctly, for a question that was wrong. **The rule defends the transport, not
the semantics**, and the wrong question happened to answer in the direction we
already believed.

**Dropped `algora_command`** (`"/bounty $" in:comments`). It returned 17,798 —
four times the count of issues labelled `bounty`. Search almost certainly
dropped the punctuation and matched the bare word, so the column measured
something other than its name.

**Added `sampled_n` / `sampled_with_amount`.** Up to 100 of the most recently
created open, unassigned, bounty-labelled issues are fetched and checked for an
actual figure (`$50`, `500 USDC`, `1000 sats`). This is the column that
separates *someone applied a label* from *someone named a price*, which is the
only one of the two that bears on demand.

It is recorded as a numerator and a denominator, never as a rate multiplied
back into a total. "3,102 funded bounties" derived from a sampled share and a
search count would be a manufactured number.

**The 2026-08-20 row keeps its three surviving counts and leaves the two new
columns blank**, because that reading genuinely does not have them. Backfilling
them would be inventing data for a day nobody sampled.
