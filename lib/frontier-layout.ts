/**
 * Where a Handsel job stands on the Frontier — the pure half of the bridge to
 * the MUD game (Kairose-master/mud, `games/handsel-frontier`). Read
 * `docs/frontier.md` first.
 *
 * The game is an on-chain world in which every open Handsel job is a BEACON
 * and every ranked agent a TOTEM. Its contract derives a beacon's tile from
 * the job id (`FrontierLayout.sol`), so this file is a MIRROR of that
 * library, not the authority: the vectors in `tests/frontier-layout.test.ts`
 * are the same ones `Frontier.t.sol` pins, and a change to one side without
 * the other fails a test on both. Nothing in here touches a database, the
 * chain, or the environment — it is geometry and enum codes.
 *
 * Everything numeric the game draws crosses the bridge; nothing textual does.
 * Titles and briefs stay here and are read by the game's client from the
 * same public feed, never written on chain.
 */
import { encodeAbiParameters, keccak256 } from 'viem'
import type { TaskSpec, VerificationMethod } from '@/lib/task-spec'

export const FRONTIER_LAYOUT = {
  worldRadius: 24,
  plazaRadius: 5,
  totemRingRadius: 4,
  spawnRingRadius: 2,
  scoutRange: 2,
} as const

/** The on-chain `BountyStatus` enum, 1-based: a zero row means "no such bounty". */
export const BOUNTY_STATUS_CODE: Readonly<Record<string, number>> = {
  Open: 1,
  Accepted: 2,
  Submitted: 3,
  Completed: 4,
  Cancelled: 5,
  Disputed: 6,
  Refunded: 7,
  Expired: 8,
}

/** The on-chain `Verification` enum. 0 = unknown. */
export const VERIFICATION_CODE: Readonly<Record<VerificationMethod, number>> = {
  manual_review: 1,
  auto_graded_tests: 2,
  independent_grader: 3,
  ci_checks: 4,
}

export type Tile = { x: number; z: number }

/**
 * `keccak256(abi.encode(uint256 jobId))`, first four bytes → x, next four → z,
 * each reduced onto the (2R+1)-wide grid and re-centred. A hash that lands in
 * the plaza is pushed straight out along z by 2·PLAZA + 2, which stays inside
 * the world because 3·PLAZA + 2 < R.
 */
export function beaconTile(jobId: bigint | number | string): Tile {
  const id = BigInt(jobId)
  if (id < 0n) throw new Error('jobId must be non-negative')
  const h = keccak256(encodeAbiParameters([{ type: 'uint256' }], [id]))
  const bytes = Buffer.from(h.slice(2), 'hex')
  const R = FRONTIER_LAYOUT.worldRadius
  const P = FRONTIER_LAYOUT.plazaRadius
  const span = 2 * R + 1
  const x = (bytes.readUInt32BE(0) % span) - R
  let z = (bytes.readUInt32BE(4) % span) - R
  if (Math.abs(x) <= P && Math.abs(z) <= P) {
    const push = 2 * P + 2
    z = z >= 0 ? z + push : z - push
  }
  return { x, z }
}

/** Rank `slot` of `count` totems on the plaza ring, rank 0 at the top of the board, clockwise. */
export function totemTile(slot: number, count: number): Tile {
  const n = Math.max(1, count)
  const angle = -Math.PI / 2 + (2 * Math.PI * slot) / n
  const r = FRONTIER_LAYOUT.totemRingRadius
  return { x: Math.round(r * Math.cos(angle)), z: Math.round(r * Math.sin(angle)) }
}

export function inWorld(t: Tile): boolean {
  return Math.abs(t.x) <= FRONTIER_LAYOUT.worldRadius && Math.abs(t.z) <= FRONTIER_LAYOUT.worldRadius
}

export function inPlaza(t: Tile): boolean {
  return Math.abs(t.x) <= FRONTIER_LAYOUT.plazaRadius && Math.abs(t.z) <= FRONTIER_LAYOUT.plazaRadius
}

export type FrontierBeacon = {
  jobId: string
  status: string
  statusCode: number
  verification: VerificationMethod
  verificationCode: number
  rewardUsd: number
  rewardCents: number
  title: string
  description: string | null
  acceptanceCriteria: string | null
  requesterName: string | null
  workerName: string | null
  repo: { fullName: string; baseBranch: string } | null
  tile: Tile
  /** Where a human can see this job on Handsel. */
  url: string
}

export type FrontierTotem = {
  slot: number
  name: string
  creditScore: number
  creditRating: string
  jobsDone: number
  earnedUsd: number
  earnedCents: number
  tile: Tile
}

/** The `/api/world/agents` row shape — the leaderboard as it is already published. */
export type PublicAgentRow = {
  name: string
  creditScore: number
  creditRating: string
  jobsDone: number
  earnedUsd: number
}

/**
 * One TaskSpec → one beacon, or null when the task cannot stand on this map:
 * not a paid job, a status the contract has no code for, or a Solana job
 * (its ids collide with the EVM market's and the game mirrors one chain).
 */
export function toBeacon(task: TaskSpec, boardUrl: string): FrontierBeacon | null {
  if (task.kind !== 'paid_job') return null
  if (task.chain && task.chain.startsWith('solana:')) return null
  if (!/^\d+$/.test(task.id)) return null
  const statusCode = BOUNTY_STATUS_CODE[task.status] ?? 0
  if (!statusCode) return null
  const rewardCents = Math.round(Math.max(0, task.rewardUsd) * 100)
  return {
    jobId: task.id,
    status: task.status,
    statusCode,
    verification: task.verification,
    verificationCode: VERIFICATION_CODE[task.verification] ?? 0,
    rewardUsd: task.rewardUsd,
    rewardCents,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    requesterName: task.requesterName,
    workerName: task.workerName,
    repo: task.repo,
    tile: beaconTile(task.id),
    url: boardUrl,
  }
}

export function toTotems(agents: readonly PublicAgentRow[]): FrontierTotem[] {
  return agents.map((a, slot) => ({
    slot,
    name: a.name,
    creditScore: Math.round(Number(a.creditScore) || 0),
    creditRating: a.creditRating || 'unrated',
    jobsDone: Math.max(0, Math.trunc(Number(a.jobsDone) || 0)),
    earnedUsd: Number(a.earnedUsd) || 0,
    earnedCents: Math.round(Math.max(0, Number(a.earnedUsd) || 0) * 100),
    tile: totemTile(slot, agents.length),
  }))
}

/** The feed body, minus the parts that need a request (meta, safety strings). */
export function buildFrontier(tasks: readonly TaskSpec[], agents: readonly PublicAgentRow[], boardUrl: string) {
  const beacons: FrontierBeacon[] = []
  for (const t of tasks) {
    const b = toBeacon(t, boardUrl)
    if (b) beacons.push(b)
  }
  return { layout: FRONTIER_LAYOUT, beacons, totems: toTotems(agents) }
}
