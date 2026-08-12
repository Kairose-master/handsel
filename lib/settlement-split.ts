/**
 * Multi-party settlement splits — increment 3 of the machine lane
 * (`docs/physical-operatorship.md`): one job's proceeds divided among a
 * split table (capability author / machine owner / location holder / …)
 * instead of all landing on the worker.
 *
 * The on-chain contract is immutable and pays the WORKER in full — that
 * does not change. A split is applied AFTER settlement: the platform,
 * which already signs UserOperations for agent smart accounts, transfers
 * each recipient's share out of the worker agent's account. The pure half
 * (this file) decides who gets how much; the IO half
 * (`lib/settlement-split-apply.ts`) moves it and records what happened.
 *
 * Arithmetic rule, same as every split in the booth: each recipient's
 * share is FLOORED to the cent and the worker keeps the remainder, so the
 * allocations can never sum past the settled amount.
 */

export interface SplitRecipient {
  /** What this share is for — 'author', 'machine_owner', 'location', … */
  role: string
  /** Exactly one of agentId (resolved to its smart account at pay time)
   *  or a raw EVM address. */
  agentId?: string
  address?: string
  bps: number
}

export interface SplitSpec {
  recipients: SplitRecipient[]
}

const MAX_RECIPIENTS = 8
const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v)

/** Validate an untrusted split payload (it arrives over the x402 external
 *  route). Returns the normalized spec or a human-readable refusal. */
export function parseSplitSpec(raw: unknown): { ok: true; spec: SplitSpec } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: false, error: 'split is empty' }
  const recipients = (raw as { recipients?: unknown }).recipients
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > MAX_RECIPIENTS) {
    return { ok: false, error: `split.recipients must be an array of 1–${MAX_RECIPIENTS}` }
  }
  const out: SplitRecipient[] = []
  let totalBps = 0
  for (const entry of recipients as Array<Record<string, unknown>>) {
    const role = String(entry.role ?? '').trim()
    if (role.length < 1 || role.length > 24) return { ok: false, error: 'each split role must be 1–24 characters' }
    const agentId = entry.agentId === undefined ? undefined : String(entry.agentId).trim()
    const address = entry.address === undefined ? undefined : String(entry.address).trim()
    if ((agentId ? 1 : 0) + (address ? 1 : 0) !== 1) {
      return { ok: false, error: `split role "${role}" must name exactly one of agentId or address` }
    }
    if (address && !isAddress(address)) return { ok: false, error: `split role "${role}" has an invalid address` }
    const bps = Number(entry.bps)
    if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) {
      return { ok: false, error: `split role "${role}" bps must be an integer 1–10000` }
    }
    totalBps += bps
    out.push({ role, ...(agentId ? { agentId } : {}), ...(address ? { address } : {}), bps })
  }
  if (totalBps > 10_000) return { ok: false, error: `split bps sum to ${totalBps} — the maximum is 10000` }
  return { ok: true, spec: { recipients: out } }
}

export interface SplitAllocation {
  role: string
  agentId?: string
  address?: string
  amountUsd: number
}

/**
 * Divide a settled bounty. Shares are floored to the cent; the worker
 * keeps everything not allocated — including every rounding remainder —
 * so `sum(allocations) + workerKeepsUsd === amountUsd` exactly (in cents).
 * Allocations that floor to $0.00 are dropped: a zero transfer spends
 * sponsored gas to move nothing.
 */
export function computeSplit(
  amountUsd: number,
  spec: SplitSpec | null,
): { allocations: SplitAllocation[]; workerKeepsUsd: number } {
  const totalCents = Math.floor(amountUsd * 100)
  if (!spec || totalCents <= 0) return { allocations: [], workerKeepsUsd: totalCents / 100 }

  const allocations: SplitAllocation[] = []
  let allocatedCents = 0
  for (const r of spec.recipients) {
    const cents = Math.floor((totalCents * r.bps) / 10_000)
    if (cents < 1) continue
    allocatedCents += cents
    allocations.push({
      role: r.role,
      ...(r.agentId ? { agentId: r.agentId } : {}),
      ...(r.address ? { address: r.address } : {}),
      amountUsd: cents / 100,
    })
  }
  return { allocations, workerKeepsUsd: (totalCents - allocatedCents) / 100 }
}
