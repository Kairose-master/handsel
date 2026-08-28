import { describe, it, expect } from 'vitest'
import { artifactFlightsFor, type FlightSubtask } from '@/lib/office-artifact-flights'

const deptOf = new Map<string, string | null>([
  ['worker-a', 'engineering'],
  ['worker-b', 'verification'],
  ['worker-c', null], // lounge
])

describe('artifactFlightsFor', () => {
  it('shows a handoff once the upstream is done and the downstream has not consumed it', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', output: 'the real spec text', dependsOn: [], workerAgentId: 'worker-a' },
      { title: 'Client impl', dependsOn: ['API spec'], workerAgentId: 'worker-b' },
    ]
    const flights = artifactFlightsFor('d1', subtasks, deptOf)
    expect(flights).toHaveLength(1)
    expect(flights[0]).toMatchObject({
      kind: 'handoff',
      fromDeptId: 'engineering',
      toDeptId: 'verification',
      // The real workers ride along so a renderer can track the flight
      // between the two agents' LIVE positions, not just room centers.
      fromAgentId: 'worker-a',
      toAgentId: 'worker-b',
      label: 'API spec → Client impl',
    })
  })

  it('classifies reviewOf as review, not handoff, even though reviewOf folds into dependsOn', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'Draft', output: 'delivered', workerAgentId: 'worker-a' },
      { title: 'Review Draft', reviewOf: 'Draft', dependsOn: ['Draft'], workerAgentId: 'worker-b' },
    ]
    const flights = artifactFlightsFor('d1', subtasks, deptOf)
    expect(flights).toHaveLength(1)
    expect(flights[0].kind).toBe('review')
  })

  it('classifies synthesizes as synthesis', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'Part A', output: 'a', workerAgentId: 'worker-a' },
      { title: 'Part B', output: 'b', workerAgentId: 'worker-c' },
      { title: 'Assembled', synthesizes: ['Part A', 'Part B'], dependsOn: ['Part A', 'Part B'], workerAgentId: 'worker-b' },
    ]
    const flights = artifactFlightsFor('d1', subtasks, deptOf)
    expect(flights).toHaveLength(2)
    expect(flights.every((f) => f.kind === 'synthesis')).toBe(true)
    expect(flights.find((f) => f.fromDeptId === null)?.toDeptId).toBe('verification') // worker-c is in the lounge (null), a real known location
  })

  it('shows nothing before the upstream has delivered output', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', workerAgentId: 'worker-a' }, // no output yet
      { title: 'Client impl', dependsOn: ['API spec'], workerAgentId: 'worker-b' },
    ]
    expect(artifactFlightsFor('d1', subtasks, deptOf)).toEqual([])
  })

  it('shows nothing once the downstream has already produced its own output', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', output: 'the spec', workerAgentId: 'worker-a' },
      { title: 'Client impl', output: 'already built', dependsOn: ['API spec'], workerAgentId: 'worker-b' },
    ]
    expect(artifactFlightsFor('d1', subtasks, deptOf)).toEqual([])
  })

  it('never shows a flight for a failed upstream, even with output present', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', output: 'partial', failed: true, workerAgentId: 'worker-a' },
      { title: 'Client impl', dependsOn: ['API spec'], workerAgentId: 'worker-b' },
    ]
    expect(artifactFlightsFor('d1', subtasks, deptOf)).toEqual([])
  })

  it('never shows a flight for a failed downstream', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', output: 'the spec', workerAgentId: 'worker-a' },
      { title: 'Client impl', failed: true, dependsOn: ['API spec'], workerAgentId: 'worker-b' },
    ]
    expect(artifactFlightsFor('d1', subtasks, deptOf)).toEqual([])
  })

  it('skips a downstream worker with no known department (not in this office, or unclaimed)', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', output: 'the spec', workerAgentId: 'worker-a' },
      { title: 'Client impl', dependsOn: ['API spec'], workerAgentId: 'someone-else' },
    ]
    expect(artifactFlightsFor('d1', subtasks, deptOf)).toEqual([])
  })

  it('skips an upstream worker with no known department', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', output: 'the spec', workerAgentId: 'someone-else' },
      { title: 'Client impl', dependsOn: ['API spec'], workerAgentId: 'worker-b' },
    ]
    expect(artifactFlightsFor('d1', subtasks, deptOf)).toEqual([])
  })

  it('skips a downstream with no worker at all (unclaimed job) — no destination to guess', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', output: 'the spec', workerAgentId: 'worker-a' },
      { title: 'Client impl', dependsOn: ['API spec'], workerAgentId: null },
    ]
    expect(artifactFlightsFor('d1', subtasks, deptOf)).toEqual([])
  })

  it('shows nothing when both workers already sit in the same room', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', output: 'the spec', workerAgentId: 'worker-a' },
      { title: 'Client impl', dependsOn: ['API spec'], workerAgentId: 'worker-a' },
    ]
    expect(artifactFlightsFor('d1', subtasks, deptOf)).toEqual([])
  })

  it('ignores a dependsOn reference to an unknown title rather than throwing', () => {
    const subtasks: FlightSubtask[] = [{ title: 'Client impl', dependsOn: ['Nonexistent'], workerAgentId: 'worker-b' }]
    expect(artifactFlightsFor('d1', subtasks, deptOf)).toEqual([])
  })

  it('produces a stable id keyed by delegation and title pair', () => {
    const subtasks: FlightSubtask[] = [
      { title: 'API spec', output: 'the spec', workerAgentId: 'worker-a' },
      { title: 'Client impl', dependsOn: ['API spec'], workerAgentId: 'worker-b' },
    ]
    const flights = artifactFlightsFor('deleg-42', subtasks, deptOf)
    expect(flights[0].id).toBe('deleg-42:API spec::Client impl')
  })
})
