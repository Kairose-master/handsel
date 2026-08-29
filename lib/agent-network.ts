/**
 * The network — every agent and every office as one graph, and the real
 * information that moved between them.
 *
 * The office diorama (lib/office-world-data.ts) already draws ONE office
 * from the inside: your agents, in your rooms, talking to each other.
 * lib/office-conversations.ts deliberately drops any message whose other
 * endpoint sits outside that roster, because a diorama has nowhere to point
 * at a stranger. That leaves the most interesting edge in the market —
 * agent A in one account asking agent B in another — drawn nowhere at all.
 *
 * This module is the outside view: nodes are agents AND offices, edges are
 * the four things that actually carry information between them.
 *
 *   message     an agent_messages row — the free lane (lib/agent-messages.ts)
 *   handoff     one delegation subtask's real output feeding the next
 *   job         an escrowed job: requester agent → worker agent
 *   office-link two accounts that redeemed each other's office code
 *
 * Nothing here is decorative. An edge exists only when a row exists, so an
 * empty graph is the honest answer for an account that has not talked to
 * anyone yet — see CLAUDE.md, "No fake data, ever."
 *
 * ── What a viewer may see ────────────────────────────────────────────────
 *
 * This graph spans other people's agents, so visibility is a rule, not a
 * filter someone remembered to apply. `edgeVisibility` is the whole rule
 * and every edge goes through it:
 *
 *   PUBLIC   job edges and office links. Both are already public elsewhere
 *            — /live names top-earning workers, settlement is on-chain, and
 *            an office link is a mutual, consented discovery relationship.
 *            Endpoints and counts are shown; a job title is public metadata.
 *
 *   PRIVATE  message and handoff edges. These carry negotiation content and
 *            an owner's internal plan. Shown in full (with a body preview)
 *            when the viewer owns an endpoint — it is already on their own
 *            /messages page — and otherwise NOT shown at all, not even as
 *            an anonymous line. "Who is negotiating with whom" is metadata
 *            this platform has never published, and a graph is exactly the
 *            surface that would publish it by accident.
 *
 * Office NODES follow the same logic: yours and the ones you are connected
 * to are named; a stranger's agents appear as unclustered nodes rather than
 * exposing an org chart nobody shared with you.
 *
 * Pure module — no db, no chain, no clock beyond what the caller passes in.
 * lib/agent-network-server.ts does the reading.
 */

/* ── Node and edge model ─────────────────────────────────────────────── */

export type NetworkNodeKind = 'agent' | 'office'

export type NetworkNode = {
  /** `agent:<agentId>` or `office:<userId>:<slot>` — unique across kinds. */
  id: string
  kind: NetworkNodeKind
  label: string
  /** The office node this agent belongs to, when the viewer may see it. */
  officeId: string | null
  /** Belongs to the viewer's account. Drives colour, and nothing else. */
  mine: boolean
  /** Sum of the weights of the edges kept for this node — the render uses
   *  it for radius, so a silent agent is a small dot and a hub is a hub. */
  degree: number
  /** Agent-only extras, for the inspector panel. */
  creditScore?: number
  runtimeType?: string | null
}

export type NetworkEdgeKind = 'message' | 'handoff' | 'job' | 'office-link' | 'membership'

export type NetworkEdge = {
  id: string
  source: string
  target: string
  kind: NetworkEdgeKind
  /** How many real rows this one line stands for. */
  count: number
  /** ISO timestamp of the most recent row, or null for a standing relation
   *  (membership, office link) that has no event time. */
  lastAt: string | null
  /** Real content, truncated — null whenever the viewer may not read it.
   *  A PUBLIC edge carries a job title; a PRIVATE one carries a body
   *  preview only for the owner. */
  preview: string | null
}

export type AgentNetwork = {
  nodes: NetworkNode[]
  edges: NetworkEdge[]
  /** Everything the header tiles show, counted from the same rows the graph
   *  was built from so a tile can never disagree with the picture. */
  stats: NetworkStats
  /** Nodes dropped by the cap, so the UI can say so instead of pretending
   *  the market is this size. */
  truncated: number
}

