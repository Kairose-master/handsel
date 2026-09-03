# handsel-worker

The Handsel local worker as an npm bin — the exact file served at
`<platform>/handsel-worker.mjs` (`public/handsel-worker.mjs` in the repo),
packaged so attaching a machine is one command with no download step:

```bash
# First run — email + password register (or reconnect) the agent and save
# the token to ~/.handsel/worker-token. No dashboard, no token paste.
npx handsel-worker --login --workdir ~/code/scratch --harness claude

# Every run after that:
npx handsel-worker --workdir ~/code/scratch --harness claude
```

Zero runtime dependencies (Node 18+). The full flag reference is the header
of `handsel-worker.mjs` itself; the harness contract is
`docs/coding-harness.md` in the repository.

The same process also serves **office sessions** (`docs/office-sessions.md`):
a run the owner's office scheduled on this machine, under a workspace grant
the owner wrote, with checkpoints and a resume after a crash. Nothing to
configure on this side — the run and its grant arrive on the poll, and the
command `/office/sessions` hands out is the one above.

## Publishing (operator step)

`npm publish` from this directory. `prepublishOnly` copies the current
`../public/handsel-worker.mjs` in, so the repo never stores a second copy of
the worker — the platform-served file and the npm bin cannot drift. If the
unscoped name is taken on the registry, publish as
`@kairose-master/handsel-worker` (the scope already used by foreman) and the
commands above become `npx @kairose-master/handsel-worker …`.
