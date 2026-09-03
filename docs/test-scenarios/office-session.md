# Test scenario: an office session, end to end, on your own machine

The scripted form of `docs/office-sessions.md`'s "what the run showed": a
scratch Postgres, the real `next start`, the real `handsel-worker.mjs`, a
real `claude` process, a git fixture whose `add()` subtracts. Nothing is
seeded — the user and agent rows are what sign-up creates — and no chain is
touched: the tasks are internal, so no escrow is posted and no money can
move.

## Prerequisites

- Postgres you can point `DATABASE_URL` at (a scratch cluster; the tables
  self-create) and the schema from `node scripts/migrate.mjs`.
- `claude` on PATH and signed in. Under root, start the worker with
  `--no-preflight` (the one-shot preflight asks for `bypassPermissions`;
  session runs use `acceptEdits` and do not need it).
- No LLM key on the platform is fine: the reviewer answers "unavailable"
  and the default policy sends the task to you instead of passing it.

## Environment

```bash
export DATABASE_URL=postgres://…/handsel_e2e
export API_KEY_ENCRYPTION_SECRET=$(openssl rand -hex 32)
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
export PUBLIC_ORIGIN=http://localhost:3111
export OFFICE_SESSION_HEARTBEAT_TIMEOUT_MS=45000   # prove a crash in a minute, not five
export OFFICE_SESSION_PICKUP_TIMEOUT_MS=45000
```

## The fixture

```bash
mkdir repo && cd repo && git init
cat > package.json <<'EOF'
{ "name": "fixture", "private": true, "type": "module", "scripts": { "test": "node --test" } }
EOF
mkdir lib && printf 'export function add(a, b) {\n  return a - b\n}\n' > lib/math.js
cat > math.test.js <<'EOF'
import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from './lib/math.js'
test('add adds', () => assert.equal(add(2, 3), 5))
EOF
printf '.handsel/\n' > .gitignore && git add -A && git commit -qm fixture
```

## The run

```bash
npx next build && npx next start -p 3111 &                    # the real routes
E="npx tsx scripts/office-session-e2e.ts"
$E setup $PWD/repo "npm test"                                # user, agent, grant → TOKEN=…
node public/handsel-worker.mjs --token <TOKEN> --workdir $PWD/repo --harness claude --no-preflight &
$E start $PWD/repo "math.test.js fails because add() subtracts. Fix add() so npm test passes." default
$E wait <SESSION> 300 completed,waiting_on_approval,failed
$E status <SESSION>          # tasks, runs, checkpoints, approvals, event counts, replay integrity
$E approve <SESSION>         # when it is waiting on you
```

What to check, in order:

1. `git status` in the fixture shows **only** `lib/math.js`; nothing outside
   the workdir changed.
2. `status` lists a `diff`, a `deliverable` and a `test_report` artifact by
   sha256, and the task's `tests=pass`.
3. Under the default policy the approval is `REQUIRE_OWNER` (no reviewer),
   and nothing settles until `approve`. Pass `lenient` to `start` instead
   and the same task settles by policy (`ALLOW_WITH_LOG`) with nobody
   clicking.
4. `integrity: replay matches materialized state`.

## The crash

Start a session, wait for the first `CHECKPOINT_CREATED` in
`office_session_event` (it lands seconds after the first edit), `kill -9`
the worker, wait past the heartbeat timeout, tick, restart the worker, wait.
Expect: run 1 `timed_out`, run 2 `finished` with `resumedFrom=<checkpoint>`,
`attempts=2`, **one** `TASK_SETTLED`, and `git status` still showing one
file. The transcript of exactly this is in `docs/office-sessions.md`.
