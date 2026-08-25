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
import Link from 'next/link'
import { Copy, RefreshCw, Loader2, UserPlus, Building2, Plus, X } from 'lucide-react'
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
  myOfficeSlots,
  newOfficeSlot,
  hireStaff,
  hireOfficeTemplate,
  type ConnectedOffice,
  type HireOfficeTemplateResult,
  type OfficeSlot,
} from '@/app/actions/office'
import { getDelegationAgents } from '@/app/actions/delegate'
import OfficeWorld from './game/OfficeWorld'
import { LiveOffice, type Agent } from './game/live-engine'
import { AGENT_TEMPLATES, OFFICE_TEMPLATES, MAX_OFFICE_SLOTS, colorsFor } from '@/lib/office-world-data'
import './game/office.css'

const POLL_MS = 12_000

function HireStaffDialog({
  open,
  onClose,
  onHired,
  officeSlot,
}: {
  open: boolean
  onClose: () => void
  onHired: () => void
  officeSlot: number
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<'platform' | 'mcp'>('platform')
  const [serverUrl, setServerUrl] = useState('')
  const [toolName, setToolName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const reset = () => {
    setName('')
    setDescription('')
    setMode('platform')
    setServerUrl('')
    setToolName('')
    setError(null)
  }

  const applyTemplate = (t: (typeof AGENT_TEMPLATES)[number]) => {
    setName(t.name)
    setDescription(t.blurb)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await hireStaff({
        name,
        description: description.trim() || undefined,
        mcp: mode === 'mcp' ? { serverUrl, toolName } : undefined,
        officeSlot,
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

  // Close on a mousedown that BEGAN on the backdrop, not on any click that
  // lands there. A native <select> paints its options outside the panel, so
  // picking one that overlaps the backdrop delivered the click here and shut
  // the dialog instead of selecting — which is what "paying agent can't be
  // selected" actually was. The target check also stops a text drag that ends
  // outside from closing it.
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="bp-macro text-lg">Hire staff</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4">
          <Label>Start from a template (optional)</Label>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {AGENT_TEMPLATES.map((t) => {
              const [hair, shirt] = colorsFor(t.colorIndex)
              const active = name === t.name && description === t.blurb
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  title={t.blurb}
                  className={`flex flex-col items-center gap-1 rounded-md border p-2 text-center transition-colors ${
                    active ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50'
                  }`}
                >
                  <span
                    className="h-6 w-6 rounded-full border border-border"
                    style={{ background: `linear-gradient(135deg, ${hair}, ${shirt})` }}
                  />
                  <span className="text-xs font-medium">{t.name}</span>
                </button>
              )
            })}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <Label htmlFor="hire-name">Name</Label>
            <Input id="hire-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kai" autoFocus />
          </div>

          {description && (
            <p className="-mt-2 text-xs text-muted-foreground">{description}</p>
          )}

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

function HireOfficeTemplateDialog({
  open,
  onClose,
  onHired,
  officeSlot,
}: {
  open: boolean
  onClose: () => void
  onHired: () => void
  officeSlot: number
}) {
  const [templateId, setTemplateId] = useState(OFFICE_TEMPLATES[0].id)
  const template = OFFICE_TEMPLATES.find((t) => t.id === templateId) ?? OFFICE_TEMPLATES[0]
  const [agents, setAgents] = useState<Array<{ id: string; name: string; provisioned: boolean }>>([])
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const [primeAgentId, setPrimeAgentId] = useState('')
  const [scope, setScope] = useState(OFFICE_TEMPLATES[0].exampleScope)
  const [scopeTouched, setScopeTouched] = useState(false)
  const [budgetUsd, setBudgetUsd] = useState(String(template.pipeline.length * 2))
  const [budgetTouched, setBudgetTouched] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [mcpServerUrl, setMcpServerUrl] = useState('')
  const [mcpAuthHeader, setMcpAuthHeader] = useState('')
  const [mcpToolNames, setMcpToolNames] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HireOfficeTemplateResult | null>(null)

  useEffect(() => {
    if (!open) return
    // `agentsLoaded` distinguishes "still fetching" from "fetched, and there
    // is genuinely nothing selectable" — without it the empty-state guidance
    // below flashes on every open. A failed fetch counts as loaded with an
    // empty roster, so the dialog explains itself rather than hanging on a
    // silent catch.
    getDelegationAgents()
      .then((list) => {
        setAgents(list)
        if (!primeAgentId) setPrimeAgentId(list.find((a) => a.provisioned)?.id ?? '')
      })
      .catch(() => setAgents([]))
      .finally(() => setAgentsLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // scopeLabel is a full sentence with a parenthetical example. Uppercase
  // mono turns that into two dense lines, so only the head becomes the label
  // and the aside is shown under the field in normal case, where it reads.
  const [scopeLabelHead, scopeLabelAside] = (() => {
    const i = template.scopeLabel.indexOf('(')
    return i === -1
      ? [template.scopeLabel, '']
      : [template.scopeLabel.slice(0, i).trim().replace(/[:?]$/, ''), template.scopeLabel.slice(i + 1).replace(/\)$/, '').trim()]
  })()

  /** At least one agent has an on-chain account, so the form can be completed. */
  const canPay = agents.some((a) => a.provisioned)

  // Picking a template fills the scope with a ready-to-use example — hire is
  // one click for anyone just trying a template, not a blank form. Once the
  // owner types their own scope, switching templates stops overwriting it.
  const selectTemplate = (id: string) => {
    setTemplateId(id)
    const next = OFFICE_TEMPLATES.find((t) => t.id === id)
    if (!scopeTouched) setScope(next?.exampleScope ?? '')
    // The budget default is per-template (2 USD a step) and was only ever set
    // from OFFICE_TEMPLATES[0], so switching to a template with a different
    // step count left the first one's figure sitting in the field. Follow the
    // selection unless the owner has typed their own number.
    if (!budgetTouched && next) setBudgetUsd(String(next.pipeline.length * 2))
  }

  if (!open) return null

  const reset = () => {
    setScope(template.exampleScope)
    setScopeTouched(false)
    setBudgetUsd(String(template.pipeline.length * 2))
    setBudgetTouched(false)
    setMcpOpen(false)
    setMcpServerUrl('')
    setMcpAuthHeader('')
    setMcpToolNames({})
    setError(null)
    setResult(null)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await hireOfficeTemplate({
        templateId: template.id,
        primeAgentId,
        scope,
        budgetUsd: Number(budgetUsd),
        mcpServerUrl: mcpOpen ? mcpServerUrl : undefined,
        mcpAuthHeader: mcpOpen ? mcpAuthHeader : undefined,
        mcpToolNames: mcpOpen ? mcpToolNames : undefined,
        officeSlot,
      })
      if ('error' in res) {
        setError(res.error)
        return
      }
      setResult(res)
      onHired()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not hire the office — try again')
    } finally {
      setBusy(false)
    }
  }

  // Close on a mousedown that BEGAN on the backdrop, not on any click that
  // lands there. A native <select> paints its options outside the panel, so
  // picking one that overlaps the backdrop delivered the click here and shut
  // the dialog instead of selecting — which is what "paying agent can't be
  // selected" actually was. The target check also stops a text drag that ends
  // outside from closing it.
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose()
      }}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="bp-macro text-lg">{result ? template.name : 'Hire a template office'}</h2>
          <button onClick={handleClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {result ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Hired {result.hired.length} agents and drafted the pipeline between them. Nothing is escrowed yet —
              review the exact subtasks and bounties on the delegate page before confirming.
            </p>
            <ul className="space-y-1 text-sm">
              {result.hired.map((h) => (
                <li key={h.agentId} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                  <span>{h.name}</span>
                  {h.mcpConnected && <span className="text-xs text-muted-foreground">MCP connected</span>}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Link href="/delegate" className="flex-1">
                <Button className="w-full">Review & confirm on /delegate</Button>
              </Link>
              <Button
                variant="outline"
                onClick={() => {
                  reset()
                  onClose()
                }}
              >
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Template picker as one hairline-divided register, not four
                floating cards: they are alternatives in a single list, and
                boxing each one gave them all equal weight and turned the
                dialog into a wall of prose. The blurb is dropped — flowSummary
                already says what the office does, in one line. Selection is a
                solid red rail, not a tint wash, so it reads at a glance. */}
            <fieldset>
              <legend className="bp-micro text-muted-foreground">[ Template ]</legend>
              <div className="bp-hair mt-2 border border-border">
                {OFFICE_TEMPLATES.map((t, i) => {
                  const active = t.id === templateId
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => selectTemplate(t.id)}
                      className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                        active ? 'bg-secondary' : 'hover:bg-secondary/60'
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`mt-0.5 w-1 self-stretch ${active ? 'bg-primary' : 'bg-transparent'}`}
                      />
                      <span className={`font-mono text-xs tabular-nums ${active ? 'text-primary' : 'text-muted-foreground'}`}>
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="bp-macro block text-[0.9rem]">{t.name}</span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t.flowSummary}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </fieldset>

            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="office-scope" className="bp-micro text-muted-foreground">{scopeLabelHead}</Label>
                {scopeTouched && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                    onClick={() => {
                      setScope(template.exampleScope)
                      setScopeTouched(false)
                    }}
                  >
                    Use example
                  </button>
                )}
              </div>
              <Input
                id="office-scope"
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value)
                  setScopeTouched(true)
                }}
                autoFocus
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {scopeLabelAside && <span>{scopeLabelAside}. </span>}
                {!scopeTouched && <span>Pre-filled with an example — edit it, or hire as-is.</span>}
              </p>
            </div>

            <div>
              <Label htmlFor="office-prime" className="bp-micro text-muted-foreground">Paying agent — escrows the bounties on confirm</Label>
              <select
                id="office-prime"
                value={primeAgentId}
                onChange={(e) => setPrimeAgentId(e.target.value)}
                disabled={agentsLoaded && !canPay}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
              >
                <option value="">Select an agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.provisioned}>
                    {a.name}{a.provisioned ? '' : ' (not provisioned)'}
                  </option>
                ))}
              </select>
              {/* Without this the dialog is a dead end: an agent can only pay
                  once it has an on-chain smart account, so with none
                  provisioned EVERY option renders disabled and the form
                  cannot be completed — with nothing on screen saying why or
                  where to go. Say both. */}
              {agentsLoaded && agents.length === 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  You don&apos;t have any agents yet.{' '}
                  <Link href="/agents" className="text-primary hover:underline">
                    Create one
                  </Link>
                  , then provision it so it can hold the escrow.
                </p>
              )}
              {agentsLoaded && agents.length > 0 && !canPay && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  None of your agents can pay yet — escrowing a bounty needs an on-chain smart account, and none of
                  them has one.{' '}
                  <Link href="/profile" className="text-primary hover:underline">
                    Provision one on the profile page
                  </Link>{' '}
                  (On-Chain card), then reopen this dialog.
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="office-budget" className="bp-micro text-muted-foreground">Total budget · USD · split across {template.pipeline.length} step{template.pipeline.length === 1 ? '' : 's'}</Label>
              <Input
                id="office-budget"
                type="number"
                min={template.pipeline.length}
                step="1"
                value={budgetUsd}
                onChange={(e) => {
                  setBudgetUsd(e.target.value)
                  setBudgetTouched(true)
                }}
              />
            </div>

            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setMcpOpen((v) => !v)}>
                {mcpOpen ? 'Hide' : template.usesMarketData ? 'Connect real market data (optional)' : 'Connect external tools (optional)'}
              </Button>
              {mcpOpen && (
                <div className="mt-3 space-y-3 rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">
                    Leave a role's tool name blank to keep it a plain platform agent — nothing here is pre-filled with
                    a guessed tool name. Not sure what to connect?{' '}
                    <a href="/directory" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      Browse ClawHub skills
                    </a>{' '}
                    for capability ideas, or read the{' '}
                    <a href="/office/mcp-guide" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      step-by-step wiring guide
                    </a>{' '}
                    (Exa, securities-mcp, obsidian-mcp) — any MCP server can be wired in below the same way.
                  </p>
                  <div>
                    <Label htmlFor="office-mcp-url" className="bp-micro text-muted-foreground">MCP server URL — shared by every role below</Label>
                    <Input id="office-mcp-url" value={mcpServerUrl} onChange={(e) => setMcpServerUrl(e.target.value)} placeholder="https://…" />
                    <button
                      type="button"
                      className="mt-1 text-xs text-primary hover:underline"
                      onClick={() => setMcpServerUrl('https://mcp.exa.ai/mcp')}
                    >
                      Use Exa web search (real, no signup — tool name <code>web_search_exa</code>; add <code>?exaApiKey=…</code> for reliability)
                    </button>
                  </div>
                  <div>
                    <Label htmlFor="office-mcp-auth" className="bp-micro text-muted-foreground">Auth header — optional</Label>
                    <Input id="office-mcp-auth" value={mcpAuthHeader} onChange={(e) => setMcpAuthHeader(e.target.value)} placeholder="Bearer …" />
                  </div>
                  {template.roles.map((r) => (
                    <div key={r.id}>
                      <Label htmlFor={`office-tool-${r.id}`} className="bp-micro text-muted-foreground">{r.name} tool name</Label>
                      <Input
                        id={`office-tool-${r.id}`}
                        value={mcpToolNames[r.id] ?? ''}
                        onChange={(e) => setMcpToolNames((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        placeholder={r.mcpHint}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" className="w-full" disabled={busy || !primeAgentId || scope.trim().length < 2}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Hire the office'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}

function OfficeWorldPanel({ slot }: { slot: number }) {
  const engineRef = useRef(new LiveOffice())
  const [agents, setAgents] = useState<Agent[]>([])
  const [selected, setSelected] = useState<Agent | null>(null)
  const [ceoLine, setCeoLine] = useState('')
  const [hiring, setHiring] = useState(false)
  const [hiringTemplate, setHiringTemplate] = useState(false)
  const [pollTrigger, setPollTrigger] = useState(0)

  useEffect(() => {
    let dead = false
    // Switching offices swaps the whole roster — start the new one from a
    // blank engine rather than tweening yesterday's office's agents into
    // today's positions.
    engineRef.current = new LiveOffice()
    setAgents([])
    setSelected(null)
    const poll = async () => {
      try {
        const snap = await myOfficeWorld(slot)
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
  }, [slot, pollTrigger])

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
        <div className="flex gap-2">
          <Link href="/office/orders">
            <Button size="sm" variant="outline">
              Paper orders
            </Button>
          </Link>
          <Button size="sm" variant="outline" onClick={() => setHiringTemplate(true)}>
            <Building2 className="mr-1.5 h-4 w-4" />
            Hire a template office
          </Button>
          <Button size="sm" onClick={() => setHiring(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            Hire staff
          </Button>
        </div>
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
      <HireStaffDialog
        open={hiring}
        onClose={() => setHiring(false)}
        onHired={() => setPollTrigger((n) => n + 1)}
        officeSlot={slot}
      />
      <HireOfficeTemplateDialog
        open={hiringTemplate}
        onClose={() => setHiringTemplate(false)}
        onHired={() => setPollTrigger((n) => n + 1)}
        officeSlot={slot}
      />
    </Card>
  )
}

function OfficeTabs({
  slots,
  activeSlot,
  onSelect,
  onCreated,
}: {
  slots: OfficeSlot[]
  activeSlot: number
  onSelect: (slot: number) => void
  onCreated: (slot: number) => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await newOfficeSlot(name)
      if ('error' in res) {
        setError(res.error)
        return
      }
      setName('')
      setAdding(false)
      onCreated(res.slot)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {slots.map((s) => (
        <button
          key={s.slot}
          onClick={() => onSelect(s.slot)}
          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
            s.slot === activeSlot ? 'border-primary bg-primary/10 font-medium' : 'border-border text-muted-foreground hover:bg-muted/50'
          }`}
        >
          {s.name}
        </button>
      ))}
      {slots.length < MAX_OFFICE_SLOTS &&
        (adding ? (
          <form onSubmit={submit} className="flex items-center gap-1.5">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Office name" className="h-8 w-40" autoFocus />
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Add'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </form>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/50"
          >
            <Plus className="h-3.5 w-3.5" />
            New office
          </button>
        ))}
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
    </div>
  )
}

export default function OfficePage() {
  const [code, setCode] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [visitCode, setVisitCode] = useState('')
  const [visiting, setVisiting] = useState(false)
  const [visitMessage, setVisitMessage] = useState<string | null>(null)
  const [connections, setConnections] = useState<ConnectedOffice[]>([])
  const [slots, setSlots] = useState<OfficeSlot[]>([])
  const [activeSlot, setActiveSlot] = useState(1)
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    const [c, list, officeList] = await Promise.all([myOfficeCode(), myConnectedOffices(), myOfficeSlots()])
    setCode(c)
    setConnections(list)
    setSlots(officeList)
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
          Up to {MAX_OFFICE_SLOTS} offices per account — split your agents across them, or run one team.
        </p>
      </div>

      <OfficeTabs
        slots={slots}
        activeSlot={activeSlot}
        onSelect={setActiveSlot}
        onCreated={(slot) => {
          refresh()
          setActiveSlot(slot)
        }}
      />

      <OfficeWorldPanel slot={activeSlot} />

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
