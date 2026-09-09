import { describe, expect, it } from 'vitest'
import { parsePlannerOutput, assembleFinalOutput, type DelegationSubtask } from '@/lib/delegation'

const work = (title: string, extra: Partial<Record<string, unknown>> = {}) => ({
  title,
  description: `Do the thing: ${title} with enough detail to be self-contained.`,
  acceptanceCriteria: 'must satisfy the stated criteria',
  bountyUsd: 3,
  ...extra,
})

describe('parsePlannerOutput integration subtask', () => {
  it('accepts a trailing integration subtask with bounty 0 + testCode and does not count it against budget', () => {
    const out = parsePlannerOutput(
      JSON.stringify([
        work('parser'),
        work('validator'),
        { title: 'Integration', integration: true, testCode: 'assert True', bountyUsd: 999 },
      ]),
      6,
    )
    expect(out).toHaveLength(3)
    const integ = out[2]
    expect(integ.isIntegration).toBe(true)
    expect(integ.bountyUsd).toBe(0) // forced to 0 regardless of what the planner said
    expect(out.reduce((s, x) => s + x.bountyUsd, 0)).toBe(6) // integration adds nothing
  })

  it('rejects an integration subtask that is not last', () => {
    expect(() =>
      parsePlannerOutput(
        JSON.stringify([{ title: 'I', integration: true, testCode: 'assert True' }, work('a')]),
        6,
      ),
    ).toThrow(/must be last/)
  })

  it('rejects more than one integration subtask', () => {
    expect(() =>
      parsePlannerOutput(
        JSON.stringify([
          work('a'),
          { title: 'I1', integration: true, testCode: 'assert True' },
          { title: 'I2', integration: true, testCode: 'assert True' },
        ]),
        6,
      ),
    ).toThrow(/more than one integration/)
  })

  it('rejects an integration subtask without testCode', () => {
    expect(() =>
      parsePlannerOutput(JSON.stringify([work('a'), { title: 'I', integration: true }]), 6),
    ).toThrow(/needs a title and testCode/)
  })
})

describe('assembleFinalOutput integration footer', () => {
  const st = (o: Partial<DelegationSubtask>): DelegationSubtask =>
    ({ title: 't', description: 'd', acceptanceCriteria: 'c', bountyUsd: 2, ...o }) as DelegationSubtask

  it('renders a passed integration check as a footer, not a content section', () => {
    const out = assembleFinalOutput('build a lib', [
      st({ title: 'Parser', output: 'def parse(): ...' }),
      st({ title: 'Validator', output: 'def validate(): ...' }),
      st({ title: 'Integration', isIntegration: true, output: 'Integration tests PASSED.' }),
    ])
    expect(out).toContain('✅ Integration check: passed')
    expect(out).not.toContain('## Integration') // never a content section
    expect(out).toContain('## Parser')
  })

  it('flags a failed integration check prominently', () => {
    const out = assembleFinalOutput('build a lib', [
      st({ title: 'Parser', output: 'def parse(): ...' }),
      st({ title: 'Integration', isIntegration: true, failed: true, failReason: "pieces don't fit" }),
    ])
    expect(out).toContain('⚠️ Integration check: FAILED')
    expect(out).toContain("pieces don't fit")
  })

  it('never labels an unavailable legacy integration result as passed', () => {
    const out = assembleFinalOutput('build', [
      st({ title: 'Parser', output: 'code' }),
      st({ title: 'Integration', isIntegration: true, output: 'Integration check could not run (grader unavailable): timeout' }),
    ])
    expect(out).toContain('NOT VERIFIED')
    expect(out).not.toContain('✅')
  })

  it('keeps the integration verdict when a synthesis supplies the final document', () => {
    const out = assembleFinalOutput('build', [
      st({ title: 'Parser', output: 'code' }),
      st({ title: 'Summary', output: 'final document', synthesizes: ['Parser'] }),
      st({ title: 'Integration', isIntegration: true, failed: true, failReason: 'incompatible pieces' }),
    ])
    expect(out).toContain('final document')
    expect(out).toContain('Integration check: FAILED')
  })

  it('does not let a synthesis hide missing work', () => {
    const out = assembleFinalOutput('build', [
      st({ title: 'Parser', failed: true, failReason: 'timeout' }),
      st({ title: 'Summary', output: 'partial document', synthesizes: ['Parser'] }),
    ])
    expect(out).toContain('Incomplete parts')
    expect(out).toContain('timeout')
  })
})
