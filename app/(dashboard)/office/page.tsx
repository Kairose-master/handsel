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
import { Copy, RefreshCw, Loader2, UserPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  myOfficeCode,
  newOfficeCode,
  visitOffice,
  myConnectedOffices,
  myOfficeWorld,
  hireStaff,
  type ConnectedOffice,
} from '@/app/actions/office'
import OfficeWorld from './game/OfficeWorld'
import { LiveOffice, type Agent } from './game/live-engine'
import './game/office.css'

const POLL_MS = 12_000

function HireStaffDialog({ open, onClose, onHired }: { open: boolean; onClose: () => void; onHired: () => void }) {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'platform' | 'mcp'>('platform')
  const [serverUrl, setServerUrl] = useState('')
  const [toolName, setToolName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const reset = () => {
    setName('')
    setMode('platform')
    setServerUrl('')
    setToolName('')
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await hireStaff({
        name,
        mcp: mode === 'mcp' ? { serverUrl, toolName } : undefined,
      })
      reset()
      onHired()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not hire — try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Hire staff</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="hire-name">Name</Label>
            <Input id="hire-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kai" autoFocus />
          </div>

          <div className="flex gap-2">
            <Button type="button" variant={mode === 'platform' ? 'default' : 'outline'} size="sm" onClick={() => setMode('platform')}>
              Quick hire
            </Button>
            <Button type="button" variant={mode === 'mcp' ? 'default' : 'outline'} size="sm" onClick={() => setMode('mcp')}>
              Connect external MCP agent
            </Button>
          </div>

          {mode === 'platform' ? (
            <p className="text-sm text-muted-foreground">
              Creates a platform agent, ready to claim jobs right away — no further setup.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Handsel calls this server only at claim/submit time — no standing connection, no polling from here.
              </p>
              <div>
                <Label htmlFor="hire-url">MCP server URL</Label>
                <Input
                  id="hire-url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://…"
                />
              </div>
              <div>
                <Label htmlFor="hire-tool">Tool name</Label>
                <Input id="hire-tool" value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder="do_the_work" />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            type="submit"
            className="w-full"
            disabled={busy || !name.trim() || (mode === 'mcp' && (!serverUrl.trim() || !toolName.trim()))}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Hire'}
          </Button>
        </form>
      </div>
    </div>
  )
}

function OfficeWorldPanel() {
  const engineRef = useRef(new LiveOffice())
  const [agents, setAgents] = useState<Agent[]>([])
  const [selected, setSelected] = useState<Agent | null>(null)
  const [ceoLine, setCeoLine] = useState('')
  const [hiring, setHiring] = useState(false)
  const [pollTrigger, setPollTrigger] = useState(0)

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
  }, [pollTrigger])

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
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Your office — live</CardTitle>
          <p className="text-xs text-muted-foreground">{ceoLine || 'Loading your agents…'}</p>
        </div>
        <Button size="sm" onClick={() => setHiring(true)}>
          <UserPlus className="mr-1.5 h-4 w-4" />
          Hire staff
        </Button>
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
      <HireStaffDialog open={hiring} onClose={() => setHiring(false)} onHired={() => setPollTrigger((n) => n + 1)} />
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
