import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync('lib/mcp/handlers/delegation.ts', 'utf8')
const block = src.slice(src.indexOf("case 'delegation_status'"), src.indexOf("case 'get_delegation_output'"))

describe('delegation_status when the chain cannot be read', () => {
  it('does not collapse a failed read into an empty market', () => {
    // Observed live: every subtask of every delegation rendered as unposted
    // and every cost as $0 — including a delegation that had already
    // COMPLETED and paid out, which no on-chain state can go back to.
    expect(block).not.toContain('readJobs().catch(() => [])')
    expect(block).toContain('readJobs().catch(() => null)')
  })

  it('says so instead of reporting a market it could not see', () => {
    // This is the one surface an owner checks to find out whether their money
    // moved. "Everything is unposted and nothing is paid" is the worst
    // possible wrong answer to that question.
    expect(block).toMatch(/jobs === null/)
    const refusal = block.slice(block.indexOf('jobs === null'), block.indexOf('jobs === null') + 600)
    expect(refusal).toMatch(/Could not read/i)
    expect(refusal).toMatch(/failed read, not a settlement/i)
  })

  it('refuses before it renders or ticks', () => {
    // The handler both renders AND drives tickDelegation in after(). Passing
    // a phantom empty list into the tick is worse than the bad render.
    const nullCheck = block.indexOf('jobs === null')
    expect(nullCheck).toBeLessThan(block.indexOf('tickDelegation'))
    expect(nullCheck).toBeLessThan(block.indexOf('subtaskViews'))
  })

  it('still distinguishes "we did not ask" from "we asked and failed"', () => {
    // No active delegation means no read was attempted, and that must stay a
    // legitimate empty — not a refusal.
    expect(block).toContain('hasActive ?')
  })
})

describe('the safe reader already exists', () => {
  it('documents the distinction this bug re-introduced', () => {
    const helper = readFileSync('lib/onchain/labor-read.ts', 'utf8')
    expect(helper).toContain('readJobsOrUnknown')
    expect(helper).toMatch(/null.{0,40}unknown/is)
  })

  it('tickDelegation fails closed on an empty list', () => {
    // It cannot tell a failed read from an empty market either, but nothing
    // it does on absence spends — so the collapse is survivable there and was
    // not in the renderer.
    const del = readFileSync('lib/delegation.ts', 'utf8')
    const tick = del.slice(del.indexOf('export async function tickDelegation'))
    expect(tick.slice(0, 800)).toContain('if (jobs.length === 0) return')
  })
})
