---
name: parallel-repo-coordination
description: "Conflict prevention when several agents or people work one git repository at the same time with no shared memory. A note file in the repo (conversation.md) plus a gate that refuses to commit or push until this working copy has read what changed. Use whenever you start work in a repo that may have other sessions active, before rewiring anything another session may be running, before landing a change that touches shared files, and when a merge conflict or a stranger's commit shows up in your pull. Triggers: conversation.md, another session, parallel work, merge conflict, live round, do not touch, who else is working here, coordination note, ack."
license: MIT
---

# Parallel work in one repository

Several sessions push to one remote. They share no memory and no message bus.
The only channel is the repository itself. This skill is how that channel is
used so that two sessions do not undo each other's work, and so that a
warning actually reaches the session it is meant for.

It was extracted from the Handsel repo, where the naive version failed in a
measurable way: a specific, correct, timely note sat unread for eleven minutes
with its own filename on screen in a merge diffstat, and the reader shipped a
defect the note described. The lesson is in `docs/agent-coordination.md` there.
The short version is that **a note that depends on being voluntarily read is
ignored by exactly the agent that most needs it.** So this skill is a protocol
*and* a gate. The gate is the part that works.

## The two parts

1. **`conversation.md`** at the repo root. Append-only in spirit. Each section
   is one session saying what another session could trip over.
2. **`scripts/coordination-check.mjs`** (in this skill's directory). It refuses
   with exit 1 until the note has been read *in this working copy*, printing
   only the lines that are new since the last acknowledgement. The
   acknowledgement lives in `.git/`, never in the repo, so a fresh clone is a
   fresh agent and nobody can acknowledge on someone else's behalf.

```
node .claude/skills/parallel-repo-coordination/scripts/coordination-check.mjs            # gate
node .claude/skills/parallel-repo-coordination/scripts/coordination-check.mjs --ack      # I read it
node .claude/skills/parallel-repo-coordination/scripts/coordination-check.mjs --note "…" # leave a note (also acks)
node .claude/skills/parallel-repo-coordination/scripts/coordination-check.mjs --install-hook  # pre-push refuses until acked
NOTE_FILE=docs/COORDINATION.md node …/coordination-check.mjs                              # different file name
```

Wire the gate into whatever the repo already cannot skip. In Handsel it is
`npm run gates` (typecheck → lint → test → build), which runs the check first.
A check that is run separately gets skipped; a check inside the one command
everybody has to run does not.

## The protocol

**On starting work in a repo**

1. `git pull`, then run the check. If it refuses, read the whole file, not the
   printed diff. Then `--ack`.
2. Ask: is anything in there *live*? A running worker, a delegation mid-round,
   a deploy in flight, a process polling a secret that rotates on rewire.
   Live things are the ones you can kill from a distance. Do not touch them.
3. If you are about to do something that another session could trip over,
   write the note **before** you do it, not after. Commit the note with the
   work, so it arrives on their next pull.

**What goes in a note** (one section, dated, branch-stamped — `--note` does the
stamping):

- What is running right now and until when. Identifiers, not descriptions:
  the delegation id, the agent id, the PID's purpose, the port.
- What must not be touched and *why* — the failure mode, in one sentence.
  "Rewiring the Architect rotates its worker secret and kills the live
  round's auth" is a note. "Please don't change agents" is not.
- What you landed today that touches shared surfaces, with commit hashes.
- Anything you found wrong in someone else's commit. Fix it if it is yours to
  fix, but say so either way.

**What does not go in a note**: plans, opinions about architecture, anything
that belongs in a doc or a commit message. The file is a warning channel; if
it fills with prose the gate becomes wallpaper, and wallpaper is the defect it
was built to fix wearing a uniform. Whitespace-only edits do not trigger the
gate for the same reason.

**Replying**: append a `### 회신 — …` / `### Reply — …` subsection under the
note you are answering. Say what you did about each point. A reply that says
"received, will not touch X until Y" is worth writing — it is the only way the
other session learns the note landed.

**Before landing a change**

1. Run the check again (the other session may have written while you worked).
2. `git pull`. If `conversation.md` conflicts, keep both sides — it is the one
   file both sessions write, so it is the one place a conflict is guaranteed,
   and it is never a real conflict. Never resolve it by dropping a section.
3. If real code conflicts, the merge told you where the two sessions overlap.
   Read the other side's section in the note before choosing; if it is about
   something live, theirs wins and you adapt.

**Claiming an area** is a note like any other: "Working `lib/office-*.ts` on
branch `X` until ~HH:MM; touching the roster shape." It is not a lock. Git
merge semantics are the lock; the note is so the other session can choose not
to start the same refactor.

## Why git and not a lock service

Three properties of the substrate, none of which needed building:

- **Merge semantics are conflict detection.** Different files merge silently;
  the same lines refuse loudly. That is the whole coordination primitive.
- **Commit messages survive context compaction.** A session that loses its
  transcript recovers from the log. Long commit messages are not decoration.
- **The note travels with the code.** It arrives exactly when the code it
  warns about arrives, on the same pull, and it is versioned with it.

## Installing in a new repo

1. Copy this skill directory into `.claude/skills/`.
2. `node .claude/skills/parallel-repo-coordination/scripts/coordination-check.mjs --note "…"`
   creates `conversation.md` with a header on first use.
3. Put the check first in the repo's gate command (`"gates": "node …/coordination-check.mjs && …"`),
   and/or `--install-hook` for a per-clone pre-push guard.
4. Mention the file in the repo's `CLAUDE.md` in one line — the line is not
   what makes it work, the gate is, but the line tells a reader where to look.
