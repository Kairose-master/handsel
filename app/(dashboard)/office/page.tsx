'use client'

/**
 * /office — a live pixel-office of your own agents, plus connecting to
 * other accounts with a shareable code.
 *
 * The visual is a real-data-driven descendant of a reference pixel-office
 * toy — see app/(dashboard)/office/game/live-engine.ts's header for why its
 * original scripted-day engine was NOT reused as-is (it would have put real
 * agent names on entirely invented activity). Every room an agent stands in
 * and every line above its head comes from lib/office-world-data.ts's real
 * query of that agent's actual state, polled here on an interval — not a
 * script.
 *
 * A connection (the code below) is a discovery relationship, not a
 * permission grant: the market is already permissionless on-chain (see
 * lib/office.ts), so this page does not gate who can claim what.
 */
import { useEffect, useRef, useState } from 'react'
import { Copy, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { myOfficeCode, newOfficeCode, visitOffice, myConnectedOffices, myOfficeWorld, type ConnectedOffice } from '@/app/actions/office'
import OfficeWorld from './game/OfficeWorld'
import { LiveOffice, type Agent } from './game/live-engine'
import './game/office.css'

const POLL_MS = 12_000

function OfficeWorldPanel() {
  const engineRef = useRef(new LiveOffice())
  const [agents, setAgents] = useState<Agent[]>([])
  const [selected, setSelected] = useState<Agent | null>(null)
  const [ceoLine, setCeoLine] = useState('')

  useEffect(() => {
    let dead = false
    const poll = async () => {
      try {
        const snap = await myOfficeWorld()
        if (dead) return
        engineRef.current.applySnapshot(snap)
        setAgents([...engineRef.current.agents])
        setCeoLine(snap.ceoLine)
      } catch (error) {
        console.error('[office] snapshot poll failed:', error)
      }
    }
    poll()
    const interval = setInterval(poll, POLL_MS)
    return () => {
      dead = true
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      engineRef.current.tick(dt)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your office — live</CardTitle>
        <p className="text-xs text-muted-foreground">{ceoLine || 'Loading your agents…'}</p>
      </CardHeader>
      <CardContent>
        <div style={{ height: 480 }} className="overflow-hidden rounded-lg border border-border">
          <OfficeWorld agents={agents} selectedId={selected?.id ?? null} follow={false} onSelect={setSelected} />
        </div>
        {selected && (
          <div className="mt-3 rounded-md border border-border bg-muted/50 p-3 text-sm">
            <div className="font-semibold">{selected.name}</div>
            <div className="text-muted-foreground">{selected.status}</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function OfficePage() {
  const [code, setCode] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [visitCode, setVisitCode] = useState('')
  const [visiting, setVisiting] = useState(false)
  const [visitMessage, setVisitMessage] = useState<string | null>(null)
  const [connections, setConnections] = useState<ConnectedOffice[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    const [c, list] = await Promise.all([myOfficeCode(), myConnectedOffices()])
    setCode(c)
    setConnections(list)
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [])

  const handleRegenerate = async () => {
    setRegenerating(true)
    try {
      setCode(await newOfficeCode())
    } finally {
      setRegenerating(false)
    }
  }

  const handleVisit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!visitCode.trim()) return
    setVisiting(true)
    setVisitMessage(null)
    try {
      const result = await visitOffice(visitCode)
      if (result.connected) {
        setVisitMessage(`Connected to ${result.ownerName}'s office.`)
        setVisitCode('')
        await refresh()
      } else if (result.reason === 'self') {
        setVisitMessage("That's your own code.")
      } else {
        setVisitMessage("That code doesn't match any office.")
      }
    } finally {
      setVisiting(false)
    }
  }

  const copyCode = () => {
    if (code) navigator.clipboard.writeText(code)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-bold">Office</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Share your code so another account can connect to your office, or use theirs to connect to yours.
        </p>
      </div>

      <OfficeWorldPanel />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your code</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2">
          <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm">{code}</code>
          <Button variant="outline" size="icon" onClick={copyCode} title="Copy">
            <Copy className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={handleRegenerate} disabled={regenerating} title="Regenerate">
            <RefreshCw className={`h-4 w-4 ${regenerating ? 'animate-spin' : ''}`} />
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Visit an office</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleVisit} className="flex gap-2">
            <Input
              value={visitCode}
              onChange={(e) => setVisitCode(e.target.value)}
              placeholder="Paste a code"
              className="font-mono"
            />
            <Button type="submit" disabled={visiting || !visitCode.trim()}>
              {visiting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
            </Button>
          </form>
          {visitMessage && <p className="mt-2 text-sm text-muted-foreground">{visitMessage}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected offices ({connections.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No connections yet — share your code to get started.</p>
          ) : (
            <ul className="divide-y divide-border">
              {connections.map((c) => (
                <li key={c.userId} className="py-2 text-sm">
                  {c.name}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
