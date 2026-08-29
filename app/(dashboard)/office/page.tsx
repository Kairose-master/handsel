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
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Copy, RefreshCw, Loader2, UserPlus, Building2, Plus, X, Maximize2, Minimize2, Plug, Unplug, Coins, Fuel } from 'lucide-react'
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
  myOfficeTreasury,
  myCompanyTreasury,
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
  myOfficeAutomaton,
  setMyOfficeAutomaton,
  type OfficeAutomatonView,
} from '@/app/actions/office'
import { setMcpWorker, disconnectMcpWorker } from '@/app/actions/webhook'
import {
  myAgentSkills,
  installSkillOnAgent,
  uninstallSkillFromAgent,
  browseInstallableSkills,
  type AgentSkillView,
} from '@/app/actions/agent-skills'
import type { ClawhubSkill } from '@/lib/clawhub'
import { myAgentRepo, bindRepoToAgent, unbindRepoFromAgent, type AgentRepoView } from '@/app/actions/agent-repo'
import { myLineageReport } from '@/app/actions/agent-lineage'
import type { LineageReport } from '@/lib/agent-lineage'
import { getGithubConnection } from '@/app/actions/repo-jobs'
import type { GithubConnection } from '@/lib/github-identity'
import dynamic from 'next/dynamic'
import OfficeWorld from './game/OfficeWorld'
// R3F/Three.js diorama — code-split and client-only: three.js is a heavy
// bundle nobody should pay for until they actually opt into the 3D view
// (the toggle below defaults to the DOM renderer), and <Canvas> touches
// WebGL/window during its first mount, which next/dynamic's ssr:false
// keeps off the server render entirely rather than relying on Canvas's own
// SSR guard.
const OfficeWorld3D = dynamic(() => import('./game3d/OfficeWorld3D'), { ssr: false })
import { LiveOffice, type Agent } from './game/live-engine'
import type { Room } from './game/world'
import type { OfficeTreasuryView, CompanyTreasuryView, CompanyGasHealth, ArtifactFlight, AgentConversation } from '@/lib/office-world-data'
import { OFFICE_DEPARTMENTS } from '@/lib/office-world-data'
import { selectionSummary } from './game/select'
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

const LIFECYCLE_STYLE: Record<string, { label: string; cls: string }> = {
  replicate: { label: 'WOULD REPLICATE', cls: 'text-success' },
  retire: { label: 'WOULD RETIRE', cls: 'text-destructive' },
  hold: { label: 'hold', cls: 'text-muted-foreground' },
}

const LIFECYCLE_WHY: Record<string, string> = {
  thriving: 'graded record is strong and it holds enough to seed a child above its own reserve',
  healthy: 'working, but not good enough to copy or bad enough to drop',
  'insufficient-evidence': 'too few graded outcomes to judge — no verdict is the correct verdict here',
  'no-surplus': 'good enough to copy, but breeding would push it under its own reserve',
  outcompeted: 'most of its graded work failed',
  starved: 'past its grace period, under the bond floor, nothing coming in',
  unreadable: 'its balance could not be read — nothing is decided on an unreadable balance',
}

/**
 * Selection dry run — what the earn-or-die rules (lib/agent-lineage.ts)
 * WOULD do to this office's agents, run against real graded verdicts and
 * live balances. Nothing here acts: the panel exists so the rules can be
 * argued with while they are still arithmetic, which is the whole reason
 * the report shipped before the mandate.
 */