export type NetworkStats = {
  agents: number
  offices: number
  /** Distinct counterpart accounts the viewer's agents exchanged with. */
  reachedAccounts: number
  messages: number
  handoffs: number
  jobs: number
  /** Messages inside the window whose two endpoints belong to DIFFERENT
   *  accounts — the number the whole page exists to move. */
  crossAccountMessages: number
}

/* ── Input: raw rows, exactly as the server read them ────────────────── */

export type NetworkAgentRow = {
  id: string
  name: string
  userId: string
  creditScore?: number
  runtimeType?: string | null
  /** Office slot within its owner's account, from agent_office_slot. */
  slot?: number | null
}

export type NetworkOfficeRow = { userId: string; slot: number; name: string }
export type NetworkMessageRow = {
  fromAgentId: string
  toAgentId: string
  type: string
  body: string
  createdAt: string
}
export type NetworkHandoffRow = {
  /** Owner of the delegation — decides who may read this edge. */
  ownerUserId: string
  fromAgentId: string
  toAgentId: string
  label: string
  at: string
}
export type NetworkJobRow = {
  requesterAgentId: string
  workerAgentId: string
  title: string
  at: string
}
export type NetworkOfficeLinkRow = { a: string; b: string }

export type NetworkInput = {
  viewerUserId: string | null
  agents: NetworkAgentRow[]
  offices: NetworkOfficeRow[]
  messages: NetworkMessageRow[]
  handoffs: NetworkHandoffRow[]
  jobs: NetworkJobRow[]
  officeLinks: NetworkOfficeLinkRow[]
  /** Accounts whose office structure the viewer may see: their own plus
   *  every account they hold an office connection with. */
  connectedUserIds: string[]
}

/** A graph nobody can read is not a graph. Past this many nodes the force
 *  layout is a hairball and the browser is doing O(n²) for nothing, so the
 *  least-connected strangers are dropped and the count is reported. */
export const MAX_NETWORK_NODES = 240

export const PREVIEW_LIMIT = 110

export function agentNodeId(agentId: string): string {
  return `agent:${agentId}`
}

export function officeNodeId(userId: string, slot: number): string {
  return `office:${userId}:${slot}`
}

/* ── The visibility rule ─────────────────────────────────────────────── */

export type EdgeVisibility = 'full' | 'public' | 'hidden'

/**
 * The one place that decides what a viewer may see about an edge.
 *
 * `full`   — endpoints, count and a content preview.
 * `public` — endpoints and count; content is a public field (a job title)
 *            or nothing.
 * `hidden` — the edge is not in the response at all. Not greyed out, not
 *            anonymised: absent. An anonymised private edge still publishes
 *            the fact that those two agents talk, which is the part worth
 *            protecting.
 *
 * `ownerUserIds` is who is entitled to the content: for a message, both
 * endpoints' owners; for a handoff, the delegation's owner.
 */
export function edgeVisibility(
  kind: NetworkEdgeKind,
  viewerUserId: string | null,
  ownerUserIds: readonly (string | null | undefined)[],
): EdgeVisibility {
  if (kind === 'job' || kind === 'office-link' || kind === 'membership') return 'public'
  // message | handoff — private unless the viewer is one of the owners.
  if (!viewerUserId) return 'hidden'
  return ownerUserIds.includes(viewerUserId) ? 'full' : 'hidden'
}

export function truncatePreview(body: string, limit: number = PREVIEW_LIMIT): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/* ── Building ────────────────────────────────────────────────────────── */

/** One line per unordered pair per kind: ten messages between the same two
 *  agents are one edge of count 10, not ten edges nobody can tell apart.
 *  The pair is sorted so A→B and B→A collapse together — the graph answers
 *  "do these two exchange information", and direction lives in the count of
 *  rows behind it, not in the geometry. */
function pairKey(kind: NetworkEdgeKind, a: string, b: string): string {
  return a < b ? `${kind}|${a}|${b}` : `${kind}|${b}|${a}`
}

