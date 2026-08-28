import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync('lib/delegation.ts', 'utf8')
const wrapper = src.slice(
  src.indexOf('export async function tickDelegation('),
  src.indexOf('async function tickDelegationLocked'),
)
const locked = src.slice(
  src.indexOf('async function tickDelegationLocked'),
  src.indexOf('/**\n * Write the prime\'s orchestration outcome'),
)

// Found live: Research and Verification both completed and paid on-chain,
// but "Final answer" never posted across many minutes of polling. Every
// caller of tickDelegation swallows what it throws
// (`.catch(() => {})`, by design — one delegation's fault must not stop the
// sweep over the rest) — so whatever tripped inside tickDelegationLocked left
// the delegation stuck at 'posted' with no record anywhere. `delegation.error`
// existed in the schema the whole time and was never once written; the MCP
// status line already had `(row.error ? ... : '')` ready to print it. The gap
// was entirely on the write side.
describe('a tick that throws leaves a reason behind', () => {
  it('catches around the locked body, inside the lease', () => {
    const tryAt = wrapper.indexOf('try {')
    const catchAt = wrapper.indexOf('} catch')
    const financeAt = wrapper.indexOf('} finally')
    expect(tryAt).toBeGreaterThan(-1)
    expect(catchAt).toBeGreaterThan(tryAt)
    expect(financeAt).toBeGreaterThan(catchAt)
  })

  it('writes the failure to the row this delegation owns, not just a log line', () => {
    const catchBlock = wrapper.slice(wrapper.indexOf('} catch'), wrapper.indexOf('} finally'))
    expect(catchBlock).toMatch(/\.update\(delegation\)/)
    expect(catchBlock).toMatch(/error:\s*message/)
    expect(catchBlock).toContain('eq(delegation.id, row.id)')
  })

  it('still releases the lease when the tick throws', () => {
    // The catch must not swallow its way around `finally` — a caught error
    // that skips lease release re-creates the exact bug this session already
    // fixed once (delegation-tick-lease.test.ts).
    expect(wrapper).toContain('finally')
    const financeAt = wrapper.indexOf('} finally')
    expect(wrapper.indexOf('releaseOpsLease', financeAt)).toBeGreaterThan(financeAt)
  })

  it('re-throws after recording, so callers keep their existing swallow-and-retry behavior', () => {
    const catchBlock = wrapper.slice(wrapper.indexOf('} catch'), wrapper.indexOf('} finally'))
    expect(catchBlock.trim().endsWith('throw error')).toBe(true)
  })

  it('does not let a failed write of the error itself blow up the catch', () => {
    const catchBlock = wrapper.slice(wrapper.indexOf('} catch'), wrapper.indexOf('} finally'))
    expect(catchBlock).toMatch(/\.catch\(/)
  })
})

describe('a clean tick clears a stale reason', () => {
  it('the terminal-completion write clears error', () => {
    const allTerminalBlock = locked.slice(locked.indexOf('if (allTerminal)'), locked.indexOf('} else if (changed)'))
    expect(allTerminalBlock).toMatch(/error:\s*null/)
  })

  it('the changed-subtasks write clears error', () => {
    const changedLine = locked.slice(locked.indexOf('} else if (changed)'), locked.indexOf('} else if (row.error)'))
    expect(changedLine).toMatch(/error:\s*null/)
  })

  it('a no-op tick still clears a previously recorded error, so a fixed fault does not read as still broken', () => {
    const idleBlock = locked.slice(locked.indexOf('} else if (row.error)'))
    expect(idleBlock).toMatch(/error:\s*null/)
    expect(idleBlock).toContain('row.error')
  })
})

describe('the display path this feeds already existed', () => {
  it('the MCP status line prints delegation.error when present', () => {
    const handler = readFileSync('lib/mcp/handlers/delegation.ts', 'utf8')
    expect(handler).toMatch(/row\.error\s*\?\s*`\\n\s*error:/)
  })
})
