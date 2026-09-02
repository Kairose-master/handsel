import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { releaseRefusal } from '@/lib/job-release'
import { TOOLS } from '@/lib/mcp/tools-manifest'

/**
 * Owner release from MCP — the requester's on-chain judgment, reachable
 * from the surface that ran the office. Found missing the first time a
 * pipeline ended in a failed peer review (job #53, 2026-09-02): the owner
 * wanted to overrule the reviewer and had no tool to do it with.
 */

describe('releaseRefusal — every way a release is refused says why', () => {
  it('refuses a job the chain does not know', () => {
    expect(releaseRefusal(undefined, true)).toMatch(/not found/)
  })
  it('refuses another account\'s job before looking at its status', () => {
    expect(releaseRefusal({ status: 'Submitted' }, false)).toMatch(/another account/)
  })
  it('refuses anything not Submitted, and says already-paid plainly', () => {
    expect(releaseRefusal({ status: 'Open' }, true)).toMatch(/Open, not Submitted/)
    expect(releaseRefusal({ status: 'Completed' }, true)).toMatch(/Already released/)
    expect(releaseRefusal({ status: 'Refunded' }, true)).toMatch(/Refunded/)
  })
  it('allows an owned Submitted job', () => {
    expect(releaseRefusal({ status: 'Submitted' }, true)).toBeNull()
  })
})

describe('the wiring', () => {
  it('advertises release_job as a requester-side, irreversible, money-moving tool', () => {
    const tool = TOOLS.find((t) => t.name === 'release_job')
    expect(tool).toBeDefined()
    expect(tool!.description).toMatch(/Irreversible/)
    expect(tool!.description).toMatch(/pays the bounty/)
    expect(tool!.inputSchema.required).toEqual(['job_id'])
  })
  it('the handler goes through the lib core, and ownership comes from the on-chain requester address', () => {
    const handler = readFileSync('lib/mcp/handlers/jobs.ts', 'utf8')
    expect(handler).toContain("case 'release_job'")
    expect(handler).toContain("await import('@/lib/job-release')")
    const core = readFileSync('lib/job-release.ts', 'utf8')
    const ownership = core.indexOf('job.requester.toLowerCase()')
    const approve = core.indexOf('await approveJob(')
    expect(ownership).toBeGreaterThan(-1)
    expect(ownership).toBeLessThan(approve)
    // Ownership is the ADDRESS's owner, never a passed agent id.
    expect(core).not.toMatch(/args\.agent_id|requesterAgentId/)
    // The release and the bookkeeping share the payout convergence point.
    expect(core.indexOf('creditWorkerForJob(')).toBeGreaterThan(approve)
  })
})