export function buildNetwork(input: NetworkInput): AgentNetwork {
  const viewer = input.viewerUserId
  const connected = new Set(input.connectedUserIds)
  if (viewer) connected.add(viewer)

  const agentById = new Map(input.agents.map((a) => [a.id, a]))
  const ownerOf = (agentId: string): string | null => agentById.get(agentId)?.userId ?? null

  /* Nodes: every agent we were handed, plus the offices whose structure the
     viewer is entitled to see. */
  const nodes = new Map<string, NetworkNode>()
  for (const a of input.agents) {
    const showOffice = a.slot != null && connected.has(a.userId)
    nodes.set(agentNodeId(a.id), {
      id: agentNodeId(a.id),
      kind: 'agent',
      label: a.name,
      officeId: showOffice ? officeNodeId(a.userId, a.slot as number) : null,
      mine: viewer != null && a.userId === viewer,
      degree: 0,
      creditScore: a.creditScore,
      runtimeType: a.runtimeType ?? null,
    })
  }
  for (const o of input.offices) {
    if (!connected.has(o.userId)) continue
    const id = officeNodeId(o.userId, o.slot)
    nodes.set(id, {
      id,
      kind: 'office',
      label: o.name,
      officeId: null,
      mine: viewer != null && o.userId === viewer,
      degree: 0,
    })
  }

  /* Edges, merged by pair. */
  const merged = new Map<string, NetworkEdge>()
  const add = (
    kind: NetworkEdgeKind,
    source: string,
    target: string,
    at: string | null,
    preview: string | null,
  ) => {
    if (source === target) return
    if (!nodes.has(source) || !nodes.has(target)) return
    const key = pairKey(kind, source, target)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { id: key, source, target, kind, count: 1, lastAt: at, preview })
      return
    }
    existing.count += 1
    // Keep the newest row's preview: the graph reads as "now".
    if (at && (!existing.lastAt || at > existing.lastAt)) {
      existing.lastAt = at
      if (preview !== null) existing.preview = preview
    }
  }

  for (const m of input.messages) {
    const owners = [ownerOf(m.fromAgentId), ownerOf(m.toAgentId)]
    const vis = edgeVisibility('message', viewer, owners)
    if (vis === 'hidden') continue
    add('message', agentNodeId(m.fromAgentId), agentNodeId(m.toAgentId), m.createdAt, truncatePreview(m.body))
  }

  for (const h of input.handoffs) {
    const vis = edgeVisibility('handoff', viewer, [h.ownerUserId])
    if (vis === 'hidden') continue
    add('handoff', agentNodeId(h.fromAgentId), agentNodeId(h.toAgentId), h.at, truncatePreview(h.label))
  }

  for (const j of input.jobs) {
    // Public: the title is already public metadata on the job board.
    add('job', agentNodeId(j.requesterAgentId), agentNodeId(j.workerAgentId), j.at, truncatePreview(j.title))
  }

  for (const link of input.officeLinks) {
    // One line per office pair between the two accounts, but only where
    // both offices are nodes — which the connected-set rule already decided.
    for (const oa of input.offices.filter((o) => o.userId === link.a)) {
      for (const ob of input.offices.filter((o) => o.userId === link.b)) {
        add('office-link', officeNodeId(oa.userId, oa.slot), officeNodeId(ob.userId, ob.slot), null, null)
      }
    }
  }

  for (const node of nodes.values()) {
    if (node.kind === 'agent' && node.officeId) {
      add('membership', node.id, node.officeId, null, null)
    }
  }

  let edges = [...merged.values()]

  /* Degree, then the cap. */
  const degreeOf = new Map<string, number>()
  for (const e of edges) {
    // Membership is structure, not traffic — it should not make a silent
    // agent look busy.
    const w = e.kind === 'membership' ? 0 : e.count
    degreeOf.set(e.source, (degreeOf.get(e.source) ?? 0) + w)
    degreeOf.set(e.target, (degreeOf.get(e.target) ?? 0) + w)
  }
  for (const node of nodes.values()) node.degree = degreeOf.get(node.id) ?? 0

  const kept = selectNodes([...nodes.values()], MAX_NETWORK_NODES)
  const keptIds = new Set(kept.map((n) => n.id))
  const truncated = nodes.size - kept.length
  if (truncated > 0) edges = edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target))

  /* Stats, from the same rows. */
  const reached = new Set<string>()
  let crossAccount = 0
  for (const m of input.messages) {
    const from = ownerOf(m.fromAgentId)
    const to = ownerOf(m.toAgentId)
    if (from && to && from !== to) {
      crossAccount += 1
      if (viewer && from === viewer) reached.add(to)
      if (viewer && to === viewer) reached.add(from)
    }
  }

  return {
    nodes: kept,
    edges,
    truncated,
    stats: {
      agents: kept.filter((n) => n.kind === 'agent').length,
      offices: kept.filter((n) => n.kind === 'office').length,
      reachedAccounts: reached.size,
      messages: edges.filter((e) => e.kind === 'message').reduce((s, e) => s + e.count, 0),
      handoffs: edges.filter((e) => e.kind === 'handoff').reduce((s, e) => s + e.count, 0),
      jobs: edges.filter((e) => e.kind === 'job').reduce((s, e) => s + e.count, 0),
      crossAccountMessages: crossAccount,
    },
  }
}

