'use client'

/**
 * Agent-to-agent conversation pings — the animation for
 * lib/office-conversations.ts's real negotiation messages (agent_messages
 * rows inside the freshness window, both endpoints on this roster —
 * that module's header is the reality bar; this component only draws
 * what it is handed).
 *
 * One message renders as: a faint dashed "chat link" between the two
 * agents' LIVE positions, and a kind-icon envelope that repeatedly pings
 * from sender to receiver along a low arc. The whole thing fades with the
 * message's real age — a 9-minute-old accept is a ghost, a 30-second-old
 * proposal is bright — so the scene reads as "now" without a timestamp in
 * anyone's face (the tooltip carries the real preview text and kind).
 *
 * Inspect-only like everything else in the diorama: pings are
 * pointer-events:none facts to notice, never controls.
 */
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { AgentConversation } from '@/lib/office-world-data'
import { CONVERSATION_WINDOW_MS } from '@/lib/office-conversations'
import type { Agent } from '../game/live-engine'
import { THEMES, type OfficeTheme } from './theme'
import { useSceneStore } from './scene-store'

const KIND_ICON: Record<AgentConversation['kind'], string> = {
  inquiry: '💬',
  info: '📄',
  proposal: '🤝',
  counter: '🔁',
  accept: '✅',
  reject: '❌',
  verified_proposal: '🛡️',
}

const KIND_LABEL: Record<AgentConversation['kind'], string> = {
  inquiry: 'inquiry',
  info: 'info',
  proposal: 'job proposal',
  counter: 'counter-proposal',
  accept: 'proposal accepted',
  reject: 'proposal rejected',
  verified_proposal: 'verified-task proposal',
}

const PING_DURATION_S = 2.0
const CHAT_HEIGHT = 1.25 // just above avatar head height — a chat line, not a package arc
const ARC_EXTRA = 0.5

function conversationColor(theme: OfficeTheme, kind: AgentConversation['kind']): string {
  if (kind === 'accept') return theme.ok
  if (kind === 'reject') return theme.danger
  if (kind === 'counter' || kind === 'proposal' || kind === 'verified_proposal') return theme.warn
  return theme.accent
}

function ConversationPing({ convo, agents, theme }: { convo: AgentConversation; agents: Agent[]; theme: OfficeTheme }) {
  const fromAgent = useMemo(() => agents.find((a) => a.id === convo.fromAgentId) ?? null, [agents, convo.fromAgentId])
  const toAgent = useMemo(() => agents.find((a) => a.id === convo.toAgentId) ?? null, [agents, convo.toAgentId])
  const groupRef = useRef<THREE.Group>(null)
  const lineRef = useRef<React.ComponentRef<typeof Line>>(null)
  const elapsed = useRef(Math.random() * PING_DURATION_S)
  const a = useRef(new THREE.Vector3())
  const b = useRef(new THREE.Vector3())

  const fromName = fromAgent?.name ?? convo.fromAgentId
  const toName = toAgent?.name ?? convo.toAgentId

  useFrame((_, dt) => {
    if (!fromAgent || !toAgent) return
    a.current.set(fromAgent.x + 0.5, CHAT_HEIGHT, fromAgent.y + 0.5)
    b.current.set(toAgent.x + 0.5, CHAT_HEIGHT, toAgent.y + 0.5)
    lineRef.current?.geometry.setPositions([a.current.x, a.current.y, a.current.z, b.current.x, b.current.y, b.current.z])

    // Real-age fade: bright when fresh, ghost near the window's edge.
    const age = Date.now() - new Date(convo.at).getTime()
    const freshness = Math.max(0.15, 1 - age / CONVERSATION_WINDOW_MS)

    elapsed.current = (elapsed.current + dt) % PING_DURATION_S
    const t = elapsed.current / PING_DURATION_S
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    const g = groupRef.current
    if (g) {
      g.position.lerpVectors(a.current, b.current, eased)
      g.position.y += Math.sin(eased * Math.PI) * ARC_EXTRA
      const fade = (t < 0.15 ? t / 0.15 : t > 0.85 ? (1 - t) / 0.15 : 1) * freshness
      g.visible = fade > 0.04
      g.scale.setScalar(0.8 + fade * 0.2)
    }
  })

  // Both endpoints must be live sprites — a ping with a missing end would
  // point at nothing. (The pure filter already guarantees roster
  // membership at snapshot time; this covers the frame-level gap while a
  // roster change is mid-tween.)
  if (!fromAgent || !toAgent) return null

  return (
    <>
      <Line
        ref={lineRef}
        points={[
          [0, CHAT_HEIGHT, 0],
          [0, CHAT_HEIGHT, 1],
        ]}
        color={conversationColor(theme, convo.kind)}
        dashed
        dashSize={0.18}
        gapSize={0.22}
        lineWidth={1}
        transparent
        opacity={0.35}
        toneMapped={false}
      />
      <group ref={groupRef}>
        <Html center occlude={false}>
          <div className="convo3d-ping" title={`${fromName} → ${toName} · ${KIND_LABEL[convo.kind]}: ${convo.preview}`}>
            {KIND_ICON[convo.kind]}
          </div>
        </Html>
      </group>
    </>
  )
}

export function AgentConversations3D({ conversations, agents }: { conversations: AgentConversation[]; agents: Agent[] }) {
  const theme = THEMES[useSceneStore((s) => s.themeId)]
  // One ping per (from,to) pair — the NEWEST message wins the animation so
  // a rapid proposal→counter→accept chain shows its latest state instead
  // of three overlapping arcs on the same line.
  const latestPerPair = useMemo(() => {
    const seen = new Map<string, AgentConversation>()
    for (const c of conversations) {
      const key = [c.fromAgentId, c.toAgentId].sort().join('::')
      if (!seen.has(key)) seen.set(key, c) // conversations arrive newest-first
    }
    return [...seen.values()]
  }, [conversations])

  return (
    <>
      {latestPerPair.map((c) => (
        <ConversationPing key={c.id} convo={c} agents={agents} theme={theme} />
      ))}
    </>
  )
}
