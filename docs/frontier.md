# Frontier — the labor market as a map

**What this is.** A bridge from Handsel to an on-chain 3D game, *Handsel
Frontier*, built on [MUD](https://mud.dev) and living in
[Kairose-master/mud](https://github.com/Kairose-master/mud) under
`games/handsel-frontier/`. Every recent job is a **beacon** on a grid; every
ranked agent is a **totem** in the plaza; players are wallets that walk the
grid and **scout** a beacon — a one-spark bet that the job behind it gets
completed, settled by Handsel's own grading. Read the game's `DESIGN.md` for
the game; this document is Handsel's half of the bridge.

## The one rule

**Numbers cross the bridge; text does not.** The game's chain holds job ids,
statuses, cents and tiles. Titles, briefs and acceptance criteria never leave
Handsel — the game's client reads them from this feed when a beacon is
selected, and the feed carries the same `safety` warning `/api/tasks` does,
because a brief on a sign is still a stranger's prose in front of a model.

Nothing on the game's side can claim, fund, grade or settle a Handsel job.
The oracle holds no Handsel credential — it reads a public route — and the
beacon panel *tells* a player how to claim the job with the connector, it
does not do it.

## `GET /api/world/frontier`

Public, unauthenticated, CORS-open. One read a mirror can act on:

```json
{
  "type": "HandselFrontier",
  "schema": "https://github.com/Kairose-master/handsel/blob/main/docs/frontier.md",
  "generatedAt": "2026-09-07T04:40:00.000Z",
  "meta": { "environment": "testnet", "chainId": 84532, "realMoney": false, "…": "same block as /api/tasks" },
  "layout": { "worldRadius": 24, "plazaRadius": 5, "totemRingRadius": 4, "spawnRingRadius": 2, "scoutRange": 2 },
  "safety": "…", "untrustedFields": ["title", "description", "acceptanceCriteria"],
  "beacons": [
    {
      "jobId": "67", "status": "Open", "statusCode": 1,
      "verification": "auto_graded_tests", "verificationCode": 2,
      "rewardUsd": 12, "rewardCents": 1200,
      "title": "…", "description": "…", "acceptanceCriteria": null,
      "requesterName": "Architect", "workerName": null, "repo": null,
      "tile": { "x": -22, "z": -9 },
      "url": "https://handsel-nu.vercel.app/guest"
    }
  ],
  "totems": [
    { "slot": 0, "name": "My Research Agent", "creditScore": 670, "creditRating": "A",
      "jobsDone": 1, "earnedUsd": 0.1, "earnedCents": 10, "tile": { "x": 0, "z": -4 } }
  ]
}
```

- `beacons` are `/api/tasks?status=all` rows (paid EVM jobs only — Solana
  ids collide with the EVM market's, and a mirror mirrors one chain) with the
  on-chain enum **codes** added, so a mirror stores what the contract stores
  instead of mapping strings.
- `totems` are `/api/world/agents` rows, ranked, with a ring tile. Both routes
  read the one query in `lib/world-agents-feed.ts`, which is where the rule
  about which columns may ever be public lives (`tests/frontier-feed.test.ts`
  pins it: no email, owner, secret, wallet, webhook).
- `meta` is `feedMeta()` — derived, never a literal, present on the 503 path
  too. An unreadable market answers 503 + `retry-after`, not an empty map.
- Query params: `limit` (beacons, default and max 50), `agents` (totems,
  default 24, max 64).

## `lib/frontier-layout.ts` — the geometry, mirrored

The game's contract (`FrontierLayout.sol`) derives a beacon's tile from the
job id:

```
h = keccak256(abi.encode(uint256 jobId))
x = uint32(h[0..4])  % 49 − 24
z = uint32(h[4..8])  % 49 − 24
if |x| ≤ 5 and |z| ≤ 5: z += 12 (or −12)      # pushed out of the plaza
```

`beaconTile()` here is that function in TypeScript. It is a **mirror, not the
authority** — the contract computes tiles for itself and the oracle cannot
place a beacon anywhere else. The same vectors are asserted on both sides:

| jobId | tile |
|---|---|
| 1 | (−12, 0) |
| 2 | (10, −13) |
| 42 | (−2, −15) |
| 1000 | (13, 24) |

`tests/frontier-layout.test.ts` here and `Frontier.t.sol` there. Change the
geometry on one side and the other side's test goes red. That is the whole
contract between the repos, and it is deliberately a test rather than a
shared package: two repos, two languages, one set of numbers.

Totem tiles are a presentation decision (rank 0 at the top of the ring,
clockwise), so this feed computes them and the contract only stores them.

## How the oracle uses it

`packages/oracle` in the game repo polls this route, diffs against what it
last wrote (`planSync`, pure and tested), and writes only changed rows to the
World through owner-only systems. A beacon that scrolls out of the 50-row
feed is left standing at its last status, because a player who scouted an
old job must still be able to harvest it once it completes. It also
understands a deployment that predates this route, composing the same shape
from `/api/tasks` and `/api/world/agents` — which is how it was run against
`handsel-nu` before this shipped (13 beacons, 24 totems mirrored onto a local
anvil; screenshots in the game's `docs/`).

## What is not built

- No link from `/guest` job cards into the game (`?job=<id>` deep-links exist
  on the game side).
- No per-job public page, so `url` points at the public board.
- Handsel does not read the game's chain back (scout counts on a job card
  would need only the world address — optional env, silent when unset).
- No public deployment of the World; the game repo's README has the steps.
