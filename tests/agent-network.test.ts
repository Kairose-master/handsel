/**
 * The network graph's pure half (lib/agent-network.ts).
 *
 * The tests that matter most are the visibility ones. This graph spans
 * other people's agents, and the failure it is guarding against is not a
 * crash — it is a picture that quietly publishes who negotiates with whom.
 * So every private-edge case is asserted from the outside: not "the flag is
 * set" but "the edge is absent from the response".
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_NETWORK_NODES,
  agentNodeId,
  buildNetwork,
  edgeVisibility,
  layoutNetwork,
  officeNodeId,
  selectNodes,
  truncatePreview,
  type NetworkEdge,
  type NetworkInput,
  type NetworkNode,
} from '@/lib/agent-network'

const AT = '2026-08-29T10:00:00.000Z'

const base = (over: Partial<NetworkInput> = {}): NetworkInput => ({
  viewerUserId: 'u1',
  agents: [
    { id: 'a1', name: 'Mine One', userId: 'u1', slot: 1, creditScore: 40 },
    { id: 'a2', name: 'Mine Two', userId: 'u1', slot: 1, creditScore: 30 },
    { id: 'b1', name: 'Theirs', userId: 'u2', slot: 1, creditScore: 55 },
    { id: 'c1', name: 'Stranger', userId: 'u3', slot: 1, creditScore: 10 },
  ],
  offices: [
    { userId: 'u1', slot: 1, name: 'My Desk' },
    { userId: 'u2', slot: 1, name: 'Their Desk' },
    { userId: 'u3', slot: 1, name: 'Stranger Desk' },
  ],
  messages: [],
  handoffs: [],
  jobs: [],
  officeLinks: [],
  connectedUserIds: ['u2'],
  ...over,
})

describe('edgeVisibility', () => {
  it('treats jobs, office links and membership as public', () => {
    expect(edgeVisibility('job', null, [])).toBe('public')
    expect(edgeVisibility('office-link', null, [])).toBe('public')
    expect(edgeVisibility('membership', null, [])).toBe('public')
  })

  it('shows a private edge in full only to an owner of its content', () => {
    expect(edgeVisibility('message', 'u1', ['u1', 'u2'])).toBe('full')
    expect(edgeVisibility('message', 'u2', ['u1', 'u2'])).toBe('full')
    expect(edgeVisibility('handoff', 'u1', ['u1'])).toBe('full')
  })

  it('hides — never anonymises — a private edge between two strangers', () => {
    // An anonymous line still publishes that these two talk. That IS the
    // metadata worth protecting, so the answer is absence.
    expect(edgeVisibility('message', 'u1', ['u2', 'u3'])).toBe('hidden')
    expect(edgeVisibility('handoff', 'u1', ['u2'])).toBe('hidden')
  })

  it('hides private edges from a signed-out viewer', () => {
    expect(edgeVisibility('message', null, ['u1', 'u2'])).toBe('hidden')
    expect(edgeVisibility('handoff', null, ['u1'])).toBe('hidden')
  })
})

describe('buildNetwork — visibility', () => {
  const msg = (from: string, to: string, body: string) => ({
    fromAgentId: from,
    toAgentId: to,
    type: 'inquiry',
    body,
    createdAt: AT,
  })

  it('keeps a message edge that touches the viewer, with its real preview', () => {
    const net = buildNetwork(base({ messages: [msg('a1', 'b1', 'can you take this brief?')] }))
    const edge = net.edges.find((e) => e.kind === 'message')
    expect(edge).toBeDefined()
    expect(edge!.preview).toBe('can you take this brief?')
    expect([edge!.source, edge!.target].sort()).toEqual([agentNodeId('a1'), agentNodeId('b1')].sort())
  })

  it('omits a message between two other accounts entirely', () => {
    const net = buildNetwork(base({ messages: [msg('b1', 'c1', 'private negotiation')] }))
    expect(net.edges.filter((e) => e.kind === 'message')).toEqual([])
    expect(JSON.stringify(net)).not.toContain('private negotiation')
  })

  it('omits another owner’s delegation handoff', () => {
    const net = buildNetwork(
      base({
        handoffs: [
          { ownerUserId: 'u1', fromAgentId: 'a1', toAgentId: 'a2', label: 'mine', at: AT },
          { ownerUserId: 'u2', fromAgentId: 'b1', toAgentId: 'c1', label: 'theirs', at: AT },
        ],
      }),
    )
    const handoffs = net.edges.filter((e) => e.kind === 'handoff')
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0].preview).toBe('mine')
    expect(JSON.stringify(net)).not.toContain('theirs')
  })

  it('shows a job between two strangers — settlement is already public', () => {
    const net = buildNetwork(
      base({ jobs: [{ requesterAgentId: 'b1', workerAgentId: 'c1', title: 'Write a landing page', at: AT }] }),
    )
    const job = net.edges.find((e) => e.kind === 'job')
    expect(job).toBeDefined()
    expect(job!.preview).toBe('Write a landing page')
  })

  it('names offices for the viewer and for connected accounts, and no others', () => {
    const net = buildNetwork(base())
    const officeIds = net.nodes.filter((n) => n.kind === 'office').map((n) => n.id)
    expect(officeIds).toContain(officeNodeId('u1', 1))
    expect(officeIds).toContain(officeNodeId('u2', 1))
    expect(officeIds).not.toContain(officeNodeId('u3', 1))
    // …and a stranger's agent is present but unclustered, rather than
    // hanging off an org chart nobody shared.
    expect(net.nodes.find((n) => n.id === agentNodeId('c1'))!.officeId).toBeNull()
  })

  it('gives a signed-out viewer the public graph only', () => {
    const net = buildNetwork(
      base({
        viewerUserId: null,
        connectedUserIds: [],
        messages: [msg('a1', 'b1', 'secret')],
        jobs: [{ requesterAgentId: 'a1', workerAgentId: 'b1', title: 'public job', at: AT }],
      }),
    )
    expect(net.edges.map((e) => e.kind)).toEqual(['job'])
    expect(net.nodes.filter((n) => n.kind === 'office')).toEqual([])
    expect(net.nodes.every((n) => !n.mine)).toBe(true)
  })
})

describe('buildNetwork — shape', () => {
  it('merges repeated exchanges into one weighted edge, newest preview wins', () => {
    const net = buildNetwork(
      base({
        messages: [
          { fromAgentId: 'a1', toAgentId: 'b1', type: 'inquiry', body: 'first', createdAt: '2026-08-29T09:00:00.000Z' },
          { fromAgentId: 'b1', toAgentId: 'a1', type: 'info', body: 'reply', createdAt: '2026-08-29T09:30:00.000Z' },
          { fromAgentId: 'a1', toAgentId: 'b1', type: 'info', body: 'latest', createdAt: '2026-08-29T10:00:00.000Z' },
        ],
      }),
    )
    const edges = net.edges.filter((e) => e.kind === 'message')
    expect(edges).toHaveLength(1)
    expect(edges[0].count).toBe(3)
    expect(edges[0].preview).toBe('latest')
    expect(edges[0].lastAt).toBe('2026-08-29T10:00:00.000Z')
  })

  it('keeps a message edge separate from a job edge between the same pair', () => {
    const net = buildNetwork(
      base({
        messages: [{ fromAgentId: 'a1', toAgentId: 'b1', type: 'inquiry', body: 'q', createdAt: AT }],
        jobs: [{ requesterAgentId: 'a1', workerAgentId: 'b1', title: 't', at: AT }],
      }),
    )
    expect(net.edges.map((e) => e.kind).sort()).toContain('message')
    expect(net.edges.map((e) => e.kind).sort()).toContain('job')
  })

  it('drops edges pointing at an agent that is not in the graph', () => {
    const net = buildNetwork(
      base({ jobs: [{ requesterAgentId: 'a1', workerAgentId: 'ghost', title: 't', at: AT }] }),
    )
    expect(net.edges.filter((e) => e.kind === 'job')).toEqual([])
  })

  it('ignores a self-edge rather than drawing a loop', () => {
    const net = buildNetwork(
      base({ messages: [{ fromAgentId: 'a1', toAgentId: 'a1', type: 'info', body: 'x', createdAt: AT }] }),
    )
    expect(net.edges.filter((e) => e.kind === 'message')).toEqual([])
  })

  it('does not let membership inflate a silent agent’s degree', () => {
    const net = buildNetwork(base())
    // a1 sits in an office and has said nothing. It is a small dot.
    expect(net.nodes.find((n) => n.id === agentNodeId('a1'))!.degree).toBe(0)
  })

  it('counts cross-account messages, including ones it cannot draw', () => {
    const net = buildNetwork(
      base({
        messages: [
          { fromAgentId: 'a1', toAgentId: 'a2', type: 'info', body: 'internal', createdAt: AT },
          { fromAgentId: 'a1', toAgentId: 'b1', type: 'info', body: 'outbound', createdAt: AT },
        ],
      }),
    )
    expect(net.stats.crossAccountMessages).toBe(1)
    expect(net.stats.reachedAccounts).toBe(1)
  })

  it('is empty for an account that has done nothing — no invented edges', () => {
    const net = buildNetwork({
      viewerUserId: 'u1',
      agents: [{ id: 'a1', name: 'Alone', userId: 'u1' }],
      offices: [],
      messages: [],
      handoffs: [],
      jobs: [],
      officeLinks: [],
      connectedUserIds: [],
    })
    expect(net.edges).toEqual([])
    expect(net.nodes).toHaveLength(1)
    expect(net.stats.messages).toBe(0)
  })

  it('links two connected offices to each other', () => {
    const net = buildNetwork(base({ officeLinks: [{ a: 'u1', b: 'u2' }] }))
    const link = net.edges.find((e) => e.kind === 'office-link')
    expect(link).toBeDefined()
    expect([link!.source, link!.target].sort()).toEqual([officeNodeId('u1', 1), officeNodeId('u2', 1)].sort())
  })
})

describe('selectNodes', () => {
  const node = (id: string, over: Partial<NetworkNode> = {}): NetworkNode => ({
    id,
    kind: 'agent',
    label: id,
    officeId: null,
    mine: false,
    degree: 0,
    ...over,
  })

  it('returns everything when under the cap', () => {
    const all = [node('a'), node('b')]
    expect(selectNodes(all, 10)).toHaveLength(2)
  })

  it('never drops the viewer’s own nodes to make room for a stranger', () => {
    const all = [node('mine', { mine: true, degree: 0 }), node('busy', { degree: 999 })]
    expect(selectNodes(all, 1).map((n) => n.id)).toEqual(['mine'])
  })

  it('prefers offices, then the best-connected, and breaks ties deterministically', () => {
    const all = [node('z-agent', { degree: 5 }), node('office', { kind: 'office' }), node('a-agent', { degree: 5 })]
    expect(selectNodes(all, 2).map((n) => n.id)).toEqual(['office', 'a-agent'])
    expect(selectNodes(all, 2)).toEqual(selectNodes(all, 2))
  })
})

describe('buildNetwork — the cap', () => {
  it('reports what it dropped instead of pretending the market is this size', () => {
    const agents = Array.from({ length: MAX_NETWORK_NODES + 20 }, (_, i) => ({
      id: `x${i}`,
      name: `Agent ${i}`,
      userId: i === 0 ? 'u1' : 'u9',
    }))
    const net = buildNetwork({
      viewerUserId: 'u1',
      agents,
      offices: [],
      messages: [],
      handoffs: [],
      jobs: [],
      officeLinks: [],
      connectedUserIds: [],
    })
    expect(net.nodes).toHaveLength(MAX_NETWORK_NODES)
    expect(net.truncated).toBe(20)
    expect(net.nodes.some((n) => n.id === agentNodeId('x0'))).toBe(true)
  })

  it('drops the edges of a dropped node too — no line to nowhere', () => {
    const agents = Array.from({ length: MAX_NETWORK_NODES + 2 }, (_, i) => ({
      id: `x${i}`,
      name: `Agent ${i}`,
      userId: 'u9',
    }))
    // The last two are the least connected, so they go; their job edge with
    // each other must go with them.
    const net = buildNetwork({
      viewerUserId: 'u1',
      agents,
      offices: [],
      messages: [],
      handoffs: [],
      jobs: [
        { requesterAgentId: 'x0', workerAgentId: 'x1', title: 'kept', at: AT },
        {
          requesterAgentId: `x${MAX_NETWORK_NODES}`,
          workerAgentId: `x${MAX_NETWORK_NODES + 1}`,
          title: 'dropped',
          at: AT,
        },
      ],
      officeLinks: [],
      connectedUserIds: [],
    })
    const ids = new Set(net.nodes.map((n) => n.id))
    expect(net.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true)
  })
})

describe('truncatePreview', () => {
  it('flattens whitespace so a pasted brief does not break the tooltip', () => {
    expect(truncatePreview('a\n\n  b\tc')).toBe('a b c')
  })

  it('caps and marks a long body', () => {
    const out = truncatePreview('y'.repeat(400))
    expect(out).toHaveLength(110)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('layoutNetwork', () => {
  const nodes: NetworkNode[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id,
    kind: 'agent',
    label: id,
    officeId: null,
    mine: false,
    degree: 1,
  }))
  const edge = (a: string, b: string, over: Partial<NetworkEdge> = {}): NetworkEdge => ({
    id: `${a}-${b}`,
    source: a,
    target: b,
    kind: 'message',
    count: 1,
    lastAt: null,
    preview: null,
    ...over,
  })

  it('is deterministic — the constellation must not reshuffle on every poll', () => {
    const one = layoutNetwork(nodes, [edge('a', 'b')], { iterations: 60 })
    const two = layoutNetwork(nodes, [edge('a', 'b')], { iterations: 60 })
    expect([...one.entries()]).toEqual([...two.entries()])
  })

  it('places every node, finitely, inside the normalised box', () => {
    const out = layoutNetwork(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')], { iterations: 120 })
    expect(out.size).toBe(nodes.length)
    for (const p of out.values()) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1.0001)
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1.0001)
    }
  })

  it('pulls connected nodes closer than unconnected ones', () => {
    const out = layoutNetwork(nodes, [edge('a', 'b')], { iterations: 400 })
    const d = (p: string, q: string) => Math.hypot(out.get(p)!.x - out.get(q)!.x, out.get(p)!.y - out.get(q)!.y)
    expect(d('a', 'b')).toBeLessThan(d('a', 'd'))
    expect(d('a', 'b')).toBeLessThan(d('c', 'e'))
  })

  it('clusters an office with its members', () => {
    const clustered: NetworkNode[] = [
      { id: 'office:u1:1', kind: 'office', label: 'Desk', officeId: null, mine: true, degree: 0 },
      { id: 'm1', kind: 'agent', label: 'm1', officeId: 'office:u1:1', mine: true, degree: 0 },
      { id: 'm2', kind: 'agent', label: 'm2', officeId: 'office:u1:1', mine: true, degree: 0 },
      { id: 'far', kind: 'agent', label: 'far', officeId: null, mine: false, degree: 0 },
    ]
    const out = layoutNetwork(
      clustered,
      [
        edge('m1', 'office:u1:1', { kind: 'membership' }),
        edge('m2', 'office:u1:1', { kind: 'membership' }),
      ],
      { iterations: 400 },
    )
    const d = (p: string, q: string) => Math.hypot(out.get(p)!.x - out.get(q)!.x, out.get(p)!.y - out.get(q)!.y)
    expect(d('m1', 'office:u1:1')).toBeLessThan(d('far', 'office:u1:1'))
    expect(d('m2', 'office:u1:1')).toBeLessThan(d('far', 'office:u1:1'))
  })

  it('does not let one drifting isolate shrink the readable core', () => {
    // The first version scaled by the extreme radius, so a single unconnected
    // agent parked at the rim squeezed everything with actual structure into
    // an unreadable knot in the middle. The core must keep its room.
    const core: NetworkNode[] = ['p', 'q', 'r'].map((id) => ({
      id,
      kind: 'agent',
      label: id,
      officeId: null,
      mine: false,
      degree: 2,
    }))
    const ring = [edge('p', 'q'), edge('q', 'r'), edge('r', 'p')]
    const tight = layoutNetwork(core, ring, { iterations: 400 })
    const withIsolates = layoutNetwork(
      [...core, ...Array.from({ length: 6 }, (_, i) => ({ ...core[0], id: `lone${i}`, degree: 0 }))],
      ring,
      { iterations: 400 },
    )
    const spread = (l: ReturnType<typeof layoutNetwork>) => {
      const pts = core.map((n) => l.get(n.id)!)
      let max = 0
      for (const a of pts) for (const b of pts) max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y))
      return max
    }
    // Adding isolates shrinks the core somewhat — it must not annihilate it.
    expect(spread(withIsolates)).toBeGreaterThan(spread(tight) * 0.3)
  })

  it('handles the degenerate sizes without NaN', () => {
    expect(layoutNetwork([], []).size).toBe(0)
    const one = layoutNetwork([nodes[0]], [])
    expect(one.get('a')).toEqual({ x: 0, y: 0 })
    const two = layoutNetwork(nodes.slice(0, 2), [edge('a', 'b')], { iterations: 30 })
    for (const p of two.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
  })

  it('separates nodes that start coincident', () => {
    // Every node identical and unconnected: the only thing keeping them
    // apart is the jitter path in the repulsion loop.
    const many = Array.from({ length: 12 }, (_, i) => ({ ...nodes[0], id: `n${i}` }))
    const out = layoutNetwork(many, [], { iterations: 200 })
    const seen = new Set([...out.values()].map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`))
    expect(seen.size).toBe(many.length)
  })
})