function LineageDryRunPanel({ slot }: { slot: number }) {
  const [report, setReport] = useState<LineageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setReport(await myLineageReport(slot))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run it.')
    } finally {
      setBusy(false)
    }
  }, [slot])

  useEffect(() => {
    setReport(null)
    setError(null)
  }, [slot])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Selection — dry run</CardTitle>
          <Button type="button" size="sm" variant="outline" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : report ? 'Re-run' : 'Run'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Earn-or-die, scored on independently graded work rather than attention — see{' '}
          <code className="text-[11px]">docs/agent-lineage.md</code>. This reports what the rules would do; it does
          nothing. No agent is created, funded, or retired by this panel.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!report && !error && (
          <p className="text-xs text-muted-foreground">
            Not run yet — it reads every wallet in this office on chain, so it runs on demand rather than on the poll.
          </p>
        )}
        {report && (
          <>
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs tabular-nums">
              <span className="text-success">{report.counts.replicate} would replicate</span>
              <span className="text-destructive">{report.counts.retire} would retire</span>
              <span className="text-muted-foreground">{report.counts.hold} hold</span>
              <span className="text-muted-foreground">· {report.windowDays}d window</span>
              {report.balanceReadErrors > 0 && (
                <span className="text-warning">· {report.balanceReadErrors} balance(s) unreadable</span>
              )}
            </div>
            {report.rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No agents in this office.</p>
            ) : (
              <ul className="space-y-1">
                {report.rows.map((r) => {
                  const style = LIFECYCLE_STYLE[r.decision.action] ?? LIFECYCLE_STYLE.hold
                  return (
                    <li key={r.agentId} className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      <span className={style.cls}>{style.label}</span> · {r.name} · gen {r.generation} · graded{' '}
                      {r.graded.passed}/{r.graded.total}
                      {r.graded.passRate !== null && ` (${Math.round(r.graded.passRate * 100)}%)`} · earned $
                      {r.earnedUsd.toFixed(2)} · holds {r.heldUsd === null ? 'unreadable' : `$${r.heldUsd.toFixed(2)}`}
                      <span className="block pl-4 opacity-70">{LIFECYCLE_WHY[r.decision.why] ?? r.decision.why}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The Automaton panel — this office's standing operator mandate
 * (lib/office-automaton.ts). The toggle grants or revokes real spending
 * authority (bounded: bond-floor top-ups between the owner's own wallets,
 * daily budget, per-transfer cap), so the panel leads with what it has
 * actually DONE — the audit log — not with what it could do. Every number
 * is a live query; an empty log is a true "nothing yet".
 */
function OfficeAutomatonPanel({ slot }: { slot: number }) {
  const [view, setView] = useState<OfficeAutomatonView | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let dead = false
    setView(null)
    setReadError(null)
    myOfficeAutomaton(slot)
      .then((v) => {
        if (!dead) setView(v)
      })
      .catch((e) => {
        if (!dead) setReadError(e instanceof Error ? e.message : 'Could not read it.')
      })
    return () => {
      dead = true
    }
  }, [slot])

  const toggle = async () => {
    if (!view) return
    setBusy(true)
    try {
      await setMyOfficeAutomaton(slot, !view.enabled)
      setView(await myOfficeAutomaton(slot))
    } catch (e) {
      setReadError(e instanceof Error ? e.message : 'Could not change it.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Automaton</CardTitle>
          {view && (
            <Button type="button" size="sm" variant={view.enabled ? 'destructive' : 'default'} onClick={toggle} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : view.enabled ? 'Revoke mandate' : 'Grant mandate'}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          A standing mandate to keep this desk claim-ready: any worker here holding under $
          {view ? view.floorUsd.toFixed(2) : '…'} of bond float is topped up from your own richest agent — only ever
          between your own wallets, at most ${view ? view.budgetUsd.toFixed(2) : '…'} a day, every move logged below.
          Runs on the same background cycle that settles jobs.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {readError ? (
          <p className="text-sm text-destructive">Couldn&apos;t read the mandate — {readError}</p>
        ) : !view ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs tabular-nums">
              <span className={view.enabled ? 'text-success' : 'text-muted-foreground'}>
                ● {view.enabled ? 'ACTIVE' : 'OFF'}
              </span>
              <span className="text-muted-foreground">
                moved 24h: ${view.spentUsd.toFixed(2)} / ${view.budgetUsd.toFixed(2)}
              </span>
            </div>
            {view.actions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No actions yet.</p>
            ) : (
              <ul className="space-y-1">
                {view.actions.map((a) => (
                  <li key={a.id} className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {new Date(a.at).toLocaleString()} · {a.kind} ${a.amountUsd.toFixed(2)} → {a.agentName}
                    {a.txHash ? (
                      <span className="text-success"> ✓ {a.txHash.slice(0, 10)}…</span>
                    ) : a.note?.startsWith('FAILED') ? (
                      <span className="text-destructive"> ✗ failed</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
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
                <AgentSkillsSection agentId={a.id} />
                <AgentRepoSection agentId={a.id} />
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

/**
 * Installed skills for one agent — a real install, not a badge: the skill's
 * full ClawHub document is snapshotted server-side and joins this agent's
 * every job brief from the next dispatch on (lib/agent-skills.ts has the
 * whole trust model). Self-contained per roster row: loads only when
 * expanded, since most visits never open it.
 */
function AgentSkillsSection({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false)
  const [skills, setSkills] = useState<AgentSkillView[] | null>(null)
  const [max, setMax] = useState(5)
  const [candidates, setCandidates] = useState<ClawhubSkill[] | null>(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = () => {
    myAgentSkills(agentId)
      .then(({ skills, max }) => {
        setSkills(skills)
        setMax(max)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load skills.'))
  }

  useEffect(() => {
    if (!open) return
    reload()
    if (!candidates) {
      browseInstallableSkills()
        .then(setCandidates)
        .catch((e) => {
          // The install picker degrades; the installed list still works.
          console.error('[office] clawhub browse failed:', e)
          setCandidates([])
        })
    }
    // reload/candidates deliberately not deps: this effect means "on expand".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentId])

  const install = async () => {
    if (!pick) return
    setBusy(true)
    setError(null)
    try {
      await installSkillOnAgent(agentId, pick)
      setPick('')
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Install failed.')
    } finally {
      setBusy(false)
    }
  }

  const uninstall = async (slug: string) => {
    setBusy(true)
    setError(null)
    try {
      await uninstallSkillFromAgent(agentId, slug)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Uninstall failed.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="press mt-1 block text-xs text-primary hover:underline">
        🏋️ Skills
      </button>
    )
  }

  const installedSlugs = new Set((skills ?? []).map((s) => s.slug))
  const pickable = (candidates ?? []).filter((c) => !installedSlugs.has(c.slug))

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-secondary/40 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">
          Installed skills{skills ? ` — ${skills.length}/${max}` : ''}
        </span>
        <button type="button" onClick={() => setOpen(false)} className="press text-xs text-muted-foreground hover:underline">
          Hide
        </button>
      </div>
      {skills === null && !error && <p className="text-[11px] text-muted-foreground">Reading…</p>}
      {skills?.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          None yet. An installed skill&apos;s full ClawHub document joins this agent&apos;s every job brief — it changes what
          the agent is actually told to do, from the next job on.
        </p>
      )}
      {skills?.map((s) => (
        <div key={s.slug} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <a href={s.url} target="_blank" rel="noreferrer" className="text-xs font-medium hover:underline">
              {s.name}
            </a>
            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
              {s.slug}
              {s.version ? `@${s.version}` : ''}
            </span>
            {s.truncated && (
              <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">doc truncated</span>
            )}
            {s.summary && <p className="truncate text-[11px] text-muted-foreground">{s.summary}</p>}
            {s.eval && <p className="font-mono text-[10px] tabular-nums text-muted-foreground">{skillEvalLine(s.eval)}</p>}
          </div>
          <button
            type="button"
            onClick={() => uninstall(s.slug)}
            disabled={busy}
            className="press text-xs text-muted-foreground hover:text-destructive"
            aria-label={`Uninstall ${s.name}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <select
          aria-label="Skill to install"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="">
            {candidates === null ? 'Loading ClawHub…' : pickable.length === 0 ? 'No installable skills found' : 'Pick a ClawHub skill…'}
          </option>
          {pickable.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
              {c.version ? ` (${c.version})` : ''}
            </option>
          ))}
        </select>
        <Button type="button" size="sm" onClick={install} disabled={busy || !pick || (skills !== null && skills.length >= max)}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Install'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Installing snapshots the skill&apos;s document as it is today — a later ClawHub edit never changes this agent
        until you reinstall. Skills apply on every runtime except MCP-wired agents, whose external tool follows no
        instructions. Graded numbers compare independently graded outcomes before vs. after the install —
        correlation across time, not causation, and skills installed close together share an after-window.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** One compact line for a skill's before/after graded record — counts are
 *  always shown; the delta only when both windows clear the sample gate
 *  (lib/skill-eval.ts, whose header carries the caveats the panel repeats). */
function skillEvalLine(e: NonNullable<AgentSkillView['eval']>): string {
  const w = (s: { passed: number; total: number }) => `${s.passed}/${s.total}`
  const base = `graded ${w(e.before)} before · ${w(e.after)} after`
  if (e.verdict === 'measured' && e.deltaPoints !== null) {
    const sign = e.deltaPoints > 0 ? '+' : ''
    return `${base} · Δ${sign}${e.deltaPoints.toFixed(1)}pt`
  }
  return `${base} — need ≥${e.minPerWindow} each side for a comparison`
}

/**
 * The agent's portfolio repo — its own GitHub repository, where every PAID
 * job's deliverable lands as a commit with provenance (lib/agent-repo.ts
 * has the trust model and why WE never create the repo: the owner creates
 * it and installs the same App the repo-jobs pipeline uses, then binds it
 * here). Self-contained per roster row, loads only when expanded.
 */
function AgentRepoSection({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<AgentRepoView | null | 'loading'>('loading')
  const [conn, setConn] = useState<GithubConnection | null>(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = () => {
    myAgentRepo(agentId)
      .then((v) => {
        setView(v)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'))
  }

  useEffect(() => {
    if (!open) return
    reload()
    if (!conn) {
      getGithubConnection()
        .then(setConn)
        .catch((e) => console.error('[office] github connection read failed:', e))
    }
    // reload/conn deliberately not deps: this effect means "on expand".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentId])

  const bind = async () => {
    if (!pick) return
    setBusy(true)
    setError(null)
    try {
      setView(await bindRepoToAgent(agentId, pick))
      setPick('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bind failed.')
    } finally {
      setBusy(false)
    }
  }

  const unbind = async () => {
    setBusy(true)
    setError(null)
    try {
      await unbindRepoFromAgent(agentId)
      setView(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbind failed.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="press mt-1 block text-xs text-primary hover:underline">
        📓 Portfolio repo
      </button>
    )
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-secondary/40 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Portfolio repo</span>
        <button type="button" onClick={() => setOpen(false)} className="press text-xs text-muted-foreground hover:underline">
          Hide
        </button>
      </div>

      {view === 'loading' && !error && <p className="text-[11px] text-muted-foreground">Reading…</p>}

      {view !== 'loading' && view !== null && (
        <>
          <p className="text-xs">
            <a href={view.repoUrl} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">
              {view.repoFullName}
            </a>
            <span className="ml-2 text-[11px] text-muted-foreground">
              {view.commits.length === 0
                ? 'no deliverables mirrored yet — the next PAID job commits here'
                : `${view.commits.length} deliverable${view.commits.length === 1 ? '' : 's'} mirrored`}
            </span>
          </p>
          {view.commits.slice(0, 5).map((c) => (
            <p key={c.jobId} className="truncate text-[11px] text-muted-foreground">
              <a href={c.fileUrl} target="_blank" rel="noreferrer" className="hover:underline">
                job #{c.jobId} — {c.path.replace(/^deliverables\//, '')}
              </a>
            </p>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={unbind} disabled={busy} className="text-muted-foreground">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Unbind'}
          </Button>
        </>
      )}

      {view === null && (
        <>
          <p className="text-[11px] text-muted-foreground">
            Give this agent its own GitHub repo: every job it gets <em>paid</em> for is committed there with provenance
            (job id, spec hash, settlement tx, proof link) — a portable track record that outlives this platform.
          </p>
          {conn && !conn.connected && (
            <p className="text-[11px] text-muted-foreground">
              Connect GitHub first (Settings), then create a repo and{' '}
              <a href={conn.installUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                install the App
              </a>{' '}
              on it.
            </p>
          )}
          <div className="flex gap-2">
            <select
              aria-label="Repository to bind"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="">
                {conn === null
                  ? 'Loading your repos…'
                  : conn.repos.length === 0
                    ? 'No repos with our App installed'
                    : 'Pick a repo you own…'}
              </option>
              {(conn?.repos ?? []).map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                  {r.private ? ' (private)' : ''}
                </option>
              ))}
            </select>
            <Button type="button" size="sm" onClick={bind} disabled={busy || !pick}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Bind'}
            </Button>
          </div>
          {conn?.connected && (
            <p className="text-[11px] text-muted-foreground">
              Don&apos;t see the repo? Create it on GitHub, then{' '}
              <a href={conn.installUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                add it to the App installation
              </a>
              . We can&apos;t create repos for you — the App&apos;s permissions are deliberately too narrow for that.
            </p>
          )}
        </>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

const fmtUsd = (n: number | null) => (n == null ? 'unknown' : `$${n.toFixed(2)}`)
// Display only — matches lib/onchain/treasury.ts's own ethBalanceOf comment:
// never round-trip a balance through a float to compute a transfer amount.
// This never does; it only ever prints one.
const fmtEth = (weiStr: string | null) => (weiStr == null ? 'unknown' : `${(Number(BigInt(weiStr)) / 1e18).toFixed(4)} ETH`)

// Mirrors lib/local-paymaster.ts's LOCAL_GAS_TARGET_WEI (0.0002 ETH) — the
// full-tank size the HUD's gas gauge is drawn against. Not imported: that
// file touches @/lib/db and cannot be bundled into this 'use client' page.
// If the real constant ever moves, this display-only copy goes stale in the
// direction of a wrong bar fill, never a wrong number — the numbers
// themselves all come from the server action's real balances.
const GAS_TANK_WEI = 200_000_000_000_000n

/** The Treasury room's detail panel — the one room in the diorama with real
 *  money numbers to show, in two scopes that are never allowed to blend:
 *  this office's own agent wallets, and the market contract's own solvency.
 *  See lib/office-treasury.ts's header for why the split is load-bearing. */
function TreasuryPanel({
  room,
  occupants,
  view,
  loading,
  error,
  onRefresh,
}: {
  room: Room
  occupants: number
  view: OfficeTreasuryView | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/50 p-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="font-semibold">
          {room.icon} {room.name}
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onRefresh} disabled={loading} className="h-7 px-2 text-xs">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <div className="text-muted-foreground">{occupants} here right now — an agent with an open credit draw.</div>
      {error && <p className="mt-2 text-xs text-destructive">Could not read the chain just now: {error}</p>}
      {view && (
        <div className="mt-2 space-y-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">This office</div>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Agents / wallets</dt>
              <dd className="text-right tabular-nums">
                {view.office.agentCount} / {view.office.walletCount}
              </dd>
              <dt className="text-muted-foreground">USDC held</dt>
              <dd className="text-right tabular-nums">{fmtUsd(view.office.usdcTotal)}</dd>
              <dt className="text-muted-foreground">ETH held (gas)</dt>
              <dd className="text-right tabular-nums">{fmtEth(view.office.ethTotalWei)}</dd>
            </dl>
            {view.office.walletReadErrors > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {view.office.walletReadErrors} wallet read{view.office.walletReadErrors === 1 ? '' : 's'} failed this pass — totals above are a
                floor, not the full picture.
              </p>
            )}
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              The whole market — not just this office
            </div>
            {view.market.solvency ? (
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">Owed across open jobs</dt>
                <dd className="text-right tabular-nums">{fmtUsd(view.market.solvency.owedUsd)}</dd>
                <dt className="text-muted-foreground">Held in the contract</dt>
                <dd className="text-right tabular-nums">{fmtUsd(view.market.solvency.heldUsd)}</dd>
                <dt className="text-muted-foreground">Surplus (accrued fees)</dt>
                <dd className="text-right tabular-nums">{fmtUsd(view.market.solvency.surplusUsd)}</dd>
              </dl>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Could not read the market contract.</p>
            )}
            {view.market.fee && (
              <p className="mt-1 text-xs text-muted-foreground">
                Protocol fee {(view.market.fee.feeBps / 100).toFixed(2)}% + {fmtUsd(view.market.fee.flatFeeUsd)} flat · unwithdrawn balance{' '}
                {fmtUsd(view.market.fee.balanceUsd)}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Room id -> display label for the two rooms that aren't in the generated
// nine (the owner's room and the idle bullpen) — everything else comes
// straight from the real department list so a tenth room added there shows
// up here for free.
const DEPT_LABEL: Record<string, { name: string; icon: string }> = {
  lounge: { name: 'Idle', icon: '🛋️' },
  ceo: { name: "Owner's room", icon: '👑' },
}
for (const dept of OFFICE_DEPARTMENTS) DEPT_LABEL[dept.id] = { name: dept.name, icon: dept.icon }

/**
 * The RTS box-select summary — inspect only (select.ts's own header explains
 * why: no aggregate here ever authorizes an action). Shows what a dragged
 * box actually caught: how many agents, and which real departments they're
 * currently in.
 */
function MultiSelectPanel({ agents, onClear }: { agents: Agent[]; onClear: () => void }) {
  const summary = selectionSummary(agents)
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/50 p-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="font-semibold">
          🔲 {summary.count} agent{summary.count === 1 ? '' : 's'} selected
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onClear} className="h-7 px-2 text-xs">
          Clear
        </Button>
      </div>
      <ul className="mt-2 space-y-1">
        {[...summary.byDept.entries()].map(([deptId, count]) => {
          const label = DEPT_LABEL[deptId] ?? { name: deptId, icon: '•' }
          return (
            <li key={deptId} className="flex items-center justify-between text-muted-foreground">
              <span>
                {label.icon} {label.name}
              </span>
              <span className="tabular-nums">{count}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function OfficeWorldPanel({ slot }: { slot: number }) {
  const engineRef = useRef(new LiveOffice())
  const [agents, setAgents] = useState<Agent[]>([])
  const [selected, setSelected] = useState<Agent | null>(null)
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null)
  // RTS box multi-select — independent of the single agent/room selection
  // above, not a replacement for it: this is an inspect-only group summary
  // (select.ts's own header explains why it stops there), so it coexists
  // rather than fighting the existing detail panel for the same state.
  const [multiSelected, setMultiSelected] = useState<Agent[]>([])
  // Real deliverables currently traveling between two known rooms — see
  // lib/office-artifact-flights.ts's header. Comes straight off the
  // snapshot each poll rather than through LiveOffice/tweening: a flight is
  // a fact about the current subtask graph, not a position to interpolate.
  const [flights, setFlights] = useState<ArtifactFlight[]>([])
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  // Real signal for the 3D HUD's "OPERATIONAL"/"LINK DEGRADED" status dot —
  // never a static badge, since that would be exactly the kind of
  // decoration-pretending-to-be-telemetry this project's "no fake data"
  // rule exists to rule out.
  const [pollHealthy, setPollHealthy] = useState(true)
  const [treasury, setTreasury] = useState<OfficeTreasuryView | null>(null)
  const [treasuryLoading, setTreasuryLoading] = useState(false)
  const [treasuryError, setTreasuryError] = useState<string | null>(null)
  const [ceoLine, setCeoLine] = useState('')
  const [hiring, setHiring] = useState(false)
  const [hiringTemplate, setHiringTemplate] = useState(false)
  const [pollTrigger, setPollTrigger] = useState(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // R3F diorama is opt-in, not a replacement — it shares the exact same
  // props/callbacks as the DOM renderer (both take agents/selection/
  // flights and report the same picks back), so this toggle is the only
  // thing that changes between them. Defaults to the DOM renderer, which
  // has years of production traffic behind it; the 3D view is new and
  // this sandbox has no real account data to test it against end-to-end,
  // so real users are its first real-data test, by choice, not omission.
  const [use3D, setUse3D] = useState(false)

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
    setSelectedRoom(null)
    setMultiSelected([])
    setFlights([])
    setConversations([])
    setPollHealthy(true)
    setTreasury(null)
    setTreasuryError(null)
    const poll = async () => {
      try {
        const snap = await myOfficeWorld(slot)
        if (dead) return
        engineRef.current.applySnapshot(snap)
        setAgents([...engineRef.current.agents])
        setCeoLine(snap.ceoLine)
        setFlights(snap.artifactFlights)
        setConversations(snap.conversations)
        setPollHealthy(true)
      } catch (error) {
        console.error('[office] snapshot poll failed:', error)
        if (!dead) setPollHealthy(false)
      }
    }
    poll()
    const interval = setInterval(poll, POLL_MS)
    return () => {
      dead = true
      clearInterval(interval)
    }
  }, [slot, pollTrigger])

  // Treasury is the one room with real numbers to fetch — on-chain reads
  // across every agent wallet plus the market contract, too heavy to poll
  // continuously alongside the roster snapshot. Loaded directly from the
  // click handler (not a useEffect keyed on the selected room) because
  // `ROOMS` is a module-level constant: clicking the same room twice passes
  // the identical object reference, and a useEffect keyed on that reference
  // would never re-fire on a second click — "click again to refresh" needs
  // the fetch to run on every click, not on every reference CHANGE.
  const loadTreasury = async () => {
    setTreasuryLoading(true)
    setTreasuryError(null)
    try {
      setTreasury(await myOfficeTreasury(slot))
    } catch (error) {
      console.error('[office] treasury read failed:', error)
      setTreasuryError(error instanceof Error ? error.message : String(error))
    } finally {
      setTreasuryLoading(false)
    }
  }

  // One detail panel, one selection at a time: picking an agent, a room, or
  // a box-selected group clears whichever of the other two was showing, so
  // the panel below never has to decide which of several conflicting things
  // to show.
  const handleSelectAgent = (agent: Agent) => {
    setSelectedRoom(null)
    setMultiSelected([])
    setSelected(agent)
  }
  const handleSelectRoom = (room: Room) => {
    setSelected(null)
    setMultiSelected([])
    setSelectedRoom(room)
    if (room.id === 'treasury') void loadTreasury()
  }
  const handleSelectMany = (ids: string[]) => {
    if (ids.length === 0) return // an empty drag selected nothing — leave whatever was showing alone
    setSelected(null)
    setSelectedRoom(null)
    const idSet = new Set(ids)
    setMultiSelected(agents.filter((a) => idSet.has(a.id)))
  }

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
          <Button size="sm" variant="outline" onClick={() => setUse3D((v) => !v)}>
            {use3D ? '🖼️ Classic view' : '🧊 3D view'}
          </Button>
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
          {use3D ? (
            <OfficeWorld3D
              agents={agents}
              selectedId={selected?.id ?? null}
              selectedRoomId={selectedRoom?.id ?? null}
              onSelect={handleSelectAgent}
              onSelectRoom={handleSelectRoom}
              onSelectMany={handleSelectMany}
              flights={flights}
              conversations={conversations}
              healthy={pollHealthy}
            />
          ) : (
            <OfficeWorld
              agents={agents}
              selectedId={selected?.id ?? null}
              selectedRoomId={selectedRoom?.id ?? null}
              onSelect={handleSelectAgent}
              onSelectRoom={handleSelectRoom}
              onSelectMany={handleSelectMany}
              flights={flights}
            />
          )}
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
        {selectedRoom && selectedRoom.id !== 'treasury' && (
          <div className="mt-3 rounded-md border border-border bg-muted/50 p-3 text-sm">
            <div className="font-semibold">
              {selectedRoom.icon} {selectedRoom.name}
            </div>
            <div className="text-muted-foreground">
              {agents.filter((a) => a.deptId === selectedRoom.id).length} here right now.
            </div>
          </div>
        )}
        {selectedRoom?.id === 'treasury' && (
          <TreasuryPanel
            room={selectedRoom}
            occupants={agents.filter((a) => a.deptId === 'treasury').length}
            view={treasury}
            loading={treasuryLoading}
            error={treasuryError}
            onRefresh={loadTreasury}
          />
        )}
        {multiSelected.length > 0 && <MultiSelectPanel agents={multiSelected} onClear={() => setMultiSelected([])} />}
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
    <OfficeAutomatonPanel slot={slot} />
    <LineageDryRunPanel slot={slot} />
    </div>
  )
}

const GAS_HEALTH_STYLE: Record<CompanyGasHealth, { label: string; dot: string; text: string }> = {
  ok: { label: 'Fueled', dot: 'bg-success', text: 'text-success' },
  low: { label: 'Running low', dot: 'bg-warning', text: 'text-warning' },
  empty: { label: 'Empty', dot: 'bg-destructive', text: 'text-destructive' },
  unknown: { label: 'Unknown', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  disabled: { label: 'Disabled', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  unconfigured: { label: 'Not set up', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
}

/**
 * Company HQ — the account-wide HUD strip above the per-office diorama.
 * Not office-scoped (see lib/company-treasury.ts's header for why): every
 * office's agents combined, plus the account's own local-paymaster gas pool,
 * which is one per account by design, never one per office.
 *
 * A tycoon-sim top bar, not a card: three live stat chips (agents, USDC,
 * gas), each a real number or an honest "unknown" — never a placeholder
 * dash pretending to be data.
 */
function CompanyHqBar() {
  const [view, setView] = useState<CompanyTreasuryView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setView(await myCompanyTreasury())
    } catch (e) {
      console.error('[office] company treasury read failed:', e)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let dead = false
    const poll = async () => {
      if (dead) return
      await load()
    }
    poll()
    // Slower than the roster poll on purpose — this reads every agent's
    // on-chain balance plus the gas pool source, heavier than a status
    // snapshot, and a HUD strip does not need second-by-second freshness.
    const interval = setInterval(poll, 60_000)
    return () => {
      dead = true
      clearInterval(interval)
    }
  }, [])

  const gas = view?.gasPool
  const gasStyle = GAS_HEALTH_STYLE[view?.gasHealth ?? 'unknown']
  const spendablePct =
    gas?.configured && gas.spendableWei != null
      ? Math.min(100, Math.round((Number(BigInt(gas.spendableWei)) / Number(GAS_TANK_WEI)) * 100))
      : null

  return (
    <div className="flex flex-wrap items-stretch gap-3 rounded-xl border border-border bg-gradient-to-r from-muted/60 to-muted/20 p-3">
      <div className="flex min-w-[110px] flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
        <Building2 className="h-5 w-5 text-muted-foreground" />
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Company</div>
          <div className="text-lg font-bold tabular-nums leading-none">{view ? view.agentCount : '—'} agents</div>
        </div>
      </div>

      <div className="flex min-w-[110px] flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
        <Coins className="h-5 w-5 text-warning" />
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">USDC · every office</div>
          <div className="text-lg font-bold tabular-nums leading-none">{fmtUsd(view?.usdc.usdcTotal ?? null)}</div>
          {view && view.usdc.walletReadErrors > 0 && <div className="mt-0.5 text-[10px] text-muted-foreground">floor — some wallets unreadable</div>}
        </div>
      </div>

      <div className="flex min-w-[160px] flex-[1.4] items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
        <Fuel className={`h-5 w-5 ${gasStyle.text}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Gas pool</div>
            <span className={`flex items-center gap-1 text-[10px] font-medium ${gasStyle.text}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${gasStyle.dot}`} />
              {gasStyle.label}
            </span>
          </div>
          {gas?.configured ? (
            <>
              <div className="text-sm font-semibold tabular-nums leading-tight">{fmtEth(gas.spendableWei)} spendable</div>
              {spendablePct != null && (
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full ${gasStyle.dot}`} style={{ width: `${spendablePct}%` }} />
                </div>
              )}
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground">from {gas.sourceAgentName}</div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">{gas?.configured === false ? 'No source agent set' : 'unknown'}</div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={load}
        disabled={loading}
        aria-label="Refresh company numbers"
        className="flex items-center justify-center rounded-lg border border-border bg-background px-2 text-muted-foreground hover:text-foreground"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      </button>
      {error && <p className="w-full text-xs text-destructive">Could not read the chain just now: {error}</p>}
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

      <CompanyHqBar />

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
