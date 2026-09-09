import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  row: { id: 'dlg-test', status: 'completed', error: null as string | null, finalOutput: 'assembled output', subtasks: [] as Array<{ title: string; output?: string; failed?: boolean; isIntegration?: boolean }> },
}))

vi.mock('@/lib/db', () => ({
  pool: { query: vi.fn(async () => ({ rows: [{ id: 'receipt-test', template_id: 'research-desk', delegation_id: 'dlg-test', note: null, created_at: new Date(0) }] })) },
  db: { select: () => ({ from: () => ({ where: async () => [fixture.row] }) }) },
}))
vi.mock('@/lib/delegation', () => ({
  tickDelegation: vi.fn(async () => undefined),
  subtaskViews: vi.fn(async () => fixture.row.subtasks),
}))
vi.mock('@/lib/commission-dispatch', () => ({ dispatchCommissionWork: vi.fn(async () => 0) }))
vi.mock('@/lib/origin', () => ({ absoluteUrl: (path: string) => `https://example.invalid${path}` }))

import { commissionStatus } from '@/lib/office-storefront'

beforeEach(() => {
  fixture.row.status = 'completed'
  fixture.row.error = null
  fixture.row.subtasks = [{ title: 'research', output: 'research' }, { title: 'review', output: 'review' }]
})

describe('commission receipt read with local DB/dispatch doubles', () => {
  it('preserves partial output but never offers it as successful delivery', async () => {
    fixture.row.subtasks[1] = { title: 'review', failed: true }
    const result = await commissionStatus('receipt-test')
    expect(result?.status).toBe('failed')
    expect(result?.finalOutput).toBe('assembled output')
    expect(result?.note).toContain('partial')
  })

  it('does not turn a failed delegation into a permanently running order', async () => {
    fixture.row.status = 'failed'
    expect((await commissionStatus('receipt-test'))?.status).toBe('failed')
  })

  it('keeps fully delivered work successful', async () => {
    expect((await commissionStatus('receipt-test'))?.status).toBe('completed')
  })

  it('rejects historical unavailable checks and surfaces a current retry error', async () => {
    fixture.row.subtasks.push({ title: 'integration', isIntegration: true, output: 'Integration check could not run (grader unavailable)' })
    expect((await commissionStatus('receipt-test'))?.status).toBe('failed')
    fixture.row.status = 'posted'
    fixture.row.error = 'Integration grader unavailable: offline'
    const waiting = await commissionStatus('receipt-test')
    expect(waiting?.status).toBe('running')
    expect(waiting?.note).toContain('offline')
  })
})
