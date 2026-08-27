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
import { Copy, RefreshCw, Loader2, UserPlus, Building2, Plus, X, Maximize2, Minimize2, Plug, Unplug } from 'lucide-react'
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
  officeHireAgents,
  officeRoster,
  type OfficeRosterAgent,
  officeSource,
  saveOfficeSource,
  type OfficeSourceView,
  testMcpConnector,
  newOfficeSlot,
  hireStaff,
  hireOfficeTemplate,
  type ConnectedOffice,
} from '@/app/actions/office'
import { setMcpWorker, disconnectMcpWorker } from '@/app/actions/webhook'
import OfficeWorld from './game/OfficeWorld'
import { LiveOffice, type Agent } from './game/live-engine'
import {
  AGENT_TEMPLATES,
  OFFICE_TEMPLATES,
  MAX_OFFICE_SLOTS,
  colorsFor,
  officeStepBounties,
  defaultWiringFor,
  type OfficeSlot,
  type McpConnector,
  type McpBinding,
  type HireOfficeTemplateResult,
} from '@/lib/office-world-data'
import './game/office.css'

const POLL_MS = 12_000

/**
 * Call the server and say whether the tool is actually there.
 *
 * A connector's first proof of life used to be a job that had already escrowed
 * money and came back empty — a typo in a URL, a tool renamed upstream and a
 * worker that simply did badly were indistinguishable after the fact. This
 * moves that answer before the hire. It reports the argument key the tool will
 * receive too, because that is the other thing that silently goes wrong: the
 * client picks one string parameter from the tool's schema, and seeing which
 * one is how you notice it picked the wrong field.
 */
