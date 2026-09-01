import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 권한레벨 vs 공개레벨 — the split between "who may claim" and "who may see".
 *
 * The rule (`officeJobVisible`, tested in tests/office.test.ts) existed for
 * months while every office pipeline's briefs sat fully public on the market
 * board: only reviewOf steps carried `officeOnly`, and only the listing was
 * filtered — get_job, get_contract and the claim paths handed the brief to
 * anyone with a job number. Same defect class as real-money-wiring.test.ts:
 * the logic was correct and unreachable.
 *
 * So this pins the WIRING, not the rule:
 *  - every office-hire step is scoped at the source (officeOnly: true),
 *  - delegation stores the scope for any server-set officeOnly step (the
 *    planner LLM stays restricted to reviewOf — it must not be able to hide
 *    market work),
 *  - both accept paths refuse a claim from outside the office circle,
 *  - both MCP read tools (get_job, get_contract) redact the brief,
 *  - the /world open-jobs board filters like every other listing.
 *
 * Source assertions because the call sites read the chain and the DB at
 * module load; what can be checked without an environment is checked as code.
 */

const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

describe('office pipelines are scoped at the source', () => {
  it('office-hire marks every step officeOnly', () => {
    const src = code('lib/office-hire.ts')
    expect(src).toContain('officeOnly: true')
  })

  it('delegation stores officeOwnerId for ANY officeOnly step, not just reviews', () => {
    const src = code('lib/delegation.ts')
    // The insert must key on officeOnly alone. The old condition
    // (`st.reviewOf && st.officeOnly`) silently dropped the scope from every
    // non-review pipeline step — that was the leak.
    expect(src).toContain('officeOwnerId: st.officeOnly ? ownerId : null')
    expect(src).not.toContain('st.reviewOf && st.officeOnly ? ownerId')
  })

  it('the planner LLM can still only scope reviewOf steps (no hiding market work)', () => {
    const src = code('lib/delegation.ts')
    expect(src).toContain("const officeOnly = reviewOf && raw?.officeOnly === true")
  })
})

describe('claim permission — both accept paths refuse outside the circle', () => {
  it('acceptAndDispatchJob and acceptJobForExternalWorker both gate on canSeeOfficeOnlyJob', () => {
    const src = code('lib/labor-dispatch.ts')
    const dispatchBody = src.slice(src.indexOf('export async function acceptAndDispatchJob'), src.indexOf('export async function acceptJobForExternalWorker'))
    const externalBody = src.slice(src.indexOf('export async function acceptJobForExternalWorker'))
    for (const body of [dispatchBody, externalBody]) {
      expect(body).toContain('canSeeOfficeOnlyJob')
      expect(body).toContain('scoped to its office')
      // The gate must sit before the on-chain accept, so a refusal spends no
      // gas and stakes no bond.
      expect(body.indexOf('canSeeOfficeOnlyJob')).toBeLessThan(body.indexOf('acceptJob(worker.id'))
    }
  })
})

describe('visibility — reads redact, listings filter', () => {
  it('MCP get_job and get_contract both check the office scope', () => {
    const src = code('lib/mcp/handlers/jobs.ts')
    // browse_open_jobs + get_contract + get_job — three call sites, one rule.
    const gates = src.split('canSeeOfficeOnlyJob').length - 1
    expect(gates).toBeGreaterThanOrEqual(4) // ≥2 per gated case (import + call)
    const contractCase = src.slice(src.indexOf("case 'get_contract'"), src.indexOf("case 'get_job'"))
    expect(contractCase).toContain('canSeeOfficeOnlyJob')
    const jobCase = src.slice(src.indexOf("case 'get_job'"))
    expect(jobCase).toContain('canSeeOfficeOnlyJob')
  })

  it('the /world open-jobs board filters office-scoped jobs', () => {
    const src = code('app/actions/world.ts')
    expect(src).toContain('canSeeOfficeOnlyJob')
    expect(src).toContain('officeOwnerId: jobSpec.officeOwnerId')
  })
})

describe('a failed office step retries as an office step (the repost path)', () => {
  // The auto-return path (grader fails a submission → refund → repost) was
  // written for the open market: blacklist the failed worker, repost for
  // anyone else. Verified against the code the day the privacy split
  // shipped: the repost insert carried NO officeOwnerId (scoped brief →
  // public board), no reservation, and barred the desk's own agent. All
  // three are the office model inverted, so pin the fixed shape.
  const src = code('lib/labor-settle.ts')

  it('carries the office scope onto the replacement spec', () => {
    expect(src).toContain('officeOwnerId: spec.officeOwnerId')
  })

  it('a reserved step keeps its agent (no self-blacklist) and re-reserves before the on-chain post', () => {
    expect(src).toContain('assignedAgentFor(spec.specHash)')
    // Reserved: the desk's agent must NOT enter failedWorkerIds…
    expect(src).toContain('.filter((w) => w !== reservedAgent)')
    // …and the reservation must land before the job is publicly claimable.
    expect(src.indexOf('reserveJobForAgent(newSpecHash')).toBeGreaterThan(-1)
    expect(src.indexOf('reserveJobForAgent(newSpecHash')).toBeLessThan(src.indexOf('postJob(spec.requesterAgentId!, job.bounty'))
  })

  it('the open-market rule is unchanged for unreserved jobs', () => {
    expect(src).toContain('[...new Set([...(spec.failedWorkerIds ?? []), spec.workerAgentId])]')
  })
})

describe('a proof id and a portfolio repo are not ways around the visibility split', () => {
  // Found in the follow-up sweep (2026-09-01): both public by-products of a
  // PAID job carried the scoped bytes out. The portfolio mirror committed
  // title + full deliverable to a PUBLIC GitHub repo with no scope check,
  // and GET /api/proof/<id> handed any caller the v2 evidence bundle (sealed
  // spec + deliverable). Hashes stay public — commitments leak nothing.
  it('the portfolio mirror skips office-scoped jobs before any GitHub write', () => {
    const src = code('lib/agent-repo.ts')
    const at = src.indexOf('spec?.officeOwnerId')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('installationTokenForRepo'))
  })

  it('the public proof route withholds the evidence bundle for scoped jobs', () => {
    const src = code('app/api/proof/[id]/route.ts')
    expect(src).toContain('evidencePubliclyVisible(stored.proof.jobRef)')
    expect(src).toContain('evidenceVisible ? stored.evidence : null')
  })

  it('unresolvable scope reads withhold — a leak cannot be taken back', () => {
    const src = code('lib/work-proof-store.ts')
    const body = src.slice(src.indexOf('export async function evidencePubliclyVisible'))
    expect(body).toContain('return false')
    expect(body.indexOf('catch')).toBeLessThan(body.indexOf('return false'))
  })
})