/**
 * Which nodes survive the cap. Yours are never dropped — a graph that hides
 * your own agent to make room for a stranger's is worse than useless — then
 * offices (they are the structure everything else hangs off), then the
 * best-connected. Ties break on id so the same input always yields the same
 * graph.
 */
export function selectNodes(all: readonly NetworkNode[], cap: number): NetworkNode[] {
  if (all.length <= cap) return [...all]
  const rank = (n: NetworkNode) => (n.mine ? 0 : n.kind === 'office' ? 1 : 2)
  return [...all]
    .sort((a, b) => rank(a) - rank(b) || b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, cap)
}

/* ── Layout ──────────────────────────────────────────────────────────── */

export type Point = { x: number; y: number }
export type NetworkLayout = Map<string, Point>

export type LayoutOptions = {
  iterations?: number
  seed?: number
  /** Extra pull along membership edges, so an office and its agents read as
   *  one cluster instead of a line of dots. */
  clusterPull?: number
}

/** Which nodes define "the core": the radius at this percentile of the
 *  CONNECTED nodes gets the full core scale, and everything past it is
 *  compressed toward the rim. */
const CORE_PERCENTILE = 0.9
/** How much of the box the core is guaranteed. Isolates saturate into the
 *  remaining 30% however far out they drifted. */
const CORE_FRACTION = 0.7

/** mulberry32 — small, fast, and deterministic, which is the only property
 *  that matters here: the same account must get the same constellation on
 *  every poll, or the graph reshuffles itself under the user's cursor. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Force-directed layout: springs along edges, Coulomb repulsion everywhere,
 * a weak pull to the centre so disconnected nodes do not drift to infinity.
 *
 * Pure and deterministic — same input, same positions — which is what makes
 * it testable at all, and what stops the picture from jumping every poll.
 * Returned coordinates are normalised into [-1, 1] on the longer axis; the
 * renderer decides pixels.
 */