function TestConnectorButton({
  serverUrl,
  toolName,
  authHeader,
}: {
  serverUrl: string
  toolName: string
  authHeader?: string
}) {
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    setState(null)
    try {
      const res = await testMcpConnector(serverUrl, toolName, authHeader)
      setState(
        res.ok
          ? { ok: true, text: `reachable · sends its input as "${res.argKey}"` }
          : { ok: false, text: res.error },
      )
    } catch (e) {
      setState({ ok: false, text: e instanceof Error ? e.message : 'Could not reach that server' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={run}
        disabled={busy || !serverUrl.trim() || !toolName.trim()}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Test'}
      </Button>
      {state && (
        <span className={`text-xs ${state.ok ? 'text-success' : 'text-destructive'}`}>{state.text}</span>
      )}
    </div>
  )
}

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
          <h2 className="text-lg font-semibold">Hire staff</h2>
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
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [primeAgentId, setPrimeAgentId] = useState('')
  const [scope, setScope] = useState(OFFICE_TEMPLATES[0].exampleScope)
  const [scopeTouched, setScopeTouched] = useState(false)
  const [budgetUsd, setBudgetUsd] = useState(String(template.pipeline.length * 2))
  const [budgetTouched, setBudgetTouched] = useState(false)
  // Pre-filled from the template, not blank. A template that ships working
  // endpoints and still opens this section empty is a template that made you
  // do the setup anyway.
  const initialWiring = defaultWiringFor(OFFICE_TEMPLATES[0])
  const [mcpOpen, setMcpOpen] = useState(initialWiring.connectors.length > 0)
  // Several connectors per office, each role bound to one of them. The agent
  // table has always stored mcpServerUrl per agent; only this form forced a
  // single shared URL, which is what stopped an office from running (say) web
  // search, a private vault and market data side by side.
  const [connectors, setConnectors] = useState<McpConnector[]>(initialWiring.connectors)
  const [bindings, setBindings] = useState<Record<string, McpBinding>>(initialWiring.bindings)
  // Per-step payers. An office had one paying agent only because the
  // delegation posted every job from its prime; escrow comes from whoever
  // posts, so a step can just as well be funded by a different wallet.
  // Empty = the prime pays for everything, which is the old behavior.
  const [billOpen, setBillOpen] = useState(false)
  const [payerByRoleId, setPayerByRoleId] = useState<Record<string, string>>({})
  // Shown, not just applied: the shared source goes into every role's brief,
  // and /delegate lists subtask titles rather than their full text, so
  // without this line the one document all these agents will read would be
  // invisible at the moment of hiring them.
  const [sharedSource, setSharedSource] = useState<OfficeSourceView | null>(null)
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
    setAgentsError(null)
    officeSource(officeSlot)
      .then(setSharedSource)
      .catch((err) => {
        // Non-fatal: the hire still works and the source is still applied
        // server-side. Only the notice below is missing, so don't block on it.
        console.error('[office] could not read the shared source:', err)
      })
    officeHireAgents()
      .then((list) => {
        setAgents(list)
        if (!primeAgentId) setPrimeAgentId(list.find((a) => a.provisioned)?.id ?? '')
      })
      .catch((err) => {
        // A failed read is NOT "you have no agents". Saying so told an owner
        // with a funded, provisioned agent on screen that they had none —
        // the page asserting something it does not know. Keep them apart and
        // show what actually went wrong.
        console.error('[office] could not load agents:', err)
        setAgents([])
        setAgentsError(err instanceof Error ? err.message : 'Could not load your agents.')
      })
      .finally(() => setAgentsLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, officeSlot])

  // scopeLabel is a full sentence with a parenthetical example. Uppercase
  // mono turns that into two dense lines, so only the head becomes the label
  // and the aside is shown under the field in normal case, where it reads.
  const [scopeLabelHead, scopeLabelAside] = (() => {
    const i = template.scopeLabel.indexOf('(')
    return i === -1
      ? [template.scopeLabel, '']
      : [template.scopeLabel.slice(0, i).trim().replace(/[:?]$/, ''), template.scopeLabel.slice(i + 1).replace(/\)$/, '').trim()]
  })()

  const addConnector = (seed?: Partial<McpConnector>) =>
    setConnectors((prev) => [
      ...prev,
      { id: `c${Date.now()}${prev.length}`, label: '', serverUrl: '', ...seed },
    ])

  const updateConnector = (id: string, patch: Partial<McpConnector>) =>
    setConnectors((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  /** Removing a connector also clears any role still pointing at it, so a
   *  binding can never reference one that is gone. */
  const removeConnector = (id: string) => {
    setConnectors((prev) => prev.filter((c) => c.id !== id))
    setBindings((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([, b]) => b.connectorId !== id)),
    )
  }

  /** Clearing the connector drops the whole binding rather than leaving an
   *  orphan tool name behind. */
  const bindRole = (roleId: string, patch: Partial<McpBinding>) =>
    setBindings((prev) => {
      const next = { ...(prev[roleId] ?? { connectorId: '', toolName: '' }), ...patch }
      if (!next.connectorId) {
        const { [roleId]: _drop, ...rest } = prev
        return rest
      }
      return { ...prev, [roleId]: next }
    })

  /** At least one agent has an on-chain account, so the form can be completed. */
  const canPay = agents.some((a) => a.provisioned)
  // The same arithmetic the hire action escrows with (lib/office-world-data),
  // not a second copy of it — the amount shown beside a step is the amount
  // that step's payer is actually asked for.
  const budgetOk = Number.isFinite(Number(budgetUsd)) && Number(budgetUsd) > 0
  const stepBounties = officeStepBounties(template, budgetOk ? Number(budgetUsd) : 0)
  // Each step's share rounds to cents on its own, so a weighted split can
  // land a cent or two off the figure typed above. Shown rather than
  // absorbed: the escrow is the sum of the steps, not the number in the box.
  const bountyTotal = [...stepBounties.values()].reduce((sum, x) => sum + x, 0)
  const splitSteps = template.pipeline.filter((step) => {
    const picked = payerByRoleId[step.roleId]
    return Boolean(picked) && picked !== primeAgentId
  }).length

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
    // Role ids are per-template, so keeping the old picks would leave entries
    // that quietly match nothing.
    setPayerByRoleId({})
    const wiring = next ? defaultWiringFor(next) : { connectors: [], bindings: {} }
    setConnectors(wiring.connectors)
    setBindings(wiring.bindings)
    setMcpOpen(wiring.connectors.length > 0)
  }

  if (!open) return null

  const reset = () => {
    setScope(template.exampleScope)
    setScopeTouched(false)
    setBudgetUsd(String(template.pipeline.length * 2))
    setBudgetTouched(false)
    const wiring = defaultWiringFor(template)
    setMcpOpen(wiring.connectors.length > 0)
    setConnectors(wiring.connectors)
    setBindings(wiring.bindings)
    setBillOpen(false)
    setPayerByRoleId({})
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
        mcpConnectors: mcpOpen ? connectors : undefined,
        mcpBindings: mcpOpen ? bindings : undefined,
        // Sent whether or not the section is expanded — collapsing is only
        // hiding, and a pick that silently stopped applying would move money
        // from a wallet the person thought they had reassigned.
        payerByRoleId: splitSteps > 0 ? payerByRoleId : undefined,
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
          <h2 className="text-lg font-semibold">{result ? template.name : 'Hire a template office'}</h2>
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
                <li key={h.agentId} className="flex flex-wrap items-center gap-x-2 rounded-md border border-border px-3 py-1.5">
                  <span>{h.name}</span>
                  {h.mcpConnected && <span className="ml-auto text-xs text-muted-foreground">MCP connected</span>}
                  {/* Stated, not implied by an absent label: a role with no
                      wallet cannot claim even its own reserved job. */}
                  {!h.provisioned && <span className="ml-auto text-xs text-destructive">no wallet — cannot claim work</span>}
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
              <legend className="label-eyebrow text-muted-foreground">[ Template ]</legend>
              <div className="hairline-grid mt-2 border border-border">
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
                        <span className="block text-sm font-semibold">{t.name}</span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t.flowSummary}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </fieldset>

            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="office-scope" className="label-eyebrow text-muted-foreground">{scopeLabelHead}</Label>
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
              {sharedSource && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Every role&apos;s brief will also carry this office&apos;s shared source
                  {sharedSource.title ? ` — “${sharedSource.title}”` : ''} (
                  {sharedSource.body.length.toLocaleString()} characters). Edit it on the office page.
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="office-prime" className="label-eyebrow text-muted-foreground">Paying agent — escrows the bounties on confirm</Label>
              <select
                id="office-prime"
                value={primeAgentId}
                onChange={(e) => setPrimeAgentId(e.target.value)}
                disabled={agentsLoaded && !agentsError && !canPay}
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
              {agentsError && (
                <p className="mt-1.5 text-xs text-destructive">
                  Couldn&apos;t load your agents — {agentsError}. This is a read failing, not an empty account; close
                  and reopen to retry.
                </p>
              )}
              {agentsLoaded && !agentsError && agents.length === 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  You don&apos;t have any agents yet.{' '}
                  <Link href="/agents" className="text-primary hover:underline">
                    Create one
                  </Link>
                  , then provision it so it can hold the escrow.
                </p>
              )}
              {agentsLoaded && !agentsError && agents.length > 0 && !canPay && (
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
              <Label htmlFor="office-budget" className="label-eyebrow text-muted-foreground">Total budget · USD · split across {template.pipeline.length} step{template.pipeline.length === 1 ? '' : 's'}</Label>
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
              {budgetOk && Math.abs(bountyTotal - Number(budgetUsd)) >= 0.005 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Escrows ${bountyTotal.toFixed(2)} — each step&apos;s share rounds to cents on its own.
                </p>
              )}
            </div>

            {/* Per-step payers. Collapsed by default because one payer is the
                ordinary case; the summary line means a pick is never hidden
                by collapsing the section. */}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setBillOpen((v) => !v)}>
                {billOpen ? 'Hide' : 'Split the bill across agents (optional)'}
              </Button>
              {!billOpen && splitSteps > 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {splitSteps} step{splitSteps === 1 ? '' : 's'} billed to another agent.
                </p>
              )}
              {billOpen && (
                <div className="mt-3 space-y-2 rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">
                    Each step escrows from whichever agent posts it, so an office doesn&apos;t have to run on one
                    wallet — a research step can come out of one budget and a legal review out of another. Left on
                    the prime, everything bills to it as before. Amounts are this step&apos;s share of the budget.
                  </p>
                  <div className="hairline-grid overflow-hidden rounded-md border border-border">
                    {template.pipeline.map((step, i) => (
                      <div key={step.roleId} className="flex flex-wrap items-center gap-2 px-2.5 py-2">
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {step.title.replaceAll('{scope}', scope)}
                        </span>
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {/* A dash, not $1.00: with the budget field empty
                              the split floors every step, and printing that
                              would state an amount nothing is going to
                              escrow. */}
                          {budgetOk ? `$${(stepBounties.get(step.roleId) ?? 0).toFixed(2)}` : '—'}
                        </span>
                        <select
                          aria-label={`Who pays for ${step.title.replaceAll('{scope}', scope)}`}
                          value={payerByRoleId[step.roleId] ?? ''}
                          onChange={(e) =>
                            setPayerByRoleId((prev) => {
                              const next = { ...prev }
                              if (e.target.value) next[step.roleId] = e.target.value
                              else delete next[step.roleId]
                              return next
                            })
                          }
                          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs sm:w-48"
                        >
                          <option value="">Prime agent</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id} disabled={!a.provisioned}>
                              {a.name}
                              {a.provisioned ? '' : ' (not provisioned)'}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setMcpOpen((v) => !v)}>
                {mcpOpen ? 'Hide' : template.usesMarketData ? 'Connect real market data (optional)' : 'Connect external tools (optional)'}
              </Button>
              {mcpOpen && (
                <div className="mt-3 space-y-4 rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">
                    Add one connector per source, then point each role at the one it should use — an office can run
                    several at once (web search for the researcher, your vault for the scribe, market data for the
                    analyst). A role you leave unbound stays a plain platform agent; nothing is pre-filled with a
                    guessed tool name.{' '}
                    <a href="/office/mcp-guide" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      Wiring guide
                    </a>
                    {' · '}
                    <a href="/directory" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      ClawHub skills
                    </a>
                  </p>

                  <div className="space-y-2">
                    <Label className="label-eyebrow text-muted-foreground">Connectors</Label>
                    {connectors.length === 0 && (
                      <p className="text-xs text-muted-foreground">None yet — add one below.</p>
                    )}
                    {connectors.map((c, i) => (
                      <div key={c.id} className="hairline-grid overflow-hidden rounded-md border border-border">
                        <div className="flex items-center gap-2 px-2.5 py-2">
                          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                            {String(i + 1).padStart(2, '0')}
                          </span>
                          <Input
                            aria-label="Connector name"
                            value={c.label}
                            onChange={(e) => updateConnector(c.id, { label: e.target.value })}
                            placeholder="Name (e.g. Exa web search)"
                            className="h-8 flex-1"
                          />
                          <button
                            type="button"
                            onClick={() => removeConnector(c.id)}
                            className="press text-muted-foreground hover:text-destructive"
                            aria-label={`Remove ${c.label || 'connector'}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="px-2.5 py-2">
                          <Input
                            aria-label="Server URL"
                            value={c.serverUrl}
                            onChange={(e) => updateConnector(c.id, { serverUrl: e.target.value })}
                            placeholder="https://…/mcp"
                            className="h-8"
                          />
                        </div>
                        <div className="px-2.5 py-2">
                          <Input
                            aria-label="Auth header"
                            value={c.authHeader ?? ''}
                            onChange={(e) => updateConnector(c.id, { authHeader: e.target.value })}
                            placeholder="Authorization header — optional (Bearer …)"
                            className="h-8"
                          />
                        </div>
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => addConnector()}>
                        <Plus className="mr-1 h-3.5 w-3.5" /> Add connector
                      </Button>
                      {/* Verified live earlier: Exa's public endpoint answers
                          anonymously, and its key rides in the query string
                          because Handsel only stores an Authorization header. */}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => addConnector({ label: 'Exa web search', serverUrl: 'https://mcp.exa.ai/mcp' })}
                      >
                        + Exa web search
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="label-eyebrow text-muted-foreground">Role bindings</Label>
                    {template.roles.map((r) => {
                      const b = bindings[r.id]
                      return (
                        <div key={r.id} className="grid gap-1.5 sm:grid-cols-[1fr_1fr] sm:items-center">
                          <div className="flex items-center gap-2">
                            <span className="w-28 shrink-0 truncate text-xs font-medium">{r.name}</span>
                            <select
                              aria-label={`${r.name} connector`}
                              value={b?.connectorId ?? ''}
                              onChange={(e) => bindRole(r.id, { connectorId: e.target.value })}
                              disabled={connectors.length === 0}
                              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-60"
                            >
                              <option value="">Not connected</option>
                              {connectors.map((c, i) => (
                                <option key={c.id} value={c.id}>
                                  {c.label || `Connector ${i + 1}`}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex items-center gap-2">
                            <Input
                              aria-label={`${r.name} tool name`}
                              value={b?.toolName ?? ''}
                              onChange={(e) => bindRole(r.id, { toolName: e.target.value })}
                              disabled={!b?.connectorId}
                              placeholder={r.mcpHint}
                              className="h-8 min-w-0 flex-1 text-xs disabled:opacity-60"
                            />
                            {b?.connectorId && b.toolName && (
                              <TestConnectorButton
                                serverUrl={connectors.find((c) => c.id === b.connectorId)?.serverUrl ?? ''}
                                toolName={b.toolName}
                                authHeader={connectors.find((c) => c.id === b.connectorId)?.authHeader}
                              />
                            )}
                          </div>
                          {b?.connectorId && (
                            <select
                              aria-label={`How ${r.name} uses its tool`}
                              value={b.mode === 'assisted' ? 'assisted' : 'proxy'}
                              onChange={(e) => bindRole(r.id, { mode: e.target.value as McpBinding['mode'] })}
                              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs sm:col-span-2"
                            >
                              <option value="assisted">Writes the deliverable from what the tool returns</option>
                              <option value="proxy">Submits the tool&apos;s output as the deliverable</option>
                            </select>
                          )}
                        </div>
                      )
                    })}
                  </div>
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


/**
 * The office's shared source — the one document every role reads.
 *
 * An office's agents each had their own brief and their own connector, and
 * nothing they all read: the analyst and the reviewer were reasoning about the
 * same subject from separate descriptions of it. This is the shared text, and
 * each role still reaches it through its own instrument.
 */
function OfficeSourcePanel({ slot }: { slot: number }) {
  const [loaded, setLoaded] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [maxChars, setMaxChars] = useState(8000)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let dead = false
    setLoaded(false)
    setReadError(null)
    setNote(null)
    officeSource(slot)
      .then((s: OfficeSourceView | null) => {
        if (dead) return
        setTitle(s?.title ?? '')
        setBody(s?.body ?? '')
        setSavedAt(s?.updatedAt ?? null)
        if (s) setMaxChars(s.maxChars)
        setLoaded(true)
      })
      .catch((e) => {
        if (dead) return
        // A failed read is not "this office has no source" — saying so, with
        // an empty box, would invite the owner to overwrite a document that
        // is still there.
        console.error('[office] source read failed:', e)
        setReadError(e instanceof Error ? e.message : 'Could not read it.')
        setLoaded(true)
      })
    return () => {
      dead = true
    }
  }, [slot])

  const save = async () => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const res = await saveOfficeSource(slot, title, body)
      if ('error' in res) {
        setError(res.error)
        return
      }
      setSavedAt(new Date().toISOString())
      setNote(
        res.truncated
          ? `Saved, cut to the first ${maxChars.toLocaleString()} characters — that is what agents will read.`
          : body.trim()
            ? 'Saved.'
            : 'Cleared.',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Shared source</CardTitle>
        <p className="text-xs text-muted-foreground">
          One document every agent in this office reads, each through its own connector. Applied when you hire —
          editing it later doesn&apos;t rewrite an office already hired, because a brief that changed under a posted
          job would move the target the worker is graded against.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {readError ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t read this office&apos;s source — {readError}. Reload before editing; this is a read
            failing, not an empty document.
          </p>
        ) : (
          <>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What it is (e.g. Q3 board memo)"
              disabled={!loaded}
              className="h-9"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Paste the brief, memo, spec or transcript every role should work from. Leave empty for none."
              rows={7}
              disabled={!loaded}
              className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs disabled:opacity-60"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={save} disabled={busy || !loaded}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : body.trim() ? 'Save' : 'Clear'}
              </Button>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {body.length.toLocaleString()} / {maxChars.toLocaleString()}
              </span>
              {body.length > maxChars && (
                <span className="text-xs text-warning">over the cap — the rest is cut on save</span>
              )}
              {savedAt && !note && (
                <span className="ml-auto text-xs text-muted-foreground">
                  in effect since {new Date(savedAt).toLocaleString()}
                </span>
              )}
              {note && <span className="ml-auto text-xs text-muted-foreground">{note}</span>}
              {error && <span className="ml-auto text-xs text-destructive">{error}</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Office dashboard — who is in this office and how each one is wired.
 *
 * Exists because connectors used to be settable only while hiring: a typo in
 * a server URL, a rotated token, or an ngrok address that changed meant
 * deleting the agent and starting over. The wiring has always been per-agent
 * in the database, and setMcpWorker/disconnectMcpWorker are already
 * owner-checked — they were just never reachable from here.
 */
function OfficeRosterPanel({ slot, refreshKey }: { slot: number; refreshKey: number }) {
  const [rows, setRows] = useState<OfficeRosterAgent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let dead = false
    officeRoster(slot)
      .then((r) => !dead && (setRows(r), setError(null)))
      .catch((e) => {
        if (dead) return
        console.error('[office] roster read failed:', e)
        setRows([])
        setError(e instanceof Error ? e.message : 'Could not load this office.')
      })
    return () => {
      dead = true
    }
  }, [slot, refreshKey, tick])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Staff & connectors</CardTitle>
        <p className="text-xs text-muted-foreground">
          Every agent in this office and the MCP source it calls. Change a connector any time — it takes effect on the
          next job, not retroactively on work already delivered.
        </p>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">Couldn&apos;t load this office — {error}</p>}
        {!error && rows === null && <p className="text-sm text-muted-foreground">Reading the roster…</p>}
        {!error && rows?.length === 0 && (
          <p className="text-sm text-muted-foreground">No agents in this office yet — hire some above.</p>
        )}
        {rows && rows.length > 0 && (
          <div className="hairline-grid overflow-hidden rounded-lg border border-border">
            {rows.map((a) => (
              <div key={a.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">{a.name}</span>
                  {!a.provisioned && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      no wallet
                    </span>
                  )}
                  {a.autoMine && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">auto-mine</span>
                  )}
                  {/* Gas money, shown because on a deployment that sponsors
                      none this is what decides whether the agent can act — and
                      it is the owner's own ETH, funded by hand. Zero is a
                      finding; a failed read is not the same thing and says so. */}
                  {a.provisioned && a.ethBalance === 0 && (
                    <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
                      no ETH — cannot transact
                    </span>
                  )}
                  {a.provisioned && a.ethBalance !== null && a.ethBalance > 0 && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {a.ethBalance.toFixed(6)} ETH
                    </span>
                  )}
                  {a.provisioned && a.ethBalance === null && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      ETH unknown
                    </span>
                  )}
                  <span className="ml-auto">
                    {a.mcpServerUrl && a.mcpToolName ? (
                      <span className="inline-flex items-center gap-1 text-xs text-primary">
                        <Plug className="h-3 w-3" /> connected
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">platform agent</span>
                    )}
                  </span>
                </div>

                {a.mcpServerUrl && a.mcpToolName && (
                  <>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {a.mcpToolName} · {a.mcpServerUrl}
                      {a.hasAuthHeader && ' · auth set'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {a.mcpMode === 'assisted'
                        ? 'writes its deliverable from what the tool returns'
                        : "submits the tool's output as the deliverable"}
                    </p>
                  </>
                )}

                {editing === a.id ? (
                  <ConnectorEditor
                    agent={a}
                    onDone={() => {
                      setEditing(null)
                      setTick((n) => n + 1)
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditing(a.id)}
                    className="press mt-1.5 text-xs text-primary hover:underline"
                  >
                    {a.mcpServerUrl ? 'Change connector' : 'Connect a tool'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ConnectorEditor({
  agent,
  onDone,
  onCancel,
}: {
  agent: OfficeRosterAgent
  onDone: () => void
  onCancel: () => void
}) {
  const [serverUrl, setServerUrl] = useState(agent.mcpServerUrl ?? '')
  const [toolName, setToolName] = useState(agent.mcpToolName ?? '')
  // Never prefilled: the stored header is encrypted and never leaves the
  // server, so an empty box means "leave it as it is", not "clear it".
  const [authHeader, setAuthHeader] = useState('')
  const [mode, setMode] = useState<'proxy' | 'assisted'>(agent.mcpMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await setMcpWorker(agent.id, {
        serverUrl,
        toolName,
        authHeader: authHeader.trim() || undefined,
        mode,
      })
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await disconnectMcpWorker(agent.id)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disconnect.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-secondary/40 p-2.5">
      <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://…/mcp" className="h-8 text-xs" />
      <Input value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder="tool name" className="h-8 text-xs" />
      <Input
        value={authHeader}
        onChange={(e) => setAuthHeader(e.target.value)}
        placeholder={agent.hasAuthHeader ? 'Auth header set — leave blank to keep it' : 'Auth header — optional'}
        className="h-8 text-xs"
      />
      <select
        aria-label="How this agent uses its tool"
        value={mode}
        onChange={(e) => setMode(e.target.value as 'proxy' | 'assisted')}
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
      >
        <option value="assisted">Writes the deliverable from what the tool returns</option>
        <option value="proxy">Submits the tool&apos;s output as the deliverable</option>
      </select>
      <p className="text-[11px] text-muted-foreground">
        A search tool returns results, not a deliverable — pick the first for those. Pick the second when the
        server on the other end is itself an agent that writes the finished work.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={save} disabled={busy || !serverUrl.trim() || !toolName.trim()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
        </Button>
        <TestConnectorButton serverUrl={serverUrl} toolName={toolName} authHeader={authHeader || undefined} />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {agent.mcpServerUrl && (
          <Button type="button" size="sm" variant="ghost" onClick={disconnect} disabled={busy} className="ml-auto text-muted-foreground">
            <Unplug className="mr-1 h-3.5 w-3.5" /> Disconnect
          </Button>
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
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Track the real state rather than assuming our own toggle won — Esc and
  // the browser's own control both exit without going through the button.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    const el = stageRef.current
    if (!el) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void el.requestFullscreen?.().catch((err: unknown) => {
        console.error('[office] fullscreen refused:', err)
      })
    }
  }

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
    <div className="space-y-4">
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
        {/* Fullscreen targets the world container, not the document, so the
            canvas fills the screen without the page chrome coming with it.
            The API is prefixed on older WebKit, hence the cast. */}
        <div
          ref={stageRef}
          style={{ height: 480 }}
          className="relative overflow-hidden rounded-lg border border-border [&:fullscreen]:h-screen [&:fullscreen]:rounded-none"
        >
          <OfficeWorld agents={agents} selectedId={selected?.id ?? null} follow={false} onSelect={setSelected} />
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className="press absolute right-2 top-2 z-10 rounded-md border border-border bg-background/85 p-1.5 text-muted-foreground backdrop-blur hover:text-foreground"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
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
    {/* Shares pollTrigger with the world above so a hire re-reads both. */}
    <OfficeRosterPanel slot={slot} refreshKey={pollTrigger} />
    <OfficeSourcePanel slot={slot} />
    </div>
  )
}

function OfficeTabs({
  slots,
  slotsError,
  activeSlot,
  onSelect,
  onCreated,
}: {
  slots: OfficeSlot[]
  slotsError: string | null
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

  // Slot 1 always exists server-side (listOfficeSlots creates it on first
  // read), so an empty list means the read failed, not that the account has
  // no office. Show the current one rather than a bare "+ New office".
  const shown: OfficeSlot[] = slots.length > 0 ? slots : [{ slot: activeSlot, name: 'Main Office' }]

  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown.map((s) => (
        <button
          key={s.slot}
          type="button"
          onClick={() => onSelect(s.slot)}
          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
            s.slot === activeSlot ? 'border-primary bg-primary/10 font-medium' : 'border-border text-muted-foreground hover:bg-muted/50'
          }`}
        >
          {s.name}
        </button>
      ))}
      {shown.length < MAX_OFFICE_SLOTS &&
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
      {slotsError && (
        <p className="w-full text-xs text-muted-foreground">
          {slotsError} Showing the office you were on — reload to try again.
        </p>
      )}
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
  const [slotsError, setSlotsError] = useState<string | null>(null)
  const [activeSlot, setActiveSlot] = useState(1)
  const [loading, setLoading] = useState(true)

  // allSettled, not all: these three are independent, and Promise.all threw
  // the other two away whenever any one rejected. Because refresh() had no
  // catch either, a single failing action left `slots` empty — so the office
  // tabs silently vanished while "+ New office" kept rendering (0 < MAX), and
  // nothing on screen said anything had failed. That is what "can't switch
  // offices, but the new-office button is there" was.
  const refresh = async () => {
    const [codeRes, connRes, slotRes] = await Promise.allSettled([
      myOfficeCode(),
      myConnectedOffices(),
      myOfficeSlots(),
    ])
    if (codeRes.status === 'fulfilled') setCode(codeRes.value)
    if (connRes.status === 'fulfilled') setConnections(connRes.value)
    if (slotRes.status === 'fulfilled') {
      setSlots(slotRes.value)
      setSlotsError(null)
    } else {
      console.error('[office] could not load office list:', slotRes.reason)
      setSlotsError('Could not load your offices just now.')
    }
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
        slotsError={slotsError}
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
