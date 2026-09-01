# Agents working one repo at the same time

Handsel is built by several Claude sessions running concurrently against one
git remote. That arrangement produced a result on 2026-09-01 worth writing
down, mostly because the interesting half is negative.

This is a process document. Nothing here ships to a user.

## The event

Two sessions, same repo, no shared memory and no message bus between them —
only the remote.

| | |
|---|---|
| 08:10 | The office-harness session pushes a note to `conversation.md`: a live round is running, `dlg-BmPa9XOZIt`, with a local worker polling every 3s. Do not rewire the Architect agent — `connect_local_worker` rotates the worker secret and would kill its auth mid-round. |
| 08:27 | This session ships harness preflight. It runs the harness once at startup, in `--workdir`, to prove it can run before a bond is staked. |
| 08:34 | This session pulls. The merge diffstat prints `conversation.md \| 20 ++++++++++++++++++++`. That line is read. The file is not. |
| 08:34 | This session pushes and reports the work complete. |
| 08:45 | The owner says: "read conversation.md". |
| 08:52 | Reading it surfaces a defect in the 08:27 commit. Every harness adapter passes its harness's auto-approval flag, so preflight was aiming a tool that can edit and run anything at the owner's checkout, during a readiness check, before any job had been claimed. Fixed by probing in a `mkdtemp` directory. |

Nothing about the channel failed. The note was specific, correct, timely, and
about code that had landed seven minutes earlier. It sat in the working tree
for eleven minutes with its own filename on screen.

## What that is evidence for

**A coordination artifact that depends on being voluntarily read is ignored by
exactly the agent that most needs it.** An agent mid-task is optimising for
that task, and an unfamiliar file in a merge diffstat reads as somebody else's
business. The failure is not carelessness that better instructions would fix —
the instruction to read repo docs was already in `CLAUDE.md` and had been
followed all session for `docs/product-thesis.md`, `docs/failure-modes.md` and
`docs/security-audit.md`. Those were *pulled* when a task needed them.
`conversation.md` had to be *pushed*, and nothing pushed it.

So the bottleneck in multi-agent work here was not the channel. It was
attention.

The fix, therefore, is not a better note or a firmer rule. It is to stop asking:
`npm run gates` now refuses while `conversation.md` has unacknowledged changes
and prints the new lines (`scripts/conversation-check.mjs`,
`lib/conversation-notes.ts`). The acknowledgement lives in `.git/`, so it is
per working copy — a fresh clone is a fresh agent — and is never committed, so
no one can acknowledge on another session's behalf.

That design has an obvious risk and it is the interesting one: a gate that
fires often becomes wallpaper, and wallpaper is the defect it was built to fix
wearing a uniform. Hence only *changed* text blocks, only the *new* lines are
printed, and whitespace-only edits pass — acknowledging a note that did not
change is the exact habit that would kill it.

## What is worth studying, and what is not

**Not novel.** Multi-agent coordination generally, and file-based blackboards
specifically — Hearsay-II was doing this in 1975. "Agents collaborating is
good" is a premise, not a finding, and the evidence above cuts against the
naive version of it.

**Underexplored: git as the coordination substrate.** Three properties this
repo leans on, none of which needed building:

1. **Merge semantics are conflict detection.** There is no lock, no lease, no
   protocol. Two sessions diverged three times on 2026-09-01 and `git merge`
   resolved all three, because the work was in different files — and would
   have said so loudly if it had not been.

   It then said so loudly, on the fourth. Pushing the commit that added this
   document collided with the other session appending to `conversation.md` at
   the same time: `CONFLICT (content): Merge conflict in conversation.md`. The
   coordination file is the one file both sessions write, so it is the one
   place this is guaranteed to happen — which is an argument for the mechanism,
   not against it. Both notes were kept; no protocol was consulted; nothing was
   lost.
2. **Commit messages are the memory that survives context compaction.** This
   session's context was compacted mid-work. What restored it was not a
   transcript: it was `docs/failure-modes.md`, `docs/product-thesis.md`, and
   the commit log. The unusually long commit messages in this repo are not
   decoration, and that is a falsifiable claim — strip them and measure how
   much re-derivation a compacted session has to do.
3. **A doc's last-verified date is a cheap staleness signal.** `docs/ecosystem-watch.md`
   and `docs/interop-outreach.md` already work this way for external specs;
   the same shape works for internal claims.

**The open question.** Given that voluntary reading fails, which mechanisms
actually get an agent's attention, and at what annoyance cost? Four candidates,
ranked by how hard they are to ignore, all testable in this repo:

| Mechanism | Ignorable? | Cost |
|---|---|---|
| A rule in `CLAUDE.md` | Yes — demonstrated above | Free |
| A note in a pulled file | Yes — demonstrated above | Free |
| A `SessionStart` hook injecting the note | Hard | Fires every session, including irrelevant ones |
| **A failing gate** (chosen) | No — blocks the commit | Fires only on change; risks wallpaper |

## The other measurable claim: run it, do not reason about it

Four defects on 2026-09-01, none of which reasoning caught and all of which
running caught:

- `lib/mp4-probe.ts` read `tkhd` (display size) where it needed `stsd` (coded
  size), and failed a *correct* 720×1280 render. Found by doing a real crop and
  cross-checking `ffprobe`.
- Making "no `{brief}` and no `--harness-stdin`" fatal broke every pre-existing
  `--harness-cmd`, including the one `connect_local_worker` prints by name.
  Found by pasting that exact command and watching it exit 1.
- `quoteAdvance` carried a `cappedByBounty` flag for the UI to branch on. A
  test showed the state is unreachable: `LTV_MAX × (1 + feeRate(LTV_MAX))` is
  0.918, so the bounty cap never binds. The flag was removed and the invariant
  pinned instead.
- Preflight probing in `--workdir` — above. **No unit test would have caught
  this one.** The defect was not in the logic; it was in what the logic was
  pointed at.

The last one is the argument for both halves of this document at once. It was
a contextual defect, invisible to the test suite, and it surfaced only because
another agent described its own context and something finally made this one
read it.