export function layoutNetwork(
  nodes: readonly NetworkNode[],
  edges: readonly NetworkEdge[],
  opts: LayoutOptions = {},
): NetworkLayout {
  const iterations = opts.iterations ?? 320
  const clusterPull = opts.clusterPull ?? 2.2
  const rand = mulberry32(opts.seed ?? 1)
  const n = nodes.length
  const layout: NetworkLayout = new Map()
  if (n === 0) return layout
  if (n === 1) return new Map([[nodes[0].id, { x: 0, y: 0 }]])

  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    // Seed on a spiral rather than uniformly: a uniform cloud spends its
    // first hundred iterations just pushing itself apart.
    const t = (i / n) * Math.PI * 2 * 3
    const r = 0.15 + 0.85 * (i / n)
    px[i] = Math.cos(t) * r + (rand() - 0.5) * 0.05
    py[i] = Math.sin(t) * r + (rand() - 0.5) * 0.05
  }

  const springs: { a: number; b: number; strength: number; rest: number }[] = []
  for (const e of edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined) continue
    const membership = e.kind === 'membership'
    // Membership pulls harder but rests SHORTER, so a desk reads as a ring
    // of people around its office rather than a pile on top of it.
    springs.push({
      a,
      b,
      // A pair that exchanged twenty messages sits closer than one that
      // exchanged one — but logarithmically, or a chatty pair collapses onto
      // a single point and hides the rest of the graph.
      strength: (membership ? clusterPull : 1) * (1 + Math.log2(1 + e.count) * 0.35),
      rest: membership ? 0.17 : 0.3,
    })
  }

  const repulsion = 1.7 / n
  for (let step = 0; step < iterations; step++) {
    // Cooling: big rearrangements early, small corrections late.
    const alpha = 0.08 * (1 - step / iterations) ** 1.4 + 0.002
    const fx = new Float64Array(n)
    const fy = new Float64Array(n)

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[i] - px[j]
        let dy = py[i] - py[j]
        let d2 = dx * dx + dy * dy
        if (d2 < 1e-6) {
          // Exactly coincident nodes have no direction to separate along.
          dx = (rand() - 0.5) * 1e-3
          dy = (rand() - 0.5) * 1e-3
          d2 = dx * dx + dy * dy
        }
        const f = repulsion / d2
        const ux = dx * f
        const uy = dy * f
        fx[i] += ux
        fy[i] += uy
        fx[j] -= ux
        fy[j] -= uy
      }
    }

    for (const s of springs) {
      const dx = px[s.b] - px[s.a]
      const dy = py[s.b] - py[s.a]
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6
      const f = (d - s.rest) * s.strength * 0.5
      const ux = (dx / d) * f
      const uy = (dy / d) * f
      fx[s.a] += ux
      fy[s.a] += uy
      fx[s.b] -= ux
      fy[s.b] -= uy
    }

    for (let i = 0; i < n; i++) {
      // Gravity has to beat repulsion at range, or a node with no edges
      // drifts until it alone defines the extent of the picture.
      fx[i] -= px[i] * 0.14
      fy[i] -= py[i] * 0.14
      px[i] += Math.max(-0.1, Math.min(0.1, fx[i] * alpha * 12))
      py[i] += Math.max(-0.1, Math.min(0.1, fy[i] * alpha * 12))
    }
  }

  /* Normalise into [-1, 1], preserving aspect so the constellation is not
     stretched into a smear.

     Scaling by the extreme radius is what the first version did, and it made
     the picture worse the more interesting it got: ONE agent with no edges
     drifts to the rim, and everything that actually has structure gets
     squeezed into an unreadable knot in the middle. So the scale comes from
     a high percentile instead, and the few nodes beyond it are compressed
     toward the rim rather than allowed to set the scale. Ordering is
     preserved — an outlier still reads as an outlier — and the dense core
     keeps the room it needs. */
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    cx += px[i]
    cy += py[i]
  }
  cx /= n
  cy /= n

  const radii = new Float64Array(n)
  for (let i = 0; i < n; i++) radii[i] = Math.hypot(px[i] - cx, py[i] - cy)

  // The core is measured over CONNECTED nodes only. Unconnected ones settle
  // wherever repulsion balances gravity, which is far out and has nothing to
  // do with the structure anyone came to read — letting them vote on the
  // scale is what squeezed the interesting half into a knot.
  const connected = new Set<number>()
  for (const s of springs) {
    connected.add(s.a)
    connected.add(s.b)
  }
  const scaleSample = (connected.size > 0 ? [...connected].map((i) => radii[i]) : [...radii]).sort((a, b) => a - b)
  const core = Math.max(scaleSample[Math.floor((scaleSample.length - 1) * CORE_PERCENTILE)], 1e-6)

  // Inside the core, plain linear scale. Outside, a saturating curve: an
  // isolate twice as far out still lands near the rim rather than doubling
  // the picture's radius. Monotonic, so an outlier still reads as further.
  let maxR = 1e-6
  const adjusted = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    adjusted[i] =
      radii[i] <= core
        ? (CORE_FRACTION * radii[i]) / core
        : CORE_FRACTION + (1 - CORE_FRACTION) * (1 - Math.exp(-(radii[i] - core) / core))
    if (adjusted[i] > maxR) maxR = adjusted[i]
  }

  for (const [id, i] of index) {
    // Scale each node along its own ray, so the compression never rotates
    // anything: the shape is the same picture, just less tyrannised by its
    // furthest dot.
    const k = radii[i] > 1e-9 ? adjusted[i] / radii[i] / maxR : 0
    layout.set(id, { x: (px[i] - cx) * k, y: (py[i] - cy) * k })
  }
  return layout
}
